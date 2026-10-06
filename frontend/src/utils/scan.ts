/**
 * 钉钉扫码（手机摄像头，dd.scanCode 原生扫码）
 *
 * 依赖：设置页钉钉配置中的 CorpId + AgentId（后端 /api/dingtalk/jsapi-sign 按钉钉规则签名）。
 * 签名与页面 URL 严格绑定，SPA 只在首次调用时 config 一次；失败自动丢弃缓存下次重试。
 */
import { api } from '../api'

export function inDingtalk(): boolean {
  return /dingtalk/i.test(navigator.userAgent)
}

interface SignResp {
  agentId: string
  corpId: string
  timeStamp: string
  nonceStr: string
  signature: string
}

let ddConfigured: Promise<any> | null = null

function ensureDdConfig(): Promise<any> {
  if (!ddConfigured) {
    ddConfigured = (async () => {
      const dd = (await import('dingtalk-jsapi')).default
      // 签名 URL 取当前地址去掉 # 及其后（钉钉要求与 config 时页面 URL 完全一致）
      const url = location.href.split('#')[0]
      const sign = await api<SignResp>(`/api/dingtalk/jsapi-sign?url=${encodeURIComponent(url)}`)
      return new Promise((resolve, reject) => {
        let failed: Error | null = null
        dd.error((err: any) => {
          failed = new Error(`钉钉鉴权失败：${err?.errorMessage || err?.message || JSON.stringify(err)}（排查：设置页 CorpId/AgentId 是否正确、应用是否已发布）`)
          reject(failed)
        })
        dd.config({
          type: 0, // 企业内部应用
          corpId: sign.corpId,
          agentId: sign.agentId,
          timeStamp: sign.timeStamp,
          nonceStr: sign.nonceStr,
          signature: sign.signature,
          jsApiList: ['biz.util.scan'],
        })
        dd.ready(() => {
          // dd.ready 与 dd.error 可能都触发，鉴权失败时以 error 为准
          if (failed) return
          resolve(dd)
        })
        // 钉钉容器异常时 ready/error 都不回调，兜底超时
        setTimeout(() => reject(new Error('钉钉鉴权无响应，请退出页面重进再试')), 8000)
      })
    })().catch((e) => {
      ddConfigured = null // 允许下次重试（如配置补全后）
      throw e
    })
  }
  return ddConfigured
}

/** 调起钉钉原生扫码，返回码内容文本；不在钉钉内/未配置时抛带提示的错误 */
export async function scanCode(): Promise<string> {
  if (!inDingtalk()) throw new Error('扫码仅支持手机钉钉内使用：请从钉钉工作台打开本看板后再扫码')
  const dd = await ensureDdConfig()
  return new Promise((resolve, reject) => {
    const fail = (err: any) => reject(new Error(err?.errorMessage || err?.message || '扫码失败'))
    // 官方标准写法：dd.biz.util.scan（onSuccess 回调取 data.text）；预留新版 dd.scanCode
    if (dd.biz?.util?.scan) {
      dd.biz.util.scan({
        type: 'all', // 二维码 + 条形码
        onSuccess: (data: any) => resolve(String(data?.text ?? data?.code ?? '').trim()),
        onFail: fail,
      })
    } else if (typeof dd.scanCode === 'function') {
      dd.scanCode({
        type: 'all',
        success: (res: any) => resolve(String(res?.text ?? res?.code ?? res?.result ?? '').trim()),
        fail,
      })
    } else {
      reject(new Error('当前钉钉版本过低，不支持扫码（请升级钉钉）'))
    }
  })
}
