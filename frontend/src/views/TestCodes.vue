<script setup lang="ts">
/**
 * 扫码测试码页（#testcodes）：在电脑屏幕上显示大二维码，另一台手机打开 https://电脑IP:HTTPS端口/#pda 用摄像头扫屏幕测试。
 * 内容：已登记启用库位（默认前 12 个，可展开）、已导入 MO 码（带物料名称/图号/模号）；
 * 对照表为空时显示样例 MO261121000001~08 并可一键导入样例；另放一个未导入码 MO261121999999 测试「未导入」流程。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { api } from '../api'
import type { LocationItem, MoImportResult, MoMapItem } from '../types'

interface SampleMo {
  code: string
  materialNo: string
  materialName: string
  drawingNo: string
  moldNo: string
  docNo: string
}

/** 样例 MES 清单：前 4 条 A000717 左壳体，后 4 条 A000264 中间箱体 */
const SAMPLE: SampleMo[] = [
  ...[137, 138, 139, 140].map((m, i) => ({
    code: `MO26112100000${i + 1}`,
    materialNo: 'A000717',
    materialName: '左壳体',
    drawingNo: '92056593(6545、6563)',
    moldNo: `R${m}`,
    docNo: '',
  })),
  ...[131, 132, 133, 134].map((m, i) => ({
    code: `MO26112100000${i + 5}`,
    materialNo: 'A000264',
    materialName: '中间箱体',
    drawingNo: '4570H5',
    moldNo: `R${m}`,
    docNo: 'BC2611210001',
  })),
]
const UNIMPORTED = 'MO261121999999'
const LOC_PREVIEW = 12

const loading = ref(true)
const importing = ref(false)
const locs = ref<LocationItem[]>([])
const mos = ref<MoMapItem[]>([])
const moTotal = ref(0)
const showAllLocs = ref(false)
const qrs = ref<Record<string, string>>({})
const server = ref<{ httpPort: number; httpsPort: number | null; lan: string[] } | null>(null)

const enabledLocs = computed(() => locs.value.filter((l) => l.enabled))
const shownLocs = computed(() => (showAllLocs.value ? enabledLocs.value : enabledLocs.value.slice(0, LOC_PREVIEW)))
const mapEmpty = computed(() => moTotal.value === 0)
const pdaUrls = computed(() => {
  const s = server.value
  const port = s?.httpsPort ? String(s.httpsPort) : 'HTTPS端口'
  const ips = s?.lan.length ? s.lan : ['电脑IP']
  return ips.map((ip) => `https://${ip}:${port}/#pda`)
})

async function qr(text: string) {
  if (!qrs.value[text]) {
    qrs.value[text] = await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
  }
}

async function load() {
  loading.value = true
  try {
    const [l, m, s] = await Promise.all([
      api<{ locations: LocationItem[] }>('/api/locations'),
      api<{ total: number; items: MoMapItem[] }>('/api/momap?limit=200'),
      api<{ httpPort: number; httpsPort: number | null; lan: string[] }>('/api/server-info').catch(() => null),
    ])
    locs.value = l.locations
    mos.value = [...m.items].sort((a, b) => a.code.localeCompare(b.code))
    moTotal.value = m.total
    server.value = s
    const codes = [
      ...enabledLocs.value.map((x) => x.code),
      ...(mapEmpty.value ? SAMPLE.map((x) => x.code) : mos.value.map((x) => x.code)),
      UNIMPORTED,
    ]
    for (const c of codes) await qr(c)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

async function importSample() {
  const head = ['模号唯一码', '物料编号', '物料名称', '物料图号', '模号', '单据编号'].join('\t')
  const lines = SAMPLE.map((s) => [s.code, s.materialNo, s.materialName, s.drawingNo, s.moldNo, s.docNo].join('\t'))
  importing.value = true
  try {
    const r = await api<MoImportResult>('/api/momap/import', { method: 'POST', body: JSON.stringify({ text: [head, ...lines].join('\n') }) })
    ElMessage.success(`样例导入完成：新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}（对照表共 ${r.mapSize} 条）`)
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    importing.value = false
  }
}

function back() {
  window.dispatchEvent(new CustomEvent('zz:tab', { detail: 'settings' }))
}

onMounted(load)
</script>

<template>
  <div class="panel tc-intro">
    <div class="tc-head">
      <h3>扫码测试码</h3>
      <el-button size="small" @click="back">← 返回设置</el-button>
      <el-button size="small" @click="load">刷新</el-button>
    </div>
    <div class="tc-steps">
      用另一台手机测试摄像头扫码：手机连同一局域网，浏览器打开
      <b v-for="u in pdaUrls" :key="u" class="tc-url">{{ u }}</b>
      ，点「📷 摄像头扫码」，对准下面屏幕上的二维码。
      <span v-if="server && !server.httpsPort" class="tc-warn">（当前服务未开启 HTTPS：请设置 HTTPS_PORT 后重启服务，见部署手册「摄像头扫码测试」）</span>
    </div>
    <div class="muted">
      首次打开提示证书不安全时点「高级 → 继续访问」（iPhone：显示详细信息 → 访问此网站），再允许使用摄像头。建议先扫一个库位码，再扫 MO 码；屏幕调亮、二维码放大，手机离屏幕 20~40 cm。
    </div>
  </div>

  <div v-if="loading" class="panel muted">加载中…</div>
  <template v-else>
    <div class="panel">
      <h3>库位码（已登记启用 {{ enabledLocs.length }} 个）</h3>
      <div v-if="!enabledLocs.length" class="muted">暂无已启用的库位，请先在「设置 → 库位登记」登记。</div>
      <div class="tc-grid">
        <div v-for="l in shownLocs" :key="l.code" class="tc-card">
          <img :src="qrs[l.code]" :alt="l.code" />
          <div class="tc-code">{{ l.code }}</div>
          <div class="tc-sub">{{ [l.zone, l.note].filter(Boolean).join(' · ') || '库位' }}</div>
        </div>
      </div>
      <div v-if="enabledLocs.length > LOC_PREVIEW" style="margin-top: 12px">
        <el-button size="small" @click="showAllLocs = !showAllLocs">
          {{ showAllLocs ? '收起' : `展开全部 ${enabledLocs.length} 个库位` }}
        </el-button>
      </div>
    </div>

    <div class="panel">
      <h3 v-if="!mapEmpty">MO 码（已导入 {{ moTotal }} 条{{ moTotal > mos.length ? `，显示前 ${mos.length} 条` : '' }}）</h3>
      <template v-else>
        <h3>MO 码（对照表为空 · 以下为样例）</h3>
        <div class="toolbar">
          <el-button type="primary" :loading="importing" @click="importSample">一键导入样例数据</el-button>
          <span class="muted">导入下面 8 条样例到 MES 对照表（不影响库存台账），导入后扫码可带出物料名称/图号/模号。</span>
        </div>
      </template>
      <div class="tc-grid">
        <div v-for="m in mapEmpty ? SAMPLE : mos" :key="m.code" class="tc-card">
          <img :src="qrs[m.code]" :alt="m.code" />
          <div class="tc-code">{{ m.code }}</div>
          <div class="tc-sub">{{ m.materialName || '—' }}</div>
          <div class="tc-sub">图号 {{ m.drawingNo || '—' }} · 模号 {{ m.moldNo || '—' }}</div>
          <div v-if="'stock' in m && m.stock" class="tc-sub tc-in">在库：{{ m.stock.location }}</div>
          <div v-if="mapEmpty" class="tc-sub tc-warn">样例 · 未导入</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>未导入码（测试「未导入」提示）</h3>
      <div class="tc-grid">
        <div class="tc-card">
          <img :src="qrs[UNIMPORTED]" :alt="UNIMPORTED" />
          <div class="tc-code">{{ UNIMPORTED }}</div>
          <div class="tc-sub tc-warn">不在对照表中，扫后应提示未导入并要求选图号</div>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.tc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.tc-head h3 { margin: 0 auto 0 0; }
.tc-steps { font-size: 16px; line-height: 1.8; margin-bottom: 6px; }
.tc-url { display: inline-block; margin: 0 6px; padding: 0 8px; border-radius: 6px; background: #ecf5ff; color: #337ecc; font-family: monospace; word-break: break-all; }
.tc-warn { color: #e6a23c; }
.tc-in { color: #67c23a; }
.tc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.tc-card { border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 10px; padding: 14px; text-align: center; background: #fff; }
.tc-card img { width: 100%; max-width: 280px; aspect-ratio: 1; image-rendering: pixelated; display: block; margin: 0 auto 8px; }
.tc-code { font-size: 20px; font-weight: 700; font-family: monospace; color: #303133; word-break: break-all; }
.tc-sub { font-size: 13px; color: #606266; margin-top: 2px; word-break: break-all; }
</style>
