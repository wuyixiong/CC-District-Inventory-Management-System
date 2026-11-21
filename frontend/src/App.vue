<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import dayjs from 'dayjs'
import Board from './views/Board.vue'
import SettingsView from './views/Settings.vue'
import Doc from './views/Doc.vue'
import Pda from './views/Pda.vue'

const tabs = [
  { key: 'board', label: '看板' },
  { key: 'settings', label: '设置' },
  { key: 'pda', label: 'PDA录入' },
  { key: 'doc', label: '操作指导' },
]
// #pda 直达 PDA 扫码录入页（PDA 浏览器首页/书签配 http://内网IP:8792/#pda）
const tabFromHash = () => (location.hash.replace('#', '').startsWith('pda') ? 'pda' : null)
const tab = ref(tabFromHash() ?? 'board')
watch(tab, (t) => {
  if (t === 'pda' && !location.hash.startsWith('#pda')) history.replaceState(null, '', '#pda')
  else if (t !== 'pda' && location.hash.startsWith('#pda')) history.replaceState(null, '', location.pathname + location.search)
})
const onHash = () => {
  const t = tabFromHash()
  if (t) tab.value = t
}

const lastText = ref('') // 顶栏时间文本（钉钉模式=同步时间，本地模式=台账最后一笔）
const lastRaw = ref('')
const syncMode = ref(false)
const settings = ref({ yellowDays: 3, redDays: 5 })
const today = dayjs().format('YYYY-MM-DD')
// 钉钉模式：距上次同步超 10 分钟视为过期；本地模式：最后记一笔不在今天视为过期
const isStale = computed(
  () =>
    !!lastRaw.value &&
    (syncMode.value ? dayjs().diff(dayjs(lastRaw.value), 'minute') > 10 : lastRaw.value.slice(0, 10) !== today),
)

let timer: ReturnType<typeof setInterval> | null = null
async function loadMeta() {
  let ledgerLast = ''
  try {
    const j = await (await fetch('/api/state')).json()
    if (j.settings) settings.value = j.settings
    ledgerLast = j.board?.lastAt ?? ''
  } catch {
    /* 服务暂不可用时不更新 */
  }
  try {
    const st = await (await fetch('/api/dingtalk/status')).json()
    if (st.configured && st.status?.lastSyncAt) {
      syncMode.value = true
      lastRaw.value = st.status.lastSyncAt
      lastText.value = `数据同步于 ${dayjs(st.status.lastSyncAt).format('YYYY-MM-DD HH:mm')}`
      return
    }
  } catch {
    /* 钉钉状态不可用时退回台账时间 */
  }
  syncMode.value = false
  lastRaw.value = ledgerLast
  lastText.value = ledgerLast ? `数据更新于 ${ledgerLast}` : ''
}
onMounted(() => {
  loadMeta()
  timer = setInterval(loadMeta, 30_000)
  // 看板「同步最新数据」完成后立即刷新顶栏时间
  window.addEventListener('zz:synced', loadMeta)
  window.addEventListener('hashchange', onHash)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('zz:synced', loadMeta)
  window.removeEventListener('hashchange', onHash)
})
</script>

<template>
  <header class="app-header">
    <div class="brand">白区库存管理 <span class="sub">· 库位看板</span></div>
    <template v-if="tab !== 'pda'">
    <span class="zone-parking-legend-chip legend-green">正常（&lt; {{ settings.yellowDays }} 天）</span>
    <span class="zone-parking-legend-chip legend-yellow">预警（≥ {{ settings.yellowDays }} 天）</span>
    <span class="zone-parking-legend-chip legend-red">严重（≥ {{ settings.redDays }} 天）</span>
    <span class="zone-parking-legend-chip legend-empty">空库位</span>
    <span class="zone-parking-legend-chip legend-hint">格内数字 = 批次件数，悬停看明细，点击库位看全部批次</span>
    </template>
    <span v-if="lastText && tab !== 'pda'" class="sync-status-indicator" :class="{ 'sync-status-stale': isStale }">{{ lastText }}</span>
    <nav class="nav">
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="tab = t.key">
        {{ t.label }}
      </button>
    </nav>
  </header>
  <main class="app-main">
    <Board v-if="tab === 'board'" />
    <SettingsView v-else-if="tab === 'settings'" />
    <Pda v-else-if="tab === 'pda'" />
    <Doc v-else />
  </main>
</template>
