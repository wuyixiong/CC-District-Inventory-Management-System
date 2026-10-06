/**
 * 钉钉免登（录入人锁定严格模式）
 *
 * 流程：钉钉容器内 dd.runtime.permission.requestAuthCode 拿一次性 authCode（免 config 签名，
 * 与扫码的 dd.config 鉴权相互独立）→ POST /api/dingtalk/login 换钉钉姓名 + 12 小时会话 token。
 * 记一笔时带 x-user-token 头，后端只认 token 里验证过的姓名。
 */
import { api } from '../api'
import { inDingtalk } from './scan'

export interface DtIdentity {
  name: string
  token: string
}

export async function dingtalkLogin(): Promise<DtIdentity> {
  if (!inDingtalk()) throw new Error('仅在钉钉内打开看板才能自动登录')
  const st = await api<{ config: { corpId: string } }>('/api/dingtalk/status')
  const corpId = st.config?.corpId
  if (!corpId) throw new Error('未配置企业 CorpId，请到「设置」页钉钉配置中补全')
  const dd = (await import('dingtalk-jsapi')).default
  const code = await new Promise<string>((resolve, reject) => {
    dd.runtime.permission.requestAuthCode({
      corpId,
      onSuccess: (r: any) => resolve(String(r?.code ?? '')),
      onFail: (err: any) => reject(new Error(err?.errorMessage || err?.message || '获取免登码失败')),
    })
  })
  if (!code) throw new Error('钉钉未返回免登码，请重试')
  return api<DtIdentity>('/api/dingtalk/login', { method: 'POST', body: JSON.stringify({ authCode: code }) })
}
