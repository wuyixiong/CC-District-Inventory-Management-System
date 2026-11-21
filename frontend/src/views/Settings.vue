<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Printer } from '@element-plus/icons-vue'
import QRCode from 'qrcode'
import { api } from '../api'
import type { AuditEvent, DingtalkConfig, DingtalkStatus, LocationItem, MoImportResult, MoMapItem, Settings, SyncReport } from '../types'

const settings = reactive<Settings>({ yellowDays: 3, redDays: 5, moPattern: '^MO\\d{12}$' })
const locs = ref<LocationItem[]>([])
const audit = ref<AuditEvent[]>([])

const newLoc = reactive({ code: '', zone: '', note: '' })
const bulkText = ref('')

/* ===== 钉钉同步（录入端） ===== */
const dt = reactive<DingtalkConfig>({
  appKey: '', appSecret: '', operatorId: '', baseId: '', sheet: '中转库流水',
  autoSyncMinutes: 2, mirror: true, corpId: '', agentId: '', lockRecorder: false,
})
const dtStatus = ref<DingtalkStatus | null>(null)
const dtSyncing = ref(false)
const dtSkipped = ref<{ id: string; reason: string }[]>([])

async function loadDt() {
  dtStatus.value = await api<DingtalkStatus>('/api/dingtalk/status')
  Object.assign(dt, dtStatus.value.config)
}

async function saveDt() {
  try {
    dtStatus.value = await api<DingtalkStatus>('/api/dingtalk/config', { method: 'PUT', body: JSON.stringify(dt) })
    Object.assign(dt, dtStatus.value.config)
    ElMessage.success('钉钉配置已保存' + (dtStatus.value.configured ? '，自动同步已生效' : '（尚不完整，补全后生效）'))
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function syncNow() {
  dtSyncing.value = true
  dtSkipped.value = []
  try {
    const r = await api<{ report: SyncReport }>('/api/dingtalk/sync', { method: 'POST' })
    ElMessage.success(`同步完成：表格 ${r.report.total} 行，新入账 ${r.report.added} 笔${r.report.skippedRows.length ? `，跳过 ${r.report.skippedRows.length} 行（见下方清单）` : ''}`)
    dtSkipped.value = r.report.skippedRows
    await loadDt()
    loadAll()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    dtSyncing.value = false
  }
}

async function loadAll() {
  const s = await api<{ settings: Settings }>('/api/state')
  Object.assign(settings, s.settings)
  const l = await api<{ locations: LocationItem[] }>('/api/locations')
  locs.value = l.locations
  const a = await api<{ events: AuditEvent[] }>('/api/audit?limit=15')
  audit.value = a.events
  await loadDt()
}

async function saveSettings() {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) })
    ElMessage.success('阈值已保存，看板颜色即时生效')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function addLoc() {
  try {
    await api('/api/locations', { method: 'POST', body: JSON.stringify(newLoc) })
    ElMessage.success(`库位 ${newLoc.code.toUpperCase()} 已登记`)
    newLoc.code = ''
    newLoc.zone = ''
    newLoc.note = ''
    loadAll()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function toggleLoc(l: LocationItem) {
  try {
    await api(`/api/locations/${l.code}`, { method: 'PUT', body: JSON.stringify({ enabled: l.enabled }) })
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function saveLoc(l: LocationItem) {
  try {
    await api(`/api/locations/${l.code}`, { method: 'PUT', body: JSON.stringify({ zone: l.zone, note: l.note }) })
    ElMessage.success(`${l.code} 已保存`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function bulkImport() {
  try {
    const res = await api<{ added: string[]; skipped: string[] }>('/api/locations/bulk', {
      method: 'POST',
      body: JSON.stringify({ text: bulkText.value }),
    })
    ElMessage.success(`新增 ${res.added.length} 个库位${res.skipped.length ? `，跳过 ${res.skipped.length} 行（重复或格式不对）` : ''}`)
    bulkText.value = ''
    loadAll()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/* ===== MES 清单导入（第一期 PDA 扫码：模号唯一码 → 物料/图号对照表） ===== */
const mesText = ref('')
const mesImporting = ref(false)
const mesResult = ref<MoImportResult | null>(null)
const mesFile = ref<HTMLInputElement | null>(null)
const moQuery = ref('')
const moRows = ref<MoMapItem[]>([])
const moTotal = ref(0)
const moMatched = ref(0)

async function importMes(body: BodyInit, contentType: string) {
  mesImporting.value = true
  try {
    const res = await fetch('/api/momap/import', { method: 'POST', headers: { 'Content-Type': contentType }, body })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || `导入失败（${res.status}）`)
    mesResult.value = data as MoImportResult
    const r = mesResult.value
    ElMessage.success(`导入完成：新增 ${r.added}、更新 ${r.updated}、未变 ${r.unchanged}、跳过 ${r.skipped}（对照表共 ${r.mapSize} 条）`)
    searchMo()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    mesImporting.value = false
  }
}
function importMesText() {
  if (!mesText.value.trim()) return ElMessage.warning('请先粘贴 MES 导出清单（含表头行）')
  importMes(JSON.stringify({ text: mesText.value }), 'application/json').then(() => {
    if (mesResult.value) mesText.value = ''
  })
}
async function onMesFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  if (!/\.xlsx$/i.test(f.name)) return ElMessage.warning('仅支持 .xlsx（旧版 .xls 请先另存为 .xlsx）')
  await importMes(await f.arrayBuffer(), 'application/octet-stream')
}
async function searchMo() {
  try {
    const r = await api<{ total: number; matched: number; items: MoMapItem[] }>(`/api/momap?q=${encodeURIComponent(moQuery.value.trim())}&limit=50`)
    moRows.value = r.items
    moTotal.value = r.total
    moMatched.value = r.matched
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
async function saveMoRow(row: MoMapItem) {
  try {
    await api(`/api/momap/${encodeURIComponent(row.code)}`, { method: 'PUT', body: JSON.stringify({ drawingNo: row.drawingNo, materialName: row.materialName, moldNo: row.moldNo }) })
    ElMessage.success(`${row.code} 已修正`)
  } catch (e) {
    ElMessage.error((e as Error).message)
    searchMo()
  }
}
async function saveMoPattern() {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ moPattern: settings.moPattern }) })
    ElMessage.success('MO 码规则已保存')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/* ===== 库位二维码标签：生成全部已启用库位的二维码，打印贴现场 ===== */
const labelSheet = ref(false)
const labelQrs = ref<Record<string, string>>({})
const labelList = computed(() => locs.value.filter((l) => l.enabled))

async function openLabels() {
  if (!labelList.value.length) return ElMessage.warning('暂无已启用的库位，请先在上方登记')
  const map: Record<string, string> = {}
  for (const l of labelList.value) {
    // 二维码内容 = 库位号本身，手机钉钉看板里「扫码」扫出即打开该库位明细
    map[l.code] = await QRCode.toDataURL(l.code, { margin: 1, width: 300, errorCorrectionLevel: 'M' })
  }
  labelQrs.value = map
  labelSheet.value = true
  document.body.classList.add('zz-label-printing')
}

function closeLabels() {
  labelSheet.value = false
  document.body.classList.remove('zz-label-printing')
}

function printLabels() {
  window.print()
}

onMounted(() => {
  loadAll()
  searchMo()
})
</script>

<template>
  <div class="panel">
    <h3>预警阈值</h3>
    <div class="toolbar">
      <span>黄色预警（停放 ≥）</span>
      <el-input-number v-model="settings.yellowDays" :min="1" :max="364" size="small" style="width: 110px" />
      <span>天　　红色预警（停放 ≥）</span>
      <el-input-number v-model="settings.redDays" :min="2" :max="365" size="small" style="width: 110px" />
      <span>天</span>
      <el-button type="primary" size="small" @click="saveSettings">保存</el-button>
    </div>
  </div>

  <div class="panel">
    <h3>库位登记</h3>
    <el-table :data="locs" size="small" border>
      <el-table-column prop="code" label="库位号" width="130" />
      <el-table-column label="区域" width="140">
        <template #default="scope">
          <el-input v-model="scope.row.zone" size="small" maxlength="20" @change="saveLoc(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="200">
        <template #default="scope">
          <el-input
            v-model="scope.row.note" size="small" maxlength="40"
            placeholder="可填位置描述，如：大件区 / 靠通道"
            @change="saveLoc(scope.row)"
          />
        </template>
      </el-table-column>
      <el-table-column label="启用" width="80" align="center">
        <template #default="scope">
          <el-switch v-model="scope.row.enabled" @change="toggleLoc(scope.row)" />
        </template>
      </el-table-column>
    </el-table>
    <div class="muted" style="margin: 8px 0 16px">区域、备注可直接在表格里修改，回车或点其他位置自动保存；停用后不可再录入该库位，历史数据保留。</div>

    <div class="toolbar">
      <el-input v-model="newLoc.code" placeholder="库位号，如 1B1-半成品" style="width: 160px" maxlength="16" />
      <el-input v-model="newLoc.zone" placeholder="区域，如 白区" style="width: 120px" maxlength="20" />
      <el-input v-model="newLoc.note" placeholder="备注（可空）" style="width: 200px" maxlength="40" />
      <el-button type="primary" plain @click="addLoc">添加</el-button>
    </div>

    <el-divider style="margin: 10px 0" />
    <div class="toolbar" style="align-items: flex-start">
      <el-input
        v-model="bulkText"
        type="textarea"
        :rows="4"
        placeholder="批量登记：每行一个，格式「库位号,区域,备注」，如&#10;1B1-半成品,白区&#10;1B3-半成品,白区,大件区"
        style="width: 360px"
      />
      <div>
        <el-button type="primary" plain @click="bulkImport">批量导入</el-button>
        <div class="muted" style="margin-top: 6px; max-width: 260px">按地上已划线的编号如实登记，区域用于看板分组显示。</div>
      </div>
    </div>

    <el-divider style="margin: 10px 0" />
    <div class="toolbar">
      <el-button type="primary" plain :icon="Printer" @click="openLabels">生成库位二维码标签</el-button>
      <span class="muted">生成全部已启用库位的二维码标签页，打印裁开后贴到现场库位；手机钉钉里扫一下即开该库位明细。</span>
    </div>
  </div>

  <div class="panel">
    <h3>MES 清单导入（PDA 扫码 · 模号唯一码对照表）</h3>
    <div class="muted" style="margin-bottom: 10px">
      MES 二维码扫出的是「模号唯一码」（一码一件），这里导入 MES 导出清单建立 码 → 物料编号/名称/图号/模号 对照，PDA 扫码即带出物料信息。
      按表头名识别列（至少需「模号唯一码」「物料图号」），同码覆盖更新；可直接从 MES/Excel 复制整表（含表头行）粘贴。
    </div>
    <div class="toolbar" style="align-items: flex-start">
      <el-input
        v-model="mesText"
        type="textarea"
        :rows="5"
        placeholder="粘贴 MES 导出清单（制表符分隔，含表头）：&#10;模号唯一码	年度	月份	…	物料编号	物料名称	物料图号	模号	单据编号	…&#10;MO261121000001	2026	11	…	A000717	左壳体	92056593(6545、6563)	R137	…"
        style="width: 520px; max-width: 100%"
      />
      <div style="display: flex; flex-direction: column; gap: 8px">
        <el-button type="primary" :loading="mesImporting" @click="importMesText">导入粘贴内容</el-button>
        <el-button :loading="mesImporting" @click="mesFile?.click()">上传 xlsx</el-button>
        <input ref="mesFile" type="file" accept=".xlsx" style="display: none" @change="onMesFile" />
      </div>
    </div>
    <el-alert
      v-if="mesResult" :type="mesResult.skipped ? 'warning' : 'success'" :closable="false" show-icon style="margin-bottom: 10px"
      :title="`共 ${mesResult.total} 行：新增 ${mesResult.added}、更新 ${mesResult.updated}、未变 ${mesResult.unchanged}、跳过 ${mesResult.skipped}；对照表现有 ${mesResult.mapSize} 条`"
    >
      <div v-for="r in mesResult.skippedRows.slice(0, 10)" :key="r.row">第 {{ r.row }} 行 {{ r.code || '（空）' }}：{{ r.reason }}</div>
    </el-alert>

    <div class="toolbar">
      <el-input v-model="moQuery" placeholder="查询：MO 码 / 物料编号 / 名称 / 图号 / 模号 / 单据编号" clearable style="width: 360px" @keydown.enter="searchMo" @clear="searchMo" />
      <el-button @click="searchMo">查询</el-button>
      <span class="muted">对照表共 {{ moTotal }} 条{{ moQuery ? `，匹配 ${moMatched} 条` : '' }}（最多显示 50 条；图号/名称/模号可直接改，回车保存）</span>
    </div>
    <el-table :data="moRows" size="small" border max-height="360">
      <el-table-column prop="code" label="模号唯一码" width="160" />
      <el-table-column prop="materialNo" label="物料编号" width="100" />
      <el-table-column label="物料名称" min-width="120">
        <template #default="scope"><el-input v-model="scope.row.materialName" size="small" @change="saveMoRow(scope.row)" /></template>
      </el-table-column>
      <el-table-column label="物料图号" min-width="170">
        <template #default="scope"><el-input v-model="scope.row.drawingNo" size="small" @change="saveMoRow(scope.row)" /></template>
      </el-table-column>
      <el-table-column label="模号" width="100">
        <template #default="scope"><el-input v-model="scope.row.moldNo" size="small" @change="saveMoRow(scope.row)" /></template>
      </el-table-column>
      <el-table-column prop="docNo" label="单据编号" width="130" />
      <el-table-column label="在库" width="110">
        <template #default="scope">{{ scope.row.stock ? scope.row.stock.location : '—' }}</template>
      </el-table-column>
    </el-table>

    <el-divider style="margin: 12px 0" />
    <div class="toolbar">
      <span>MO 码规则（正则）</span>
      <el-input v-model="settings.moPattern" style="width: 200px" size="small" />
      <el-button size="small" type="primary" plain @click="saveMoPattern">保存</el-button>
      <span class="muted">默认 ^MO\d{12}$（如 MO261121000005）。扫码内容命中库位号 → 库位；符合此规则 → MO 码；其余按产品图号处理。PDA 录入页：<a href="#pda">#pda</a></span>
    </div>
  </div>

  <div class="panel">
    <h3>钉钉同步（录入端）</h3>
    <el-alert
      v-if="dtStatus && !dtStatus.configured"
      type="info" :closable="false" show-icon style="margin-bottom: 12px"
      :title="`配置尚不完整（缺：${dtStatus.missing.join('、')}）。补全后：一线在钉钉 AI 表格记流水，本系统自动拉取入账。`"
    />
    <el-form label-width="130px">
      <el-form-item label="AppKey">
        <el-input v-model="dt.appKey" style="width: 320px" placeholder="钉钉开放平台 - 应用详情 - 凭证与基础信息" />
      </el-form-item>
      <el-form-item label="AppSecret">
        <el-input v-model="dt.appSecret" type="password" show-password style="width: 320px" placeholder="与 AppKey 同一页面" />
      </el-form-item>
      <el-form-item label="操作人 unionId">
        <el-input v-model="dt.operatorId" style="width: 320px" placeholder="操作人 unionId（不是 userId）" />
      </el-form-item>
      <el-form-item label="表格 baseId">
        <el-input v-model="dt.baseId" style="width: 320px" placeholder="AI 表格 URL 中 drInstanceId= 后面的串" />
      </el-form-item>
      <el-form-item label="流水表名">
        <el-input v-model="dt.sheet" style="width: 320px" placeholder="如 中转库流水" />
      </el-form-item>
      <el-form-item label="企业 CorpId">
        <el-input v-model="dt.corpId" style="width: 320px" placeholder="手机扫码用；钉钉管理后台-企业信息-企业 CorpId" />
      </el-form-item>
      <el-form-item label="应用 AgentId">
        <el-input v-model="dt.agentId" style="width: 320px" placeholder="手机扫码用；开放平台-应用详情-应用 AgentId" />
      </el-form-item>
      <el-form-item label="自动同步间隔">
        <el-input-number v-model="dt.autoSyncMinutes" :min="0" :max="60" size="small" style="width: 110px" controls-position="right" />
        <span class="muted" style="margin-left: 10px">分钟；0 = 关闭自动同步（只手动同步）</span>
      </el-form-item>
      <el-form-item label="以钉钉为准">
        <el-switch v-model="dt.mirror" />
        <span class="muted" style="margin-left: 10px">镜像模式：每次同步后看板与钉钉表格完全对齐——表格里删行/改行，看板即时跟着变（默认开启）</span>
      </el-form-item>
      <el-form-item label="锁定录入人">
        <el-switch v-model="dt.lockRecorder" />
        <span class="muted" style="margin-left: 10px">严格模式：录入人锁定为钉钉身份——在钉钉内打开看板自动免登署名、不可手填；<b>普通浏览器将无法记一笔</b>（电脑端请用钉钉客户端打开）</span>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="saveDt">保存配置</el-button>
        <el-button :loading="dtSyncing" @click="syncNow()">立即同步</el-button>
      </el-form-item>
    </el-form>
    <div v-if="dtStatus?.status.lastSyncAt" class="muted">
      上次同步 {{ dtStatus.status.lastSyncAt.slice(0, 16).replace('T', ' ') }} · 表格 {{ dtStatus.status.total }} 行 · 本次新增 {{ dtStatus.status.added }} 笔 · 累计入账 {{ dtStatus.status.totalAdded }} 笔<span v-if="dtStatus.status.skippedCount"> · 跳过 {{ dtStatus.status.skippedCount }} 行</span><span v-if="dtStatus.status.lastError" style="color: #f56c6c"> · 最近错误：{{ dtStatus.status.lastError }}</span>
    </div>
    <el-table v-if="dtSkipped.length" :data="dtSkipped" size="small" border style="margin-top: 10px">
      <el-table-column prop="id" label="钉钉行ID" width="240" />
      <el-table-column prop="reason" label="跳过原因" min-width="280" />
    </el-table>
    <div class="muted" style="margin-top: 8px">口径：同步按钉钉行ID去重（重复点同步不会重复入账）；入库未填批次号时按操作时间自动生成；在钉钉里删除行不会回滚本地台账（只追加）。</div>
    <el-alert
      :type="dtStatus?.scanReady ? 'success' : 'info'" :closable="false" show-icon style="margin-top: 12px"
      :title="dtStatus?.scanReady
        ? '手机扫码已就绪：在手机钉钉中打开看板（工作台入口或钉钉内链接），即可用「扫码」按钮扫库位码/产品条码（看板查询、记一笔填充、产品查询）。'
        : '手机扫码（可选）：补全上方「企业 CorpId + 应用 AgentId」后，手机钉钉内即可用「扫码」按钮——扫库位二维码看明细、扫产品条码查库存、记一笔表单扫码填充；不填不影响同步功能。'"
    />
  </div>

  <div class="panel">
    <h3>台账审计（最近记一笔）</h3>
    <el-table :data="audit" size="small" border>
      <el-table-column prop="seq" label="#" width="70" />
      <el-table-column prop="date" label="日期" width="110" />
      <el-table-column prop="type" label="类型" width="90" align="center">
        <template #default="scope">
          <el-tag
            :type="scope.row.type === '入库' ? 'success' : scope.row.type === '出库' ? 'danger' : scope.row.type === '转移' ? 'warning' : 'info'"
            size="small" effect="light" disable-transitions
          >{{ scope.row.type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="summary" label="内容" min-width="220" />
      <el-table-column prop="recorder" label="录入人" width="110" />
      <el-table-column prop="at" label="操作时间" width="140" />
    </el-table>
    <div class="muted" style="margin-top: 8px">台账只追加不修改，每笔带序号永久留档（backend/data/snapshots.jsonl）；库存=流水重放结果，随时可审计。</div>
  </div>

  <!-- 库位二维码标签页（全屏覆盖；打印时只输出标签） -->
  <div v-if="labelSheet" class="label-sheet-overlay">
    <div class="label-sheet-toolbar">
      <el-button type="primary" @click="printLabels">打印</el-button>
      <el-button @click="closeLabels">关闭</el-button>
      <span class="muted">共 {{ labelList.length }} 个已启用库位 · 二维码内容=库位号 · 沿虚线裁开贴到现场库位（不干胶纸最佳）</span>
    </div>
    <div class="label-sheet">
      <div v-for="l in labelList" :key="l.code" class="label-card">
        <img :src="labelQrs[l.code]" :alt="l.code" />
        <div class="label-code">{{ l.code }}</div>
        <div class="label-zone">{{ l.zone || '未分区' }}{{ l.note ? ' · ' + l.note : '' }}</div>
      </div>
    </div>
  </div>
</template>
