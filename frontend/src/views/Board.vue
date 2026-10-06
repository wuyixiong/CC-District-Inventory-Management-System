<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Refresh, EditPen, Search, Download, Camera } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { inDingtalk, scanCode } from '../utils/scan'
import { dingtalkLogin, type DtIdentity } from '../utils/auth'
import type { BatchView, LocationItem, LocationView, StateResp } from '../types'

const resp = ref<StateResp | null>(null)
const locs = ref<LocationItem[]>([])
const loading = ref(false)
const searchQuery = ref('')
const activeStatusFilter = ref<'all' | 'ok' | 'yellow' | 'red'>('all')
const detailLoc = ref<LocationView | null>(null)
const detailVisible = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const board = computed(() => resp.value?.board ?? null)

interface ZoneGroup {
  zone: string
  locs: LocationView[]
}

const zoneGroups = computed<ZoneGroup[]>(() => {
  const b = board.value
  if (!b) return []
  const q = searchQuery.value.trim().toLowerCase()
  const groups = new Map<string, LocationView[]>()
  for (const loc of b.locations) {
    if (activeStatusFilter.value !== 'all' && !loc.items.some((i) => i.state === activeStatusFilter.value)) continue
    if (q) {
      const hit =
        loc.code.toLowerCase().includes(q) ||
        loc.zone.toLowerCase().includes(q) ||
        loc.items.some((i) => i.product.toLowerCase().includes(q) || i.batch.toLowerCase().includes(q))
      if (!hit) continue
    }
    const zone = loc.registered ? loc.zone || '未分区' : '未登记'
    if (!groups.has(zone)) groups.set(zone, [])
    groups.get(zone)!.push(loc)
  }
  return [...groups.entries()].map(([zone, locs]) => ({ zone, locs })).sort((a, b2) => a.zone.localeCompare(b2.zone))
})

const statCounts = computed(() => {
  const b = board.value
  if (!b) return { batches: 0, ok: 0, yellow: 0, red: 0 }
  const red = b.overageList.filter((i) => i.state === 'red').length
  const yellow = b.totals.overage - red
  return { batches: b.totals.batches, ok: b.totals.batches - b.totals.overage, yellow, red }
})

async function load() {
  loading.value = true
  try {
    resp.value = await api<StateResp>('/api/state')
  } catch (e) {
    console.error(e)
    ElMessage.error(`看板数据加载失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

// 「同步最新数据」：钉钉是主数据源，先拉钉钉最新（已配置时），再刷新看板；仅刷本地镜像不会带来新数据
const syncing = ref(false)
async function syncNow() {
  syncing.value = true
  try {
    const st = await api<{ configured: boolean }>('/api/dingtalk/status')
    if (st.configured) {
      const r = await api<{ report: { total: number; added: number; skippedRows: unknown[] } }>('/api/dingtalk/sync', { method: 'POST' })
      ElMessage.success(
        `已同步钉钉「出入库流水表」${r.report.total} 行，新入账 ${r.report.added} 笔${r.report.skippedRows.length ? `，跳过 ${r.report.skippedRows.length} 行` : ''}`,
      )
    }
  } catch (e) {
    ElMessage.error(`钉钉同步失败：${(e as Error).message}`)
  } finally {
    syncing.value = false
  }
  await load()
  // 通知顶栏立即刷新「数据同步于 …」时间
  window.dispatchEvent(new CustomEvent('zz:synced'))
}

async function loadLocs() {
  try {
    locs.value = (await api<{ locations: LocationItem[] }>('/api/locations')).locations
  } catch (e) {
    console.error(e)
  }
}

onMounted(() => {
  load()
  loadLocs()
  initRecorderIdentity()
  timer = setInterval(load, 30_000)
  // 钉钉工作台直达入口：链接带 #record 直接打开「记一笔」（如 http://内网IP:8792/#record）
  if (location.hash.includes('record')) setTimeout(() => openQuick(), 400)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function openDetail(loc: LocationView) {
  detailLoc.value = loc
  detailVisible.value = true
}

function miniCells(loc: LocationView): BatchView[] {
  return loc.items.slice(0, 20)
}
function overflowCount(loc: LocationView): number {
  return Math.max(0, loc.items.length - 20)
}
function dotColor(state: string) {
  return state === 'red' ? 'var(--location-status-red)' : state === 'yellow' ? 'var(--location-status-yellow)' : 'var(--location-status-green)'
}

/* ===== 产品查询（仿白区排产库存速查） ===== */
const queryVisible = ref(false)
const queryKeyword = ref('')

const stockProducts = computed(() => {
  const set = new Set<string>()
  for (const l of board.value?.locations ?? []) for (const i of l.items) set.add(i.product)
  return [...set]
})

const queryRows = computed(() => {
  const q = queryKeyword.value.trim().toLowerCase()
  if (!q) return []
  const rows: (BatchView & { zone: string })[] = []
  for (const l of board.value?.locations ?? []) {
    for (const i of l.items) {
      if (i.product.toLowerCase().includes(q)) rows.push({ ...i, zone: l.zone || '' })
    }
  }
  return rows.sort((a, b) => b.days - a.days)
})
const queryTotal = computed(() => queryRows.value.reduce((s, r) => s + r.qty, 0))
const queryLocCount = computed(() => new Set(queryRows.value.map((r) => r.location)).size)

function queryProducts(qs: string, cb: (items: { value: string }[]) => void) {
  const q = qs.trim().toLowerCase()
  const all = [...stockProducts.value, ...dtProducts.value.filter((p) => !stockProducts.value.includes(p))]
  cb(
    all
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 15)
      .map((value) => ({ value })),
  )
}

/* ===== 导出库存清单（Excel，按停放时间降序） ===== */
function exportInventory() {
  const a = document.createElement('a')
  a.href = '/api/export'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/* ===== 扫码（手机钉钉内，调起原生扫码） ===== */

async function tryScan(): Promise<string> {
  try {
    return await scanCode()
  } catch (e) {
    ElMessage.warning((e as Error).message)
    return ''
  }
}

// 主扫码：内容命中库位号 → 弹库位明细；否则视为产品图号 → 打开产品查询
async function scanAndRoute() {
  const text = await tryScan()
  if (!text) return
  const code = text.toUpperCase()
  const hit = board.value?.locations.find((l) => l.code === code)
  if (hit) return openDetail(hit)
  const reg = locs.value.find((l) => l.code === code)
  if (reg) {
    return openDetail({
      code: reg.code, zone: reg.zone, note: reg.note,
      registered: true, enabled: reg.enabled, batches: 0, qty: 0, maxDays: 0, state: 'empty', items: [],
    })
  }
  queryKeyword.value = text
  loadDtOptions()
  queryVisible.value = true
}

// 产品查询弹窗：扫码即输入图号
async function scanToQuery() {
  const text = await tryScan()
  if (text) queryKeyword.value = text
}

// 记一笔表单：扫码填库位 / 目标库位 / 产品图号（填完与手工选择完全等价）
async function scanFill(field: 'location' | 'target' | 'product') {
  const text = await tryScan()
  if (!text) return
  if (field === 'location' || field === 'target') {
    const code = text.toUpperCase()
    const pool = field === 'location' ? (quick.kind === 'in' ? enabledLocations.value : occupiedLocations.value) : targetOptions.value
    if (!pool.some((l) => l.code === code)) return ElMessage.warning(`「${code}」不是可选库位（未登记/已停用/无货），请确认条码内容`)
    if (field === 'location') quick.location = code
    else quick.targetLocation = code
    return
  }
  if (quick.kind === 'in') {
    quick.product = text
    return
  }
  if (!quick.location) return ElMessage.warning('请先选库位（或扫库位码），再扫产品码')
  const lower = text.toLowerCase()
  const hit = productOptions.value.find((p) => p.toLowerCase() === lower) ?? productOptions.value.find((p) => p.toLowerCase().includes(lower))
  if (!hit) return ElMessage.warning(`库位 ${quick.location} 没有「${text}」的在库记录`)
  quick.product = hit
  quick.batch = ''
  quick.qty = 1
  // 默认选中该图号停放最久的一批（先进先出，与手工选择一致）
  const first = batchOptions.value.find((b) => b.product === hit)
  if (first) quick.batch = first.batch
}

/* ===== 记一笔（仿白区库存「记一笔」） ===== */

const quickVisible = ref(false)
const quickSubmitting = ref(false)
const quick = reactive({
  kind: 'in' as 'in' | 'out' | 'move',
  location: '',
  product: '',
  batch: '',
  qty: 1,
  targetLocation: '',
  txnAt: '',
  note: '',
  recorder: localStorage.getItem('zz_recorder') || '',
})

/* ===== 录入人锁定（严格模式）：钉钉免登自动署名，禁止手填 ===== */
const recorderLocked = ref(false)
const dtIdentity = ref<DtIdentity | null>(null)

async function refreshIdentity(loud = true): Promise<boolean> {
  try {
    const id = await dingtalkLogin()
    dtIdentity.value = id
    quick.recorder = id.name
    return true
  } catch (e) {
    if (loud) ElMessage.error(`钉钉自动登录失败：${(e as Error).message}`)
    return false
  }
}

// 挂载即探知是否锁定；锁定且在钉钉内则静默免登（记一笔打开即已署名）
async function initRecorderIdentity() {
  try {
    const st = await api<{ config: { lockRecorder?: boolean } }>('/api/dingtalk/status')
    recorderLocked.value = !!st.config?.lockRecorder
  } catch {
    return // 状态拉不到时按未锁定处理，提交时后端仍会兜底拦截
  }
  if (!recorderLocked.value || !inDingtalk()) return
  await refreshIdentity(false)
}

function itemLabel(i: BatchView) {
  return i.batch ? `${i.product} / ${i.batch}` : i.product
}

function nowStr() {
  return dayjs().format('YYYY-MM-DD HH:mm')
}

// 钉钉表选项：产品图号（单选选项）、录入人（表格历史+本地台账），弹窗打开时刷新
const dtProducts = ref<string[]>([])
const dtRecorders = ref<string[]>([])
async function loadDtOptions() {
  try {
    const r = await api<{ products: string[]; recorders: string[] }>('/api/dingtalk/options')
    if (r.products?.length) dtProducts.value = [...new Set(r.products)]
    dtRecorders.value = r.recorders ?? []
  } catch {
    /* 钉钉不可用时保持手填模式 */
  }
}
function queryRecorders(qs: string, cb: (items: { value: string }[]) => void) {
  const q = qs.trim().toLowerCase()
  cb(
    dtRecorders.value
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 10)
      .map((value) => ({ value })),
  )
}

function openQuick() {
  quick.txnAt = nowStr()
  loadDtOptions()
  quickVisible.value = true
  // 锁定模式下首次打开时免登可能尚未完成（挂载时静默失败），再试一次并提示原因
  if (recorderLocked.value && !dtIdentity.value && inDingtalk()) refreshIdentity()
}

// 弹窗的库位选项独立于看板数据：空台账时也能选库位入库
const enabledLocations = computed(() => locs.value.filter((l) => l.enabled))
const occupiedLocations = computed(() => (board.value?.locations ?? []).filter((l) => l.batches > 0))

// 按区域名称分组、组内按编号排序，供记一笔弹窗下拉输出
interface LocGroup<T> {
  zone: string
  items: T[]
}
function groupByZone<T extends { code: string; zone: string }>(list: T[]): LocGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const l of [...list].sort((a, b) => a.code.localeCompare(b.code))) {
    const z = l.zone || '未分区'
    if (!groups.has(z)) groups.set(z, [])
    groups.get(z)!.push(l)
  }
  return [...groups.entries()].map(([zone, items]) => ({ zone, items })).sort((a, b) => a.zone.localeCompare(b.zone))
}
const enabledByZone = computed(() => groupByZone(enabledLocations.value))
const occupiedByZone = computed(() => groupByZone(occupiedLocations.value))
const targetByZone = computed(() => groupByZone(enabledLocations.value.filter((l) => l.code !== quick.location)))
// 该库位下的全部在库项（按停放天数倒序，先进先出）
const itemOptions = computed(() => {
  const loc = board.value?.locations.find((l) => l.code === quick.location)
  return loc ? [...loc.items].sort((a, b) => b.days - a.days) : []
})
// 产品图号下拉（去重，停放最久优先）
const productOptions = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const i of itemOptions.value) {
    if (!seen.has(i.product)) {
      seen.add(i.product)
      out.push(i.product)
    }
  }
  return out
})
// 所选产品图号下的批次下拉
const batchOptions = computed(() => itemOptions.value.filter((i) => i.product === quick.product))
const available = computed(() => batchOptions.value.find((b) => b.batch === quick.batch)?.qty ?? 0)
const targetOptions = computed(() => enabledLocations.value.filter((l) => l.code !== quick.location))

watch(
  () => quick.kind,
  () => {
    quick.location = ''
    quick.product = ''
    quick.batch = ''
    quick.qty = 1
    quick.targetLocation = ''
    quick.txnAt = nowStr()
  },
)
watch(
  () => quick.location,
  () => {
    quick.product = ''
    quick.batch = ''
    quick.qty = 1
  },
)
watch(itemOptions, (opts) => {
  // 出库/转移默认选停放最久的一项（先进先出），与白区一致
  if ((quick.kind === 'out' || quick.kind === 'move') && opts.length) {
    const first = opts[0]
    quick.product = first.product
    quick.batch = first.batch
    quick.qty = 1
  }
})

const kindLabel = computed(() => (quick.kind === 'in' ? '入库' : quick.kind === 'out' ? '出库' : '转移'))
const previewBatch = computed(() => (quick.txnAt ? dayjs(quick.txnAt).format('MMDD-HHmm') : ''))

async function submitQuick() {
  if (recorderLocked.value && !dtIdentity.value) {
    if (inDingtalk()) {
      if (!(await refreshIdentity())) return
    } else {
      return ElMessage.error('录入人已锁定为钉钉身份：请从手机/电脑钉钉打开本看板使用（普通浏览器不可记一笔）')
    }
  }
  if (!quick.recorder.trim()) return ElMessage.warning('请填写录入人')
  if (!quick.location) return ElMessage.warning('请选择库位')
  const prod = quick.product.trim()
  if (!prod) return ElMessage.warning(quick.kind === 'in' ? '请填写产品图号' : '请选择产品图号')
  if (quick.kind === 'in' && !quick.txnAt) return ElMessage.warning('请选择操作时间（批次由该时间生成）')
  if (quick.kind === 'move' && !quick.targetLocation) return ElMessage.warning('请选择目标库位')
  quickSubmitting.value = true
  try {
    if (!recorderLocked.value) localStorage.setItem('zz_recorder', quick.recorder.trim())
    // 批次号由操作时间生成（MMDD-HHmm），出库/转移则取所选批次、时间记当前
    const batch = quick.kind === 'in' ? dayjs(quick.txnAt).format('MMDD-HHmm') : quick.batch
    const txnAt = quick.kind === 'in' ? quick.txnAt : nowStr()
    const postTxn = () =>
      api<{ seq: number; dtWarning?: string }>('/api/txn', {
        method: 'POST',
        headers: dtIdentity.value ? { 'x-user-token': dtIdentity.value.token } : undefined,
        body: JSON.stringify({
          kind: quick.kind,
          location: quick.location,
          product: prod,
          batch,
          qty: quick.qty,
          targetLocation: quick.kind === 'move' ? quick.targetLocation : undefined,
          txnAt,
          recorder: quick.recorder.trim(),
          note: quick.note,
        }),
      })
    let r: { seq: number; dtWarning?: string }
    try {
      r = await postTxn()
    } catch (e) {
      // 会话 token 过期（页面开超 12 小时）：钉钉内重登一次再试，其余错误原样抛出
      if (recorderLocked.value && inDingtalk() && (e as Error).message.includes('锁定') && (await refreshIdentity())) {
        r = await postTxn()
      } else {
        throw e
      }
    }
    ElMessage.success(
      `已记一笔（#${r.seq}）：${kindLabel.value} ${quick.location}${quick.kind === 'move' ? ' → ' + quick.targetLocation : ''} · ${prod}${batch ? ' / ' + batch : ''} × ${quick.qty}`,
    )
    if (r.dtWarning) {
      ElMessage.warning(`已入本地台账，但写入钉钉流水失败：${r.dtWarning}（下次同步会自动补写，详见设置页）`)
    }
    quickVisible.value = false
    quick.note = ''
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    quickSubmitting.value = false
  }
}
</script>

<template>
  <div v-if="resp?.empty" class="empty-hint panel">
    <div class="big">台账还是空的</div>
    <div style="margin-bottom: 16px">点「记一笔」录入第一笔入库，看板实时反映。</div>
    <el-button type="success" plain :icon="EditPen" @click="openQuick()">记第一笔</el-button>
  </div>

  <template v-else-if="board">
    <div class="dashboard-header-container">
      <div class="dashboard-header-left">
        <el-button type="primary" plain :icon="Refresh" :loading="syncing || loading" @click="syncNow()">同步最新数据</el-button>
        <el-button type="success" plain :icon="EditPen" @click="openQuick()">记一笔</el-button>
        <el-button class="mobile-only" type="success" :icon="Camera" @click="scanAndRoute()">扫码</el-button>
        <el-button type="info" plain :icon="Search" @click="loadDtOptions(); queryVisible = true">产品查询</el-button>
        <el-button type="warning" plain :icon="Download" @click="exportInventory">导出</el-button>
        <span class="auto-playing-indicator">▶ 自动刷新中...</span>
      </div>

      <div class="dashboard-header-center">
        <div class="search-input-container">
          <el-input v-model="searchQuery" placeholder="搜索库位、批次、区域..." clearable />
        </div>
        <el-tag type="success" size="large" effect="dark" style="border-radius: var(--border-radius-small); font-weight: 700">
          在库总件数: {{ board.totals.qty.toLocaleString() }}
        </el-tag>
      </div>

      <div class="dashboard-statistics-group">
        <el-tag
          type="info" size="large" :effect="activeStatusFilter === 'all' ? 'dark' : 'plain'"
          :class="{ 'active-filter': activeStatusFilter === 'all' }"
          style="border-radius: var(--border-radius-small)"
          @click="activeStatusFilter = 'all'"
        >在库批次: {{ statCounts.batches }}</el-tag>
        <el-tag
          type="success" size="large" :effect="activeStatusFilter === 'ok' ? 'dark' : 'plain'"
          :class="{ 'active-filter': activeStatusFilter === 'ok' }"
          style="border-radius: var(--border-radius-small)"
          @click="activeStatusFilter = activeStatusFilter === 'ok' ? 'all' : 'ok'"
        >正常: {{ statCounts.ok }}</el-tag>
        <el-tag
          type="warning" size="large" :effect="activeStatusFilter === 'yellow' ? 'dark' : 'plain'"
          :class="{ 'active-filter': activeStatusFilter === 'yellow' }"
          style="border-radius: var(--border-radius-small)"
          @click="activeStatusFilter = activeStatusFilter === 'yellow' ? 'all' : 'yellow'"
        >预警: {{ statCounts.yellow }}</el-tag>
        <el-tag
          type="danger" size="large" :effect="activeStatusFilter === 'red' ? 'dark' : 'plain'"
          :class="{ 'active-filter': activeStatusFilter === 'red' }"
          style="border-radius: var(--border-radius-small)"
          @click="activeStatusFilter = activeStatusFilter === 'red' ? 'all' : 'red'"
        >严重: {{ statCounts.red }}</el-tag>
      </div>
    </div>

    <div class="warehouse-layout-container">
      <div v-for="group in zoneGroups" :key="group.zone" class="warehouse-zone-section">
        <div class="zone-identifier-badge">{{ group.zone }}</div>
        <div class="zone-detail-panel">
          <div class="zone-slot-grid">
            <div
              v-for="loc in group.locs"
              :key="loc.code"
              class="zone-slot-card"
              :class="[loc.batches > 0 ? 'slot-occupied' : 'slot-empty', loc.registered && !loc.enabled ? 'slot-card-disabled' : '']"
              :title="`${loc.code}${loc.zone ? ' · ' + loc.zone : ''}${loc.note ? ' · ' + loc.note : ''}`"
              @click="openDetail(loc)"
            >
              <div class="zone-slot-header" @click.stop>
                <div class="zone-slot-number">{{ loc.code }}<span v-if="loc.note" style="font-weight: 400; font-size: 10px"> · {{ loc.note }}</span></div>
                <el-tag
                  v-if="!loc.registered"
                  class="zone-slot-occupancy-tag" size="small" type="danger" effect="dark"
                  title="该库位出现在台账中但未登记，请到设置页登记"
                  @click="openDetail(loc)"
                >未登记</el-tag>
                <el-tag
                  v-else-if="!loc.enabled"
                  class="zone-slot-occupancy-tag" size="small" type="danger" effect="dark"
                  title="该库位已停用"
                  @click="openDetail(loc)"
                >已停用</el-tag>
                <el-tag
                  v-else
                  class="zone-slot-occupancy-tag" size="small" :type="loc.batches > 0 ? 'success' : 'info'" effect="light"
                  :title="`查看 ${loc.code} 全部批次明细`"
                  @click="openDetail(loc)"
                >{{ loc.batches > 0 ? `库存 ${loc.batches} 批 · ${loc.qty} 件` : '空闲' }}</el-tag>
              </div>

              <template v-if="loc.batches > 0">
                <div class="slot-mini-grid">
                  <template v-for="cell in miniCells(loc)" :key="cell.product + '|' + cell.batch">
                    <el-popover placement="top" trigger="hover" :width="300" popper-class="mini-cart-hover-popper">
                      <div class="mini-cart-hover-panel">
                        <div class="cart-title-text">{{ itemLabel(cell) }}</div>
                        <div class="cart-meta-text">
                          产品图号 {{ cell.product }}<br />
                          批次号 {{ cell.batch || '—' }} · {{ cell.qty }} 件<br />
                          库位 {{ cell.location }}<br />
                          停放 {{ cell.days }} 天（{{ cell.since }} 入位）<br />
                          <template v-if="resp?.settings">
                            状态：{{ cell.state === 'red' ? `严重超龄（≥${resp.settings.redDays}天）` : cell.state === 'yellow' ? `预警（≥${resp.settings.yellowDays}天）` : '正常流转' }}
                          </template>
                        </div>
                        <div class="mini-cart-hover-cart-identifier">
                          <el-button size="small" plain @click="openDetail(loc)">查看库位明细</el-button>
                        </div>
                      </div>
                      <template #reference>
                        <div class="slot-mini-grid-cell" :class="'slot-mini-grid-' + cell.state">
                          <span class="slot-mini-grid-qty">{{ cell.qty }}</span>
                        </div>
                      </template>
                    </el-popover>
                  </template>
                  <div v-for="n in 20 - miniCells(loc).length" :key="'e' + n" class="slot-mini-grid-cell slot-mini-grid-empty"></div>
                </div>
                <div v-if="overflowCount(loc) > 0" class="slot-overflow-hint">
                  <el-tag type="warning" effect="light" style="cursor: pointer" title="点击查看该库位全部批次明细" @click="openDetail(loc)">
                    超出20批 {{ overflowCount(loc) }} 批
                  </el-tag>
                </div>
              </template>
              <div v-else-if="loc.registered && loc.enabled" class="zone-slot-empty-text">库位空闲</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!zoneGroups.length" class="empty-hint">
        {{ searchQuery ? `没有匹配「${searchQuery}」的库位或批次` : activeStatusFilter !== 'all' ? '当前筛选下没有库位' : '暂无库位' }}
      </div>
    </div>

    <el-dialog v-model="detailVisible" :title="`库位批次明细 · ${detailLoc?.code ?? ''}`" width="680px" destroy-on-close>
      <el-alert
        type="info" :closable="false" show-icon style="margin-bottom: 10px"
        :title="`共 ${detailLoc?.items.length ?? 0} 个批次 · 合计 ${detailLoc?.qty ?? 0} 件 · 按停放时间倒序（先进先出）`"
      />
      <el-descriptions v-if="detailLoc" class="detail-desc" :column="3" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="区域">{{ detailLoc.zone || '—' }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ detailLoc.note || '—' }}</el-descriptions-item>
        <el-descriptions-item label="数据日">{{ board.asOf }}</el-descriptions-item>
      </el-descriptions>
      <!-- 手机端：区域/备注单行展示（替代表格化描述组） -->
      <div v-if="detailLoc" class="detail-meta-line">区域 {{ detailLoc.zone || '—' }} · 备注 {{ detailLoc.note || '—' }} · 数据日 {{ board.asOf }}</div>
      <!-- 手机端：卡片列表替代表格，信息纵向排布免横滑；桌面端隐藏（走下方 el-table） -->
      <div v-if="detailLoc" class="dialog-card-list">
        <div
          v-for="(i, idx) in detailLoc.items"
          :key="i.product + '|' + i.batch"
          class="dialog-card"
          :class="'dialog-card-' + i.state"
        >
          <div class="dialog-card-top">
            <span class="dialog-card-title">{{ idx + 1 }}. {{ i.product }}</span>
            <span class="dialog-card-qty">{{ i.qty }} 件</span>
          </div>
          <div class="dialog-card-meta">
            批次 {{ i.batch || '—' }} · 停放 <b :style="{ color: dotColor(i.state) }">{{ i.days }} 天</b> · {{ i.since }} 入位
          </div>
        </div>
      </div>
      <el-table v-if="detailLoc" class="detail-table" :data="detailLoc.items" size="small" max-height="460">
        <el-table-column prop="product" label="产品图号" min-width="130" />
        <el-table-column label="批次号" width="110">
          <template #default="scope">{{ scope.row.batch || '—' }}</template>
        </el-table-column>
        <el-table-column prop="qty" label="数量(件)" width="90" align="right" />
        <el-table-column label="停放" width="80" align="center">
          <template #default="scope">{{ scope.row.days }} 天</template>
        </el-table-column>
        <el-table-column prop="since" label="入位日期" width="110" />
        <el-table-column label="状态" width="70" align="center">
          <template #default="scope">
            <span
              :style="{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: dotColor(scope.row.state) }"
              :title="scope.row.state === 'red' ? '严重超龄' : scope.row.state === 'yellow' ? '预警' : '正常'"
            ></span>
          </template>
        </el-table-column>
      </el-table>
      <div class="muted" style="margin-top: 8px">车位格显示前 20 个批次，其余批次在此明细中完整查看；变动请点「记一笔」。</div>
    </el-dialog>

  </template>

  <div v-else class="empty-hint panel">加载中…</div>

  <el-dialog v-model="quickVisible" title="记一笔 · 白区台账" width="560px" destroy-on-close>
    <el-form label-width="82px">
      <el-form-item label="操作类型">
        <el-radio-group v-model="quick.kind">
          <el-radio-button label="in">入库</el-radio-button>
          <el-radio-button label="out">出库</el-radio-button>
          <el-radio-button label="move">转移</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="库位">
        <div class="scan-field">
          <el-select v-if="quick.kind === 'in'" v-model="quick.location" filterable placeholder="选择入库库位" style="flex: 1; min-width: 0">
            <el-option-group v-for="g in enabledByZone" :key="g.zone" :label="g.zone">
              <el-option v-for="l in g.items" :key="l.code" :label="l.code + (l.note ? ` · ${l.note}` : '')" :value="l.code" />
            </el-option-group>
          </el-select>
          <el-select v-else v-model="quick.location" filterable placeholder="选择有货库位" style="flex: 1; min-width: 0">
            <el-option-group v-for="g in occupiedByZone" :key="g.zone" :label="g.zone">
              <el-option
                v-for="l in g.items"
                :key="l.code"
                :label="`${l.code}（${l.batches} 批 · ${l.qty} 件）`"
                :value="l.code"
              />
            </el-option-group>
          </el-select>
          <el-button class="mobile-only scan-trigger" :icon="Camera" title="扫库位码" @click="scanFill('location')" />
        </div>
      </el-form-item>
      <el-form-item label="产品图号">
        <div class="scan-field">
          <el-select
            v-if="quick.kind === 'in' && dtProducts.length"
            v-model="quick.product" filterable allow-create default-first-option
            placeholder="搜索选择产品图号（钉钉表选项）" style="flex: 1; min-width: 0"
          >
            <el-option v-for="p in dtProducts" :key="p" :label="p" :value="p" />
          </el-select>
          <el-input v-else-if="quick.kind === 'in'" v-model="quick.product" placeholder="填写产品图号（钉钉不可用时手填）" maxlength="60" style="flex: 1; min-width: 0" />
          <el-select v-else v-model="quick.product" filterable placeholder="选择产品" style="flex: 1; min-width: 0" @change="quick.batch = ''; quick.qty = 1">
            <el-option v-for="p in productOptions" :key="p" :label="p" :value="p" />
          </el-select>
          <el-button class="mobile-only scan-trigger" :icon="Camera" title="扫产品码（条码内容=图号）" @click="scanFill('product')" />
        </div>
      </el-form-item>
      <el-form-item v-if="quick.kind === 'move'" label="目标库位">
        <div class="scan-field">
          <el-select v-model="quick.targetLocation" filterable placeholder="选择目标库位" style="flex: 1; min-width: 0">
            <el-option-group v-for="g in targetByZone" :key="g.zone" :label="g.zone">
              <el-option v-for="l in g.items" :key="l.code" :label="l.code + (l.note ? ` · ${l.note}` : '')" :value="l.code" />
            </el-option-group>
          </el-select>
          <el-button class="mobile-only scan-trigger" :icon="Camera" title="扫目标库位码" @click="scanFill('target')" />
        </div>
      </el-form-item>
      <el-form-item :label="quick.kind === 'in' ? '操作时间' : '批次号'">
        <el-date-picker
          v-if="quick.kind === 'in'"
          v-model="quick.txnAt" type="datetime"
          format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DD HH:mm"
          :clearable="false" style="width: 100%"
          placeholder="批次由此时间生成"
        />
        <div v-if="quick.kind === 'in'" class="muted" style="width: 100%">
          批次号将记为 <b>{{ previewBatch || '—' }}</b>（按操作时间自动生成）
        </div>
        <el-select v-else v-model="quick.batch" placeholder="选哪批就动哪批；默认已选停放最久(先进先出)" style="width: 100%">
          <el-option
            v-for="b in batchOptions"
            :key="b.batch"
            :label="`${b.batch || '（无批次号）'} · 余 ${b.qty} 件 · 停放 ${b.days} 天`"
            :value="b.batch"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="变动数量">
        <el-input-number
          v-model="quick.qty" :min="1"
          :max="quick.kind === 'in' ? 1000000 : Math.max(1, available)"
          :step="1" step-strictly controls-position="right" style="width: 160px"
        />
        <span class="muted" style="margin-left: 10px">件<span v-if="quick.kind !== 'in' && quick.batch">；现有 {{ available }} 件，出库/转移超出会被拒绝</span></span>
      </el-form-item>
      <el-form-item label="录入人">
        <el-autocomplete
          v-model="quick.recorder"
          :fetch-suggestions="queryRecorders"
          :disabled="recorderLocked"
          :placeholder="recorderLocked ? '钉钉身份自动署名，不可修改' : '谁经手谁署名（可从历史带出）'"
          style="width: 220px"
        />
        <span v-if="recorderLocked" class="muted" style="margin-left: 8px">
          {{ dtIdentity ? '已登录' : inDingtalk() ? '正在登录钉钉身份…' : '需在钉钉内使用' }}
        </span>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="quick.note" placeholder="选填" maxlength="100" />
      </el-form-item>
    </el-form>
      <template #footer>
        <div class="dialog-footer-row">
          <el-button @click="quickVisible = false">取消</el-button>
          <el-button type="primary" :loading="quickSubmitting" @click="submitQuick()">记入台账</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="queryVisible" title="产品查询 · 排产库存速查" width="720px" destroy-on-close>
      <div class="scan-field" style="margin-bottom: 12px">
        <el-autocomplete
          v-model="queryKeyword"
          :fetch-suggestions="queryProducts"
          clearable
          :trigger-on-focus="false"
          placeholder="输入或搜索产品图号，如 18686"
          style="flex: 1; min-width: 0"
        />
        <el-button class="mobile-only scan-trigger" :icon="Camera" title="扫产品码（条码内容=图号）" @click="scanToQuery()" />
      </div>
      <div v-if="queryKeyword && !queryRows.length" class="muted" style="padding: 20px 0; text-align: center">
        白区当前没有「{{ queryKeyword }}」的库存
      </div>
      <template v-else-if="queryRows.length">
        <el-alert
          type="success" :closable="false" show-icon style="margin-bottom: 10px"
          :title="`现有总量 ${queryTotal} 件 · 分布在 ${queryLocCount} 个库位 · 共 ${queryRows.length} 行`"
        />
        <!-- 手机端：卡片列表替代表格，信息纵向排布免横滑；桌面端隐藏（走下方 el-table） -->
        <div class="dialog-card-list">
          <div
            v-for="r in queryRows"
            :key="r.location + '|' + r.product + '|' + r.batch"
            class="dialog-card"
            :class="'dialog-card-' + r.state"
          >
            <div class="dialog-card-top">
              <span class="dialog-card-title">{{ r.location }} · {{ r.product }}</span>
              <span class="dialog-card-qty">{{ r.qty }} 件</span>
            </div>
            <div class="dialog-card-meta">
              {{ r.zone || '未分区' }} · 批次 {{ r.batch || '—' }} · 停放 <b :style="{ color: dotColor(r.state) }">{{ r.days }} 天</b> · {{ r.since }} 入位
            </div>
          </div>
        </div>
        <el-table class="query-table" :data="queryRows" size="small" max-height="380">
          <el-table-column prop="location" label="库位" width="80" />
          <el-table-column prop="zone" label="区域" width="90">
            <template #default="scope">{{ scope.row.zone || '—' }}</template>
          </el-table-column>
          <el-table-column prop="product" label="产品图号" min-width="140" />
          <el-table-column prop="batch" label="批次号" width="110">
            <template #default="scope">{{ scope.row.batch || '—' }}</template>
          </el-table-column>
          <el-table-column prop="qty" label="数量(件)" width="90" align="right" />
          <el-table-column label="停放" width="90" align="center">
            <template #default="scope">
              <el-tag :type="scope.row.state === 'red' ? 'danger' : scope.row.state === 'yellow' ? 'warning' : 'success'" size="small" disable-transitions>
                {{ scope.row.days }} 天
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="since" label="入位日期" width="110" />
        </el-table>
        <div class="muted" style="margin-top: 8px">排产提示：按先进先出，优先安排停放时间长的批次。</div>
      </template>
    </el-dialog>
</template>
