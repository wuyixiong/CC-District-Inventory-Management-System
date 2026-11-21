<script setup lang="ts">
/**
 * PDA 扫码录入（第一期）：硬件扫码头 = 键盘输入 + 回车。
 * 扫库位码填库位（转移时第二个库位码 = 目标库位），连续扫 MO 码按图号分组计数，一键提交（每个图号一笔，带 moCodes + requestId）。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

type Kind = 'in' | 'out' | 'move'
interface MoInfo {
  code: string
  imported: boolean
  materialNo: string
  materialName: string
  drawingNo: string
  rawDrawingNo: string
  moldNo: string
  docNo: string
  aligned: string
}
interface Stock {
  location: string
  product: string
  batch: string
  inAt: string
}
interface Resolve {
  type: 'location' | 'mo' | 'product' | 'unknown'
  code: string
  location?: { code: string; zone: string; enabled: boolean }
  mo?: MoInfo
  stock?: Stock | null
  needPick?: boolean
  product?: string
  message?: string
}
interface Item {
  code: string
  drawing: string
  materialName: string
  moldNo: string
  at: number
}

const KIND_LABEL: Record<Kind, string> = { in: '入库', out: '出库', move: '转移' }
const kind = ref<Kind>('in')
const location = ref('')
const target = ref('')
const recorder = ref(localStorage.getItem('zz_recorder') || '')
const items = ref<Item[]>([])
const scanText = ref('')
const busy = ref(false)
const submitting = ref(false)
const keyboard = ref(false) // 允许弹出软键盘手输（默认关闭：扫码头输入不弹键盘）
const lastMsg = reactive({ type: 'info' as 'info' | 'success' | 'warning' | 'error', text: '先扫「库位码」，再连续扫产品上的 MO 码' })
const locked = ref(false)
const lockedHit = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

watch(recorder, (v) => localStorage.setItem('zz_recorder', v.trim()))

/* ===== 反馈：提示条 + 蜂鸣（PDA 现场看不清屏幕时靠声音） ===== */
let audio: AudioContext | null = null
function beep(ok: boolean) {
  try {
    audio = audio ?? new AudioContext()
    const o = audio.createOscillator()
    const g = audio.createGain()
    o.frequency.value = ok ? 1500 : 300
    g.gain.value = 0.15
    o.connect(g)
    g.connect(audio.destination)
    o.start()
    o.stop(audio.currentTime + (ok ? 0.08 : 0.35))
  } catch {
    /* 无音频设备时忽略 */
  }
}
function say(type: typeof lastMsg.type, text: string) {
  lastMsg.type = type
  lastMsg.text = text
  if (type === 'success') beep(true)
  else if (type === 'error' || type === 'warning') beep(false)
}

/* ===== 扫码输入框始终聚焦 ===== */
const pickVisible = ref(false)
function focusInput() {
  if (pickVisible.value) return
  nextTick(() => inputEl.value?.focus())
}
let focusTimer: ReturnType<typeof setInterval> | null = null
let lastKeyAt = 0
const markKey = () => (lastKeyAt = Date.now())
onMounted(async () => {
  focusInput()
  document.addEventListener('keydown', markKey, true)
  // 点按钮/切换后焦点会离开，定时拉回（输入框之外正在输入时不抢）
  focusTimer = setInterval(() => {
    const a = document.activeElement as HTMLElement | null
    if (pickVisible.value || submitting.value) return
    // 正在别的输入框（如录入人）打字时不抢焦点；停手 6 秒后拉回，防止扫码内容打进录入人框
    if (a && a !== inputEl.value && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && Date.now() - lastKeyAt < 6000) return
    if (a !== inputEl.value) inputEl.value?.focus()
  }, 800)
  try {
    const st = await api<{ config: { lockRecorder?: boolean } }>('/api/dingtalk/status')
    locked.value = !!st.config?.lockRecorder
  } catch {
    /* 拿不到状态时按未锁定处理，提交时后端兜底 */
  }
  loadOptions()
})
onUnmounted(() => {
  document.removeEventListener('keydown', markKey, true)
  if (focusTimer) clearInterval(focusTimer)
})

/* ===== 分组 ===== */
const groups = computed(() => {
  const m = new Map<string, Item[]>()
  for (const it of items.value) {
    if (!m.has(it.drawing)) m.set(it.drawing, [])
    m.get(it.drawing)!.push(it)
  }
  return [...m.entries()].map(([drawing, list]) => ({ drawing, list, name: list[0]?.materialName ?? '' }))
})
const total = computed(() => items.value.length)

function setKind(k: Kind) {
  if (k === kind.value) return focusInput()
  const apply = () => {
    kind.value = k
    items.value = []
    target.value = ''
    say('info', k === 'move' ? '转移：先扫「原库位码」，再扫「目标库位码」，然后扫 MO 码' : `${KIND_LABEL[k]}：扫库位码，再连续扫 MO 码`)
    focusInput()
  }
  if (!items.value.length) return apply()
  ElMessageBox.confirm(`已扫 ${items.value.length} 件未提交，切换为「${KIND_LABEL[k]}」会清空列表，确定？`, '切换操作类型', { type: 'warning' })
    .then(apply)
    .catch(focusInput)
}

/* ===== 扫码处理：扫码头连扫时排队逐个解析，不丢码 ===== */
const queue: string[] = []
function onEnter() {
  const text = scanText.value.trim()
  scanText.value = ''
  if (!text) return
  if (pickVisible.value) return say('warning', '请先在弹窗中确定图号，期间的扫码无效，请重扫')
  queue.push(text)
  if (!busy.value) drain()
}
async function drain() {
  busy.value = true
  try {
    while (queue.length) await handleScan(queue.shift()!)
  } finally {
    busy.value = false
    focusInput()
  }
}
async function handleScan(text: string) {
  try {
    const r = await api<Resolve>(`/api/scan/resolve?code=${encodeURIComponent(text)}`)
    if (r.type === 'location') onLocation(r)
    else if (r.type === 'mo') await onMo(r)
    else if (r.type === 'product') say('warning', `「${text}」不是库位码也不是 MO 码：PDA 录入只认 MO 码（无码产品请用看板「记一笔」）`)
    else say('error', r.message || `无法识别：${text}`)
  } catch (e) {
    say('error', `解析失败：${(e as Error).message}`)
  }
}

function onLocation(r: Resolve) {
  const code = r.code
  if (r.location && !r.location.enabled) return say('error', `库位 ${code} 已停用，不能录入`)
  if (kind.value === 'move' && location.value && code !== location.value) {
    target.value = code
    return say('success', `目标库位：${code}`)
  }
  if (kind.value !== 'in' && location.value && code !== location.value && items.value.length) {
    return say('warning', `已按库位 ${location.value} 扫了 ${items.value.length} 件，先提交或清空列表再换库位`)
  }
  location.value = code
  if (kind.value === 'move' && target.value === code) target.value = ''
  say('success', kind.value === 'move' ? `原库位：${code}（下一个库位码 = 目标库位）` : `库位：${code}`)
}

async function onMo(r: Resolve) {
  const mo = r.mo!
  if (items.value.some((i) => i.code === mo.code)) return say('warning', `重复扫码：${mo.code} 已在列表中`)
  const st = r.stock
  if (kind.value === 'in') {
    if (st) return say('error', `${mo.code} 已在库（${st.location} · ${st.product}），不能重复入库`)
  } else {
    if (!location.value) return say('warning', `请先扫${kind.value === 'move' ? '原' : ''}库位码，再扫 MO 码`)
    if (!st) return say('error', `${mo.code} 不在库，无法${KIND_LABEL[kind.value]}`)
    if (st.location !== location.value) return say('error', `${mo.code} 在库位 ${st.location}，不在 ${location.value}`)
  }
  let drawing = st?.product || mo.drawingNo
  if (!st && r.needPick) {
    const picked = await pickDrawing(mo)
    if (!picked) return say('warning', `已取消：${mo.code} 未加入（需先确定图号）`)
    drawing = picked
  }
  items.value.unshift({ code: mo.code, drawing, materialName: mo.materialName, moldNo: mo.moldNo, at: Date.now() })
  say('success', `${mo.code} · ${mo.materialName || '未导入物料'} · ${drawing}${mo.moldNo ? ' · 模号 ' + mo.moldNo : ''}`)
}

function removeItem(code: string) {
  items.value = items.value.filter((i) => i.code !== code)
  focusInput()
}
function clearAll() {
  if (!items.value.length) return focusInput()
  ElMessageBox.confirm(`清空已扫的 ${items.value.length} 件？`, '清空列表', { type: 'warning' })
    .then(() => {
      items.value = []
      say('info', '列表已清空')
    })
    .catch(() => undefined)
    .finally(focusInput)
}

/* ===== 图号选择（needPick：MES 图号与钉钉选项对不上 / 未导入的 MO 码），选一次后记住 ===== */
const options = ref<string[]>([])
async function loadOptions() {
  try {
    const r = await api<{ products: string[] }>('/api/dingtalk/options')
    options.value = [...new Set(r.products ?? [])]
  } catch {
    options.value = []
  }
}
const pickMo = ref<MoInfo | null>(null)
const pickKeyword = ref('')
const pickManual = ref('')
let pickResolve: ((v: string) => void) | null = null
const stripParen = (s: string) => s.replace(/[（(][^）)]*[）)]/g, '').trim()
const pickList = computed(() => {
  const q = pickKeyword.value.trim().toLowerCase()
  const list = q ? options.value.filter((o) => o.toLowerCase().includes(q)) : options.value
  return list.slice(0, 60)
})
function pickDrawing(mo: MoInfo): Promise<string> {
  pickMo.value = mo
  pickKeyword.value = stripParen(mo.rawDrawingNo || '')
  pickManual.value = mo.rawDrawingNo || ''
  pickVisible.value = true
  inputEl.value?.blur()
  return new Promise((resolve) => (pickResolve = resolve))
}
async function confirmPick(value: string) {
  const v = value.trim()
  const mo = pickMo.value
  if (!v || !mo) return
  if (v.length > 60 || v.includes('|')) return ElMessage.warning('图号不超过 60 字符且不含竖线')
  try {
    if (mo.imported) {
      await api('/api/momap/alias', { method: 'POST', body: JSON.stringify({ materialNo: mo.materialNo, drawingNo: mo.rawDrawingNo, target: v }) })
    } else {
      await api(`/api/momap/${encodeURIComponent(mo.code)}`, { method: 'PUT', body: JSON.stringify({ drawingNo: v }) })
    }
  } catch (e) {
    ElMessage.error(`记住图号失败：${(e as Error).message}`)
    return
  }
  pickVisible.value = false
  pickResolve?.(v)
  pickResolve = null
}
function cancelPick() {
  pickVisible.value = false
  pickResolve?.('')
  pickResolve = null
}

/* ===== 提交：每个图号一笔，带 moCodes 与 requestId（网络失败重试不会重复入账） ===== */
const ridCache = new Map<string, string>()
const newRid = () => `pda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const canSubmit = computed(
  () => !!items.value.length && !!location.value && !!recorder.value.trim() && (kind.value !== 'move' || (!!target.value && target.value !== location.value)),
)
const submitHint = computed(() => {
  if (!location.value) return '请先扫库位码'
  if (kind.value === 'move' && !target.value) return '请扫目标库位码'
  if (!items.value.length) return '请扫 MO 码'
  if (!recorder.value.trim()) return '请填录入人'
  return ''
})

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const okGroups: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  try {
    for (const g of groups.value) {
      const codes = g.list.map((i) => i.code)
      const sig = [kind.value, location.value, target.value, g.drawing, [...codes].sort().join(',')].join('|')
      const rid = ridCache.get(sig) ?? newRid()
      ridCache.set(sig, rid)
      const res = await fetch('/api/txn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: kind.value,
          location: location.value,
          targetLocation: kind.value === 'move' ? target.value : undefined,
          product: g.drawing,
          qty: codes.length,
          moCodes: codes,
          recorder: recorder.value.trim(),
          txnAt: dayjs().format('YYYY-MM-DD HH:mm'),
          note: 'PDA扫码',
          requestId: rid,
        }),
      }).catch((e: Error) => {
        errors.push(`${g.drawing}：网络异常（${e.message}），可直接重试，不会重复入账`)
        return null
      })
      if (!res) continue
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.code === 'RECORDER_LOCKED') {
          lockedHit.value = true
          errors.push('已开启「锁定录入人」，PDA 暂不能提交（PDA 登录属第二期）')
          break
        }
        errors.push(`${g.drawing}：${data.message || '提交失败（' + res.status + '）'}`)
        continue
      }
      okGroups.push(g.drawing)
      ridCache.delete(sig)
      if (data.dtWarning) warnings.push(data.dtWarning)
    }
  } finally {
    submitting.value = false
  }
  if (okGroups.length) {
    const n = items.value.filter((i) => okGroups.includes(i.drawing)).length
    items.value = items.value.filter((i) => !okGroups.includes(i.drawing))
    say(errors.length ? 'warning' : 'success', `已${KIND_LABEL[kind.value]} ${okGroups.length} 个图号共 ${n} 件${errors.length ? '；未成功：' + errors.join('；') : ''}`)
    if (warnings.length) ElMessage.warning(`已入账，回写钉钉稍后补写：${warnings[0]}`)
  } else if (errors.length) {
    say('error', errors.join('；'))
  }
  focusInput()
}
</script>

<template>
  <div class="pda">
    <el-alert
      v-if="locked || lockedHit"
      type="error" :closable="false" show-icon class="pda-alert"
      title="已开启「锁定录入人」：PDA 提交会被拒绝"
      description="锁定模式只认钉钉免登身份，PDA 登录属第二期。请管理员在「设置 → 钉钉同步」暂时关闭「锁定录入人」，或改用钉钉内看板「记一笔」。"
    />

    <div class="pda-kinds">
      <button v-for="k in (['in', 'out', 'move'] as Kind[])" :key="k" :class="['pda-kind', 'pda-kind-' + k, { active: kind === k }]" @click="setKind(k)">
        {{ KIND_LABEL[k] }}
      </button>
    </div>

    <div class="pda-locs">
      <div class="pda-loc" :class="{ empty: !location }">
        <span class="pda-loc-label">{{ kind === 'move' ? '原库位' : '库位' }}</span>
        <span class="pda-loc-val">{{ location || '扫库位码' }}</span>
        <button v-if="location" class="pda-x" @click="location = ''; focusInput()">×</button>
      </div>
      <div v-if="kind === 'move'" class="pda-loc" :class="{ empty: !target }">
        <span class="pda-loc-label">目标库位</span>
        <span class="pda-loc-val">{{ target || '再扫库位码' }}</span>
        <button v-if="target" class="pda-x" @click="target = ''; focusInput()">×</button>
      </div>
    </div>

    <div class="pda-scan">
      <input
        ref="inputEl"
        v-model="scanText"
        class="pda-input"
        :inputmode="keyboard ? 'text' : 'none'"
        :readonly="pickVisible"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :placeholder="busy ? '解析中…' : '在此扫码（扫码头自动回车）'"
        @keydown.enter.prevent="onEnter"
      />
      <button class="pda-kb" :class="{ on: keyboard }" title="手动输入" @click="keyboard = !keyboard; focusInput()">⌨</button>
    </div>

    <div class="pda-msg" :class="'pda-msg-' + lastMsg.type">{{ lastMsg.text }}</div>

    <div class="pda-list">
      <div class="pda-list-head">
        <span>已扫 <b>{{ total }}</b> 件 · {{ groups.length }} 个图号</span>
        <button v-if="total" class="pda-link" @click="clearAll">清空</button>
      </div>
      <div v-for="g in groups" :key="g.drawing" class="pda-group">
        <div class="pda-group-head">
          <span class="pda-group-draw">{{ g.drawing }}</span>
          <span class="pda-group-name">{{ g.name }}</span>
          <span class="pda-group-count">{{ g.list.length }} 件</span>
        </div>
        <div v-for="i in g.list" :key="i.code" class="pda-item">
          <span class="pda-item-code">{{ i.code }}</span>
          <span class="pda-item-mold">{{ i.moldNo ? '模号 ' + i.moldNo : '' }}</span>
          <button class="pda-x" title="删除误扫" @click="removeItem(i.code)">×</button>
        </div>
      </div>
      <div v-if="!total" class="pda-empty">暂无，扫 MO 码后按图号分组显示</div>
    </div>

    <div class="pda-foot">
      <el-input v-model="recorder" class="pda-recorder" placeholder="录入人（必填，本机记住）" maxlength="20" clearable @keydown.enter="focusInput" @blur="focusInput" />
      <button class="pda-submit" :class="'pda-kind-' + kind" :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? '提交中…' : submitHint || `提交${KIND_LABEL[kind]}（${total} 件）` }}
      </button>
    </div>

    <el-dialog v-model="pickVisible" title="选择钉钉图号" width="94%" :close-on-click-modal="false" :show-close="false" append-to-body>
      <div v-if="pickMo" class="pda-pick-info">
        <div><b>{{ pickMo.code }}</b>{{ pickMo.imported ? '' : '（未导入 MES 清单）' }}</div>
        <div v-if="pickMo.imported">{{ pickMo.materialName }} · MES 图号 {{ pickMo.rawDrawingNo }}{{ pickMo.moldNo ? ' · 模号 ' + pickMo.moldNo : '' }}</div>
        <div class="muted">选一次后记住，同物料下次自动对齐；弹窗期间扫码无效，选完再继续扫</div>
      </div>
      <template v-if="options.length">
        <el-input v-model="pickKeyword" placeholder="搜索钉钉图号选项" clearable size="large" />
        <div class="pda-pick-list">
          <button v-for="o in pickList" :key="o" class="pda-pick-opt" @click="confirmPick(o)">{{ o }}</button>
          <div v-if="!pickList.length" class="muted" style="padding: 10px">没有匹配的选项</div>
        </div>
      </template>
      <template v-else>
        <div class="muted" style="margin-bottom: 8px">钉钉图号选项不可用，请手动确认图号：</div>
        <el-input v-model="pickManual" placeholder="产品图号" size="large" @keydown.enter="confirmPick(pickManual)" />
        <el-button type="primary" size="large" style="margin-top: 10px; width: 100%" @click="confirmPick(pickManual)">确定</el-button>
      </template>
      <template #footer>
        <el-button size="large" @click="cancelPick">取消（不加入此码）</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pda { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; font-size: 18px; }
.pda-alert { font-size: 15px; }
.pda-kinds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pda-kind {
  height: 64px; font-size: 24px; font-weight: 700; border-radius: 10px; cursor: pointer;
  border: 2px solid #dcdfe6; background: #fff; color: #606266;
}
.pda-kind-in.active { background: #3aa85b; border-color: #3aa85b; color: #fff; }
.pda-kind-out.active { background: #e05a4f; border-color: #e05a4f; color: #fff; }
.pda-kind-move.active { background: #e6a23c; border-color: #e6a23c; color: #fff; }
.pda-locs { display: flex; gap: 10px; }
.pda-loc {
  flex: 1; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-radius: 10px; background: #f0f9eb; border: 2px solid #3aa85b; min-height: 56px;
}
.pda-loc.empty { background: #fdf6ec; border: 2px dashed #e6a23c; }
.pda-loc-label { font-size: 14px; color: #909399; white-space: nowrap; }
.pda-loc-val { flex: 1; font-size: 26px; font-weight: 700; word-break: break-all; }
.pda-loc.empty .pda-loc-val { font-size: 18px; font-weight: 400; color: #b88230; }
.pda-scan { display: flex; gap: 8px; }
.pda-input {
  flex: 1; min-width: 0; height: 60px; font-size: 22px; padding: 0 14px; border-radius: 10px;
  border: 3px solid #409eff; outline: none; background: #fff; color: #303133;
}
.pda-input:focus { box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.25); }
.pda-kb { width: 60px; font-size: 24px; border-radius: 10px; border: 2px solid #dcdfe6; background: #fff; cursor: pointer; }
.pda-kb.on { border-color: #409eff; background: #ecf5ff; }
.pda-msg { padding: 12px 14px; border-radius: 10px; font-size: 18px; line-height: 1.4; word-break: break-all; }
.pda-msg-info { background: #f4f4f5; color: #606266; }
.pda-msg-success { background: #f0f9eb; color: #2f7d47; }
.pda-msg-warning { background: #fdf6ec; color: #a5711f; }
.pda-msg-error { background: #fef0f0; color: #c0392b; font-weight: 700; }
.pda-list { background: #fff; border-radius: 10px; border: 1px solid #ebeef5; padding: 10px 12px; min-height: 120px; }
.pda-list-head { display: flex; justify-content: space-between; align-items: center; font-size: 16px; color: #606266; margin-bottom: 6px; }
.pda-list-head b { font-size: 22px; color: #303133; }
.pda-link { border: none; background: none; color: #f56c6c; font-size: 16px; cursor: pointer; }
.pda-group { border-top: 1px solid #ebeef5; padding: 8px 0; }
.pda-group-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pda-group-draw { font-size: 20px; font-weight: 700; }
.pda-group-name { color: #606266; font-size: 16px; flex: 1; }
.pda-group-count { font-size: 20px; font-weight: 700; color: #409eff; }
.pda-item { display: flex; align-items: center; gap: 10px; padding: 4px 0 4px 10px; font-size: 16px; }
.pda-item-code { font-family: ui-monospace, Menlo, Consolas, monospace; }
.pda-item-mold { flex: 1; color: #909399; font-size: 14px; }
.pda-x { width: 40px; height: 40px; border-radius: 8px; border: 1px solid #dcdfe6; background: #fff; font-size: 22px; color: #f56c6c; cursor: pointer; flex: none; }
.pda-empty { color: #c0c4cc; text-align: center; padding: 24px 0; font-size: 16px; }
.pda-foot { display: flex; flex-direction: column; gap: 10px; position: sticky; bottom: 0; background: var(--el-bg-color-page, #f5f7fa); padding: 8px 0; }
.pda-recorder :deep(.el-input__wrapper) { height: 52px; font-size: 18px; }
.pda-submit { height: 72px; font-size: 26px; font-weight: 700; border-radius: 12px; border: none; color: #fff; cursor: pointer; }
.pda-submit.pda-kind-in { background: #3aa85b; }
.pda-submit.pda-kind-out { background: #e05a4f; }
.pda-submit.pda-kind-move { background: #e6a23c; }
.pda-submit:disabled { background: #c0c4cc; cursor: not-allowed; font-size: 22px; }
.pda-pick-info { margin-bottom: 10px; font-size: 16px; line-height: 1.6; }
.pda-pick-list { max-height: 50vh; overflow: auto; margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.pda-pick-opt { text-align: left; padding: 12px; font-size: 18px; border-radius: 8px; border: 1px solid #dcdfe6; background: #fff; cursor: pointer; }
.pda-pick-opt:active { background: #ecf5ff; }
</style>
