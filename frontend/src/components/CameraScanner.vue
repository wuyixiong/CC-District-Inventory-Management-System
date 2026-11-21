<script setup lang="ts">
/**
 * 手机摄像头扫码（连续模式）：默认后置摄像头，支持二维码 + Code128/Code39/EAN 等一维码。
 * 每识别一个码 emit('scan', text)；同码 2 秒内去抖；识别成功震动。html5-qrcode 按需动态加载，不影响首屏。
 * 需安全上下文（https 或 localhost），否则浏览器不给摄像头。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Html5Qrcode } from 'html5-qrcode'

const props = defineProps<{ paused?: boolean }>()
const emit = defineEmits<{ scan: [text: string]; close: [] }>()

const elId = `cam-scan-${Math.random().toString(36).slice(2, 8)}`
const status = ref<'loading' | 'running' | 'error'>('loading')
const errText = ref('')
const torchSupported = ref(false)
const torchOn = ref(false)
let scanner: Html5Qrcode | null = null
let stopped = false
const lastSeen = new Map<string, number>()

function describe(e: unknown): string {
  const name = (e as { name?: string })?.name ?? ''
  const msg = String((e as { message?: string })?.message ?? e ?? '')
  if (/NotAllowed|Permission/i.test(name + msg)) return '摄像头权限被拒绝：请在浏览器地址栏/系统设置中允许本网站使用摄像头后重试'
  if (/NotFound|DevicesNotFound|Requested device not found/i.test(name + msg)) return '没有找到可用的摄像头'
  if (/NotReadable|TrackStart|Could not start/i.test(name + msg)) return '摄像头被其它应用占用，请关闭其它使用摄像头的应用后重试'
  if (/secure|https/i.test(msg)) return '需用 https 地址打开本页面才能使用摄像头'
  return `摄像头启动失败：${msg || name || '未知错误'}`
}

function onDecoded(text: string) {
  if (props.paused) return
  const code = text.trim()
  if (!code) return
  const now = Date.now()
  const prev = lastSeen.get(code)
  if (prev && now - prev < 2000) return // 同码 2 秒内去抖
  lastSeen.set(code, now)
  for (const [k, t] of lastSeen) if (now - t > 10000) lastSeen.delete(k)
  try {
    navigator.vibrate?.(80)
  } catch {
    /* 不支持震动时忽略 */
  }
  emit('scan', code)
}

onMounted(async () => {
  try {
    const mod = await import('html5-qrcode')
    if (stopped) return
    const F = mod.Html5QrcodeSupportedFormats
    scanner = new mod.Html5Qrcode(elId, {
      verbose: false,
      formatsToSupport: [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    })
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        // 对准框：宽扁矩形，兼顾一维码与二维码
        qrbox: (w: number, h: number) => {
          const bw = Math.max(160, Math.floor(w * 0.82))
          const bh = Math.max(120, Math.floor(Math.min(h * 0.6, bw * 0.75)))
          return { width: bw, height: bh }
        },
        disableFlip: true,
      },
      onDecoded,
      () => undefined,
    )
    if (stopped) return void stopScanner()
    status.value = 'running'
    try {
      const torch = scanner.getRunningTrackCameraCapabilities().torchFeature()
      torchSupported.value = torch.isSupported()
    } catch {
      torchSupported.value = false
    }
  } catch (e) {
    status.value = 'error'
    errText.value = describe(e)
  }
})

async function toggleTorch() {
  if (!scanner) return
  try {
    const torch = scanner.getRunningTrackCameraCapabilities().torchFeature()
    await torch.apply(!torchOn.value)
    torchOn.value = !torchOn.value
  } catch {
    torchSupported.value = false
  }
}

async function stopScanner() {
  const s = scanner
  scanner = null
  if (!s) return
  try {
    if (s.isScanning) await s.stop()
    s.clear()
  } catch {
    /* 已停止 */
  }
}

onBeforeUnmount(() => {
  stopped = true
  void stopScanner()
})
</script>

<template>
  <div class="cam">
    <div :id="elId" class="cam-view" />
    <div v-if="status === 'loading'" class="cam-tip">正在打开摄像头…（首次使用请点「允许」）</div>
    <div v-else-if="status === 'error'" class="cam-tip cam-err">{{ errText }}</div>
    <div v-if="paused && status === 'running'" class="cam-tip cam-pause">已暂停：请先在弹窗中完成选择</div>
    <div class="cam-bar">
      <span class="cam-hint">{{ status === 'running' ? '对准条码/二维码，扫到自动加入，可连续扫' : '' }}</span>
      <button v-if="torchSupported" class="cam-btn" :class="{ on: torchOn }" @click="toggleTorch">🔦 {{ torchOn ? '关灯' : '手电筒' }}</button>
      <button class="cam-btn cam-stop" @click="emit('close')">■ 停止扫码</button>
    </div>
  </div>
</template>

<style scoped>
.cam { position: relative; background: #000; border-radius: 10px; overflow: hidden; }
.cam-view { width: 100%; min-height: 220px; }
.cam-view :deep(video) { width: 100% !important; max-height: 46vh; object-fit: cover; display: block; }
.cam-tip {
  position: absolute; left: 0; right: 0; top: 40%; padding: 0 16px; text-align: center;
  color: #fff; font-size: 17px; line-height: 1.5; text-shadow: 0 1px 2px #000;
}
.cam-err { color: #ffb4ab; top: 30%; }
.cam-pause { top: 12px; background: rgba(230, 162, 60, 0.9); padding: 8px; }
.cam-bar { display: flex; align-items: center; gap: 8px; padding: 8px; background: #1d1e1f; }
.cam-hint { flex: 1; color: #c0c4cc; font-size: 14px; }
.cam-btn { height: 48px; padding: 0 14px; font-size: 18px; border-radius: 8px; border: 1px solid #4c4d4f; background: #303133; color: #fff; cursor: pointer; }
.cam-btn.on { background: #e6a23c; border-color: #e6a23c; }
.cam-stop { background: #e05a4f; border-color: #e05a4f; font-weight: 700; }
</style>
