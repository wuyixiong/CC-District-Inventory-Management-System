/**
 * 钉钉 AI 表格(Notable)同步客户端 —— 录入端对接。
 *
 * 约定移植自白区看板 server/钉钉客户端.py(真实环境验证过,勿凭猜测修改):
 * - 换 token:POST /v1.0/oauth2/accessToken,body {appKey, appSecret};
 * - 业务接口前缀必须是 /v1.0/notable/bases/{baseId}/sheets/...(用 /v1.0/aiTable/... 会报 InvalidVersion);
 * - 业务接口强制 Header x-acs-dingtalk-access-token + Query operatorId={unionId};
 * - 记录读取:POST .../records/list,body {maxResults, nextToken},返回 {records, nextToken, hasMore};
 * - 单选字段读取时是 {name, id} 对象,取 name;日期字段是毫秒时间戳;
 * - 钉钉偶发 HTTP 500 数秒自愈,读取自动重试。
 *
 * 同步策略:全量拉表 → 增量入账(逐笔留审计) + 镜像校准(以钉钉表格当前状态对齐看板)。
 * 幂等:重复同步不会重复入账;镜像模式下钉钉里删行/改行会在下一次同步后于看板生效。
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { appendMirrorEvent, appendTxnEvent, readLedger, readLocations, writeLocations, type LocationItem, type TxnKind } from './store'
import { replayState } from './compute'

export interface DingConfig {
  appKey: string
  appSecret: string
  operatorId: string
  baseId: string
  sheet: string
  autoSyncMinutes: number
  mirror: boolean // 镜像模式：每次同步后看板与钉钉表格完全对齐（删行/改行即时生效）
  corpId: string // 企业 CorpId（手机钉钉内扫码 JSAPI 鉴权用）
  agentId: string // 应用 AgentId（同上）
  lockRecorder: boolean // 录入人锁定为钉钉身份（严格模式：记一笔必须钉钉免登，后端只认已验证姓名）
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const CONF_FILE = path.join(DATA_DIR, 'dingtalk.json')
const STATUS_FILE = path.join(DATA_DIR, 'dingtalk-status.json')
const HOST = 'https://api.dingtalk.com'
const DEFAULT_CONFIG: DingConfig = {
  appKey: '',
  appSecret: '',
  operatorId: '',
  baseId: '',
  sheet: '中转库流水',
  autoSyncMinutes: 2,
  mirror: true,
  corpId: '',
  agentId: '',
  lockRecorder: false,
}

export function readConfig(): DingConfig {
  if (!fs.existsSync(CONF_FILE)) return { ...DEFAULT_CONFIG }
  try {
    const c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))
    const n = Number(c.autoSyncMinutes)
    return {
      appKey: String(c.appKey ?? '').trim(),
      appSecret: String(c.appSecret ?? '').trim(),
      operatorId: String(c.operatorId ?? '').trim(),
      baseId: normalizeBaseId(String(c.baseId ?? '')),
      sheet: String(c.sheet ?? DEFAULT_CONFIG.sheet).trim() || DEFAULT_CONFIG.sheet,
      autoSyncMinutes: Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : DEFAULT_CONFIG.autoSyncMinutes,
      mirror: c.mirror !== false,
      corpId: String(c.corpId ?? '').trim(),
      agentId: String(c.agentId ?? '').trim(),
      lockRecorder: c.lockRecorder === true,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(c: DingConfig) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONF_FILE, JSON.stringify({ ...c, baseId: normalizeBaseId(c.baseId) }, null, 2), 'utf8')
}

/** baseId 容错：直接粘贴表格完整 URL 也能识别（提取 drInstanceId=/baseId=/dtableId= 参数） */
export function normalizeBaseId(input: string): string {
  const s = String(input ?? '').trim()
  if (!s) return ''
  const m = s.match(/(?:drInstanceId|baseId|dtableId)=([A-Za-z0-9_-]+)/)
  return m ? m[1] : s
}

export function configState() {
  const c = readConfig()
  const missing = (['appKey', 'appSecret', 'operatorId', 'baseId'] as const).filter((k) => !c[k])
  // 扫码（JSAPI）只依赖凭证四件套：CorpId + AgentId + AppKey/AppSecret，与同步配置相互独立
  const scanMissing = (['corpId', 'agentId', 'appKey', 'appSecret'] as const).filter((k) => !c[k])
  return {
    configured: missing.length === 0,
    missing: [...missing],
    scanReady: scanMissing.length === 0,
    config: { ...c, appSecret: c.appSecret ? '***' : '' },
  }
}

interface SyncStatusFile {
  lastSyncAt: string
  total: number
  added: number
  totalAdded: number
  skippedCount: number
  lastError: string
}

export function readStatus(): SyncStatusFile {
  const d: SyncStatusFile = { lastSyncAt: '', total: 0, added: 0, totalAdded: 0, skippedCount: 0, lastError: '' }
  if (!fs.existsSync(STATUS_FILE)) return d
  try {
    return { ...d, ...JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) }
  } catch {
    return d
  }
}

function writeStatus(patch: Partial<SyncStatusFile>) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...readStatus(), ...patch }, null, 2), 'utf8')
}

export function recordSyncError(message: string) {
  writeStatus({ lastError: message })
}

// ---------------------------------------------------------------------------
// 访问令牌(内存缓存,过期前 5 分钟刷新)
// ---------------------------------------------------------------------------

let tokenCache: { token: string; expireAt: number } | null = null

/** HTTPS JSON 请求（node:https 实现，兼容随包分发的 Node 14——全局 fetch 是 Node 18 才有的） */
function httpsJson(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ status: number; ok: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.setTimeout(options.timeoutMs ?? 30_000, () => req.destroy(new Error(`请求超时(${options.timeoutMs ?? 30_000}ms)：${url.slice(0, 80)}`)))
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/**
 * 带韧性的请求：网络错误/超时/5xx 自动重试 3 次（与 dtRequest 同策略）。
 * getToken/getJsapi_ticket 等前置调用原来一次网络抖动就整体失败，登录/扫码全被拖垮。
 */
async function httpsJsonRetry(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ status: number; ok: boolean; text: string }> {
  for (let attempt = 1; ; attempt++) {
    let res: { status: number; ok: boolean; text: string }
    try {
      res = await httpsJson(url, options)
    } catch (e) {
      if (attempt >= 3)
        throw new Error(
          `钉钉接口网络异常（${(e as Error).message.slice(0, 120)}）：已重试 3 次。` +
            '排查：服务器能否访问钉钉—— curl -m 10 https://api.dingtalk.com/ 应秒回（任意状态码都算通）',
        )
      await new Promise((s) => setTimeout(s, 1000 * attempt))
      continue
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((s) => setTimeout(s, 1000 * attempt))
      continue
    }
    return res
  }
}

async function getToken(): Promise<string> {
  const c = readConfig()
  if (!c.appKey || !c.appSecret) throw new Error('未配置钉钉 AppKey/AppSecret，请到「设置」页填写')
  if (tokenCache && Date.now() < tokenCache.expireAt - 300_000) return tokenCache.token
  const res = await httpsJsonRetry(`${HOST}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: c.appKey, appSecret: c.appSecret }),
  })
  const j = parseJson(res.text)
  if (!res.ok) throw new Error(`钉钉换 token 失败(HTTP ${res.status})：${j.message ?? ''}。排查：AppKey/AppSecret 是否正确、应用是否发布。`)
  tokenCache = { token: j.accessToken, expireAt: Date.now() + (Number(j.expireIn) || 7200) * 1000 }
  return j.accessToken
}

// ---------------------------------------------------------------------------
// JSAPI 鉴权（手机钉钉内扫码 dd.scanCode 用）
//   流程：access_token → get_jsapi_ticket（内存缓存）→ 按钉钉规则 sha1 签名
//   签名串固定顺序：jsapi_ticket=..&noncestr=..&timestamp=..&url=..（url 不含 # 及其后内容）
// ---------------------------------------------------------------------------

let ticketCache: { ticket: string; expireAt: number } | null = null

async function getJsapiTicket(): Promise<string> {
  if (ticketCache && Date.now() < ticketCache.expireAt - 300_000) return ticketCache.ticket
  const token = await getToken()
  const res = await httpsJsonRetry(`https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: {},
  })
  const j = parseJson(res.text)
  if (!res.ok || j.errcode) {
    const hints: string[] = []
    if (String(j.errmsg || '').includes('ip') || j.errcode === 60020) hints.push('排查：开放平台应用「开发配置-服务器出口IP」需包含本机公网 IP')
    throw new Error(`获取 jsapi_ticket 失败(${j.errcode ?? res.status})：${j.errmsg ?? res.text.slice(0, 160)}${hints.length ? '；' + hints.join('；') : ''}`)
  }
  ticketCache = { ticket: String(j.ticket ?? ''), expireAt: Date.now() + (Number(j.expire_in) || 7200) * 1000 }
  return ticketCache.ticket
}

export interface JsapiSign {
  agentId: string
  corpId: string
  timeStamp: string
  nonceStr: string
  signature: string
}

/** 为指定页面 URL 生成 dd.config 鉴权参数（前端动态请求，签名与当前 URL 严格绑定） */
export async function signJsapi(url: string): Promise<JsapiSign> {
  const c = readConfig()
  const missing = (['corpId', 'agentId', 'appKey', 'appSecret'] as const).filter((k) => !c[k])
  if (missing.length) throw new Error(`扫码功能未配置（缺：${missing.join('、')}），请到「设置」页钉钉配置中补全`)
  if (!/^https?:\/\/.+/.test(url)) throw new Error('url 参数无效（应为 http(s):// 开头的当前页面地址）')
  const ticket = await getJsapiTicket()
  const nonceStr = crypto.randomBytes(8).toString('hex')
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`
  const signature = crypto.createHash('sha1').update(plain, 'utf8').digest('hex')
  return { agentId: c.agentId, corpId: c.corpId, timeStamp, nonceStr, signature }
}

// ---------------------------------------------------------------------------
// 免登身份（录入人锁定严格模式）
//   流程：前端 dd.runtime.permission.requestAuthCode 拿一次性 authCode →
//   本端换 userid（/topapi/v2/user/getuserinfo）→ 查姓名（/topapi/v2/user/get）
//   → 签发自包含会话 token（HMAC，密钥由 AppSecret 派生）。
//   记一笔时后端只认 token 里验证过的姓名，客户端传的 recorder 一律忽略。
// ---------------------------------------------------------------------------

/** 免登：authCode 换当前用户（登录者须在企业内且在应用「可见范围」内） */
export async function getUserByAuthCode(authCode: string): Promise<{ userid: string; name: string }> {
  const token = await getToken()
  const r = parseJson(
    (
      await httpsJson(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 该接口参数名是 code（实测发 authCode 得 errcode 40 "Missing required arguments:code"）
        body: JSON.stringify({ code: authCode }),
      })
    ).text,
  )
  if (r.errcode) {
    const hints: string[] = []
    if (r.errcode === 40035 || r.errcode === 40078 || String(r.errmsg || '').includes('不合法') || String(r.errmsg || '').includes('不存在'))
      hints.push('免登码已过期或已使用（一次性，约 5 分钟有效），请重试')
    else if (r.errcode === 40) hints.push('钉钉未收到免登码参数，请重试；若持续出现请联系管理员检查服务端版本')
    else hints.push('排查：该用户是否在开放平台应用的「可见范围」内、企业 CorpId 是否正确')
    throw new Error(`免登换用户失败(${r.errcode})：${r.errmsg ?? ''}；${hints.join('；')}`)
  }
  const userid = String(r.result?.userid ?? '')
  if (!userid) throw new Error('免登返回中没有 userid，请重试')
  const u = parseJson(
    (
      await httpsJson(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userid }),
      })
    ).text,
  )
  const name = String(u.result?.name ?? '').trim()
  if (u.errcode || !name) throw new Error(`查询钉钉用户姓名失败(${u.errcode ?? '-'})：${u.errmsg ?? ''}`)
  return { userid, name }
}

const USER_TOKEN_TTL = 12 * 3600_000

/** 签发会话 token：`过期毫秒.姓名(base64url).HMAC`（改 AppSecret 即全部失效） */
export function issueUserToken(name: string): string {
  const secret = readConfig().appSecret
  if (!secret) throw new Error('未配置钉钉 AppSecret，无法签发身份令牌')
  const payload = `${Date.now() + USER_TOKEN_TTL}.${Buffer.from(encodeURIComponent(name)).toString('base64url')}`
  const mac = crypto.createHmac('sha256', `recorder:${secret}`).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

/** 校验会话 token，通过返回已验证姓名，否则 null（过期/伪造/密钥已更换） */
export function verifyUserToken(token: string): string | null {
  const secret = readConfig().appSecret
  const parts = String(token ?? '').split('.')
  if (!secret || parts.length !== 3) return null
  const [exp, nameB64, mac] = parts
  if (!/^\d{1,16}$/.test(exp) || Number(exp) < Date.now()) return null
  const expect = crypto.createHmac('sha256', `recorder:${secret}`).update(`${exp}.${nameB64}`).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    return decodeURIComponent(Buffer.from(nameB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

async function dtRequest(method: string, apiPath: string, body?: unknown): Promise<any> {
  const c = readConfig()
  if (!c.baseId) throw new Error('未配置钉钉 baseId（表格 URL 中 drInstanceId= 后面的串）')
  if (!c.operatorId) throw new Error('未配置钉钉 operatorId（操作人 unionId）')
  const token = await getToken()
  const url = `${HOST}${apiPath}?operatorId=${encodeURIComponent(c.operatorId)}`
  let res!: { status: number; ok: boolean; text: string }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await httpsJson(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      // 超时/网络错误与 5xx 同样对待：钉钉偶发故障数秒自愈，重试（原先超时直接失败）
      if (attempt < 3) {
        await new Promise((s) => setTimeout(s, 1000 * attempt))
        continue
      }
      throw new Error(
        `钉钉接口网络异常（${(e as Error).message.slice(0, 120)}）：已重试 3 次。` +
          '排查：服务器能否访问钉钉—— curl -m 10 https://api.dingtalk.com/ 应秒回（任意状态码都算通）',
      )
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((s) => setTimeout(s, 1000 * attempt))
      continue
    }
    break
  }
  const j = parseJson(res.text)
  if (!res.ok) {
    const hints: string[] = []
    if (res.status === 403) hints.push('403：应用需开通 AI 表格(Notable)读写权限，并被加为该表格协作者；权限变更后要发布应用新版本')
    if (res.status === 404) hints.push('404：baseId/表名不对，或表格不在当前企业')
    if (res.status === 429) hints.push('429：触发限流（AI 表格 OpenAPI 已纳入付费计量），可调大自动同步间隔')
    throw new Error(`钉钉接口失败(HTTP ${res.status} ${apiPath})：${j.message ?? res.text.slice(0, 200)}${hints.length ? '；' + hints.join('；') : ''}`)
  }
  return j
}

const enc = encodeURIComponent
function sheetPath(suffix: string): string {
  const c = readConfig()
  return `/v1.0/notable/bases/${enc(c.baseId)}/sheets/${enc(c.sheet)}${suffix}`
}

async function listAllRecords(): Promise<any[]> {
  const records: any[] = []
  let nextToken: string | undefined
  for (let i = 0; i < 1000; i++) {
    const body: Record<string, unknown> = { maxResults: 100 }
    if (nextToken) body.nextToken = nextToken
    const j = await dtRequest('POST', sheetPath('/records/list'), body)
    records.push(...(j.records || []))
    nextToken = j.nextToken
    if (!j.hasMore || !nextToken) return records
  }
  throw new Error('钉钉分页超过上限(1000 页)，已停止')
}

// ---------------------------------------------------------------------------
// 字段值解析
// ---------------------------------------------------------------------------

/** 任意形态字段值 → 标量文本：单选取 name，多值合并逗号分隔，数字转文本 */
function flat(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(',')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['text', 'name', 'value', 'title']) {
      if (k in o) return flat(o[k])
    }
  }
  return String(v)
}

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm'（本地时区） */
function msToDt(ms: unknown): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function deriveBatch(at: string): string {
  return `${at.slice(5, 7)}${at.slice(8, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}`
}

/** 库位选项名容错：钉钉单选选项可能带区域尾巴（如 "A06\tA区"），只取编号 token */
function locCode(raw: string): string {
  return String(raw ?? '')
    .split(/[\t,，;；\s]+/)[0]
    .trim()
    .toUpperCase()
}

function nowLocal(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// 选项读取：产品图号（钉钉单选选项）与录入人（表格历史 + 本地台账）
// ---------------------------------------------------------------------------

export interface DtOptions {
  products: string[]
  recorders: string[]
  productsAvailable: boolean
}

let recorderCache: { at: number; names: string[] } | null = null

/**
 * 把钉钉表「库位编号」单选选项自动登记进本地库位表——记一笔下拉、看板空位、
 * 同步校验、二维码标签从此直接可用，不用再手工批量导入 132 个库位。
 * 只增不删不改：本地已停用/改过区域的不会被覆盖，表里删掉的选项本地保留（历史数据仍在）。
 * 库位号 = 选项名规范化（与同步读取同规则：取首 token 转大写）；
 * 区域 = 选项名最后一段「-」后的描述（如 1b1-半成品→半成品、3b2-hf1-补涂烘房→补涂烘房），
 * 尾段是 hf 编号（如 2c3-hf21）或没有横线时归入「白区」，可在设置页表格里改。
 */
export async function syncLocationsFromTable(): Promise<number> {
  const fields = await getFields()
  const names: string[] = []
  for (const c of fields['库位编号']?.property?.choices ?? []) {
    const raw = (typeof c === 'string' ? c : String(c?.name ?? '')).split('\t')[0].trim()
    if (raw) names.push(raw)
  }
  const list: LocationItem[] = readLocations()
  const have = new Set(list.map((l) => l.code))
  let added = 0
  for (const raw of names) {
    const code = locCode(raw)
    if (!code || have.has(code)) continue
    const tail = raw.includes('-') ? raw.slice(raw.lastIndexOf('-') + 1).trim() : ''
    const zone = tail && !/^hf/i.test(tail) ? tail.slice(0, 20) : '白区'
    list.push({ code, zone, note: '', enabled: true })
    have.add(code)
    added++
  }
  if (added) writeLocations(list)
  return added
}

export async function readOptions(): Promise<DtOptions> {
  // 顺手把表里的库位选项登记进本地（记一笔下拉/看板空位直接可用）；失败不影响选项返回
  try {
    await syncLocationsFromTable()
  } catch {
    /* 钉钉不可用/未配置时跳过 */
  }
  // 钉钉字段选项可能存在同名重复（历史误建），重复值会破坏前端下拉的过滤注册，
  // 这里按名称去重（保留首次出现顺序）
  const seen = new Set<string>()
  const products: string[] = []
  let available = false
  try {
    const fields = await getFields()
    const prodField = fields['产品图号']
    for (const c of prodField?.property?.choices ?? []) {
      const name = typeof c === 'string' ? c : String(c.name ?? '')
      if (name && !seen.has(name)) {
        seen.add(name)
        products.push(name)
      }
    }
    available = true
  } catch {
    // 钉钉不可用/未配置时降级为空表，前端回退手填
  }

  let recorders: string[]
  if (recorderCache && Date.now() - recorderCache.at < 300_000) {
    recorders = [...recorderCache.names]
  } else {
    const names = new Set<string>()
    try {
      const rows = await listAllRecords()
      for (const row of rows) {
        const n = flat((row?.fields ?? {})['录入人']).trim()
        if (n) names.add(n)
      }
    } catch {
      /* 钉钉不可用时仅用本地台账的录入人 */
    }
    for (const e of readLedger()) {
      if (e.type === 'txn' && e.recorder) {
        const n = e.recorder.trim()
        // 台账历史里的纯数字/单字符录入人多为测试残留，不进建议列表（仍可手填）
        if (n.length >= 2 && /\D/.test(n)) names.add(n)
      }
    }
    recorders = [...names].sort((a, b) => a.localeCompare(b, 'zh')).slice(0, 100)
    recorderCache = { at: Date.now(), names: [...recorders] }
  }

  return { products, recorders, productsAvailable: available }
}

// ---------------------------------------------------------------------------
// 反向写入：网页端记一笔 → 钉钉流水表
// ---------------------------------------------------------------------------

const MAP_FILE = path.join(DATA_DIR, 'dingtalk-map.json')

/** 本地台账序号 → 钉钉行ID 的映射（防回声：已回写的行不再被同步拉回） */
function readMap(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveMap(seq: number, ids: string[]) {
  const m = readMap()
  m[String(seq)] = ids
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2), 'utf8')
}

export { saveMap }

export function mappedIds(): Set<string> {
  return new Set(Object.values(readMap()).flat())
}

let fieldCache: { at: number; fields: Record<string, any> } | null = null

async function getFields(): Promise<Record<string, any>> {
  if (fieldCache && Date.now() - fieldCache.at < 300_000) return fieldCache.fields
  const j = await dtRequest('GET', sheetPath('/fields'))
  const fields: Record<string, any> = {}
  for (const f of j.value ?? []) if (f?.name) fields[f.name] = f
  fieldCache = { at: Date.now(), fields }
  return fields
}

/** 单选值 → 选项ID（钉钉写入必须用选项ID；选项名带「A06⇥A区」尾巴时按编号前缀匹配；
 *  白区表选项含小写+中文（如 1b1-半成品），本地登记统一大写，故再做大写不敏感兜底匹配） */
function choiceId(field: any, value: string): string {
  const choices = field?.property?.choices ?? []
  for (const c of choices) {
    const name = typeof c === 'string' ? c : String(c.name ?? '')
    const id = typeof c === 'string' ? '' : String(c.id ?? '')
    if (name === value || name.split('\t')[0].trim() === value) return id || name
  }
  const v = value.toUpperCase()
  for (const c of choices) {
    const name = typeof c === 'string' ? c : String(c.name ?? '')
    const id = typeof c === 'string' ? '' : String(c.id ?? '')
    const head = name.split('\t')[0].trim()
    if (name.toUpperCase() === v || head.toUpperCase() === v) return id || name
  }
  return ''
}

function atToMs(at: string): number {
  const t = Date.parse(String(at).replace(' ', 'T'))
  return Number.isFinite(t) ? t : Date.now()
}

export interface WebTxnInput {
  kind: TxnKind
  location: string
  targetLocation?: string
  product: string
  batch: string
  qty: number
  recorder: string
  note?: string
  txnAt: string
}

/** 把网页端记的一笔写入钉钉流水表；转移拆成 出库+入库 两行（钉钉表无转移选项）。返回创建的行ID。 */
export async function writeTxnToDingtalk(ev: WebTxnInput): Promise<string[]> {
  const fields = await getFields()
  for (const n of ['操作类型', '库位编号', '产品图号', '件数', '批次号']) {
    if (!fields[n]) throw new Error(`钉钉流水表缺少字段「${n}」`)
  }
  const inId = choiceId(fields['操作类型'], '入库')
  const outId = choiceId(fields['操作类型'], '出库')
  const locId = choiceId(fields['库位编号'], ev.location)
  if (!locId) throw new Error(`库位 ${ev.location} 不在钉钉表「库位编号」选项中`)
  const prodId = choiceId(fields['产品图号'], ev.product)
  if (!prodId) throw new Error(`产品图号 ${ev.product} 不在钉钉表选项中，请先在钉钉表添加该图号选项`)
  const remark = `[网页:${ev.recorder}]${ev.note ? ' ' + ev.note : ''}`
  const base: Record<string, unknown> = {
    库位编号: locId,
    产品图号: prodId,
    件数: ev.qty,
    批次号: atToMs(ev.txnAt),
  }

  const rows: { fields: Record<string, unknown> }[] = []
  if (ev.kind === 'move') {
    const targetId = choiceId(fields['库位编号'], ev.targetLocation ?? '')
    if (!targetId) throw new Error(`目标库位 ${ev.targetLocation} 不在钉钉表「库位编号」选项中`)
    if (!outId || !inId) throw new Error('钉钉表「操作类型」缺少 入库/出库 选项，无法写入转移')
    rows.push({ fields: { ...base, 操作类型: outId, 备注: `${remark} 转移至 ${ev.targetLocation}` } })
    rows.push({ fields: { ...base, 操作类型: inId, 库位编号: targetId, 备注: `${remark} 来自 ${ev.location}` } })
  } else {
    const kindId = ev.kind === 'in' ? inId : outId
    if (!kindId) throw new Error(`钉钉表「操作类型」缺少 ${ev.kind === 'in' ? '入库' : '出库'} 选项`)
    rows.push({ fields: { ...base, 操作类型: kindId, 备注: remark } })
  }

  const j = await dtRequest('POST', sheetPath('/records'), { records: rows })
  const recs = j.records ?? j.value ?? []
  const ids = (recs as any[]).map((r) => String(r?.id ?? '')).filter(Boolean)
  if (ids.length !== rows.length) throw new Error(`钉钉写入返回异常：期望 ${rows.length} 行，实得 ${ids.length} 行`)
  return ids
}

// ---------------------------------------------------------------------------
// 同步主流程
// ---------------------------------------------------------------------------

export interface SyncReport {
  at: string
  total: number
  added: number
  skippedRows: { id: string; reason: string }[]
}

/** 单条待入账业务（已映射/校验），增量入账与镜像重放共用 */
interface Pending {
  id: string
  kind: TxnKind
  location: string
  targetLocation?: string
  product: string
  batch: string
  qty: number
  recorder: string
  note?: string
  at: string
}

type ApplyResult = { ok: true; portions: { batch: string; take: number }[] } | { ok: false; reason: string }

/** 把一笔业务应用到库存状态：入库并/建批；出库/转移按「停放最久优先」跨批扣减。纯状态操作，不落账。 */
function applyTxn(state: Map<string, { qty: number; since: string }>, p: Pending): ApplyResult {
  if (p.kind === 'in') {
    const batch = p.batch || deriveBatch(p.at)
    const key = `${p.location}|${p.product}|${batch}`
    const cur = state.get(key)
    if (cur) cur.qty += p.qty
    else state.set(key, { qty: p.qty, since: p.at.slice(0, 10) })
    return { ok: true, portions: [{ batch, take: p.qty }] }
  }
  const prefix = `${p.location}|${p.product}|`
  const matches = [...state.entries()].filter(([k]) => k.startsWith(prefix)).sort((a, b) => a[1].since.localeCompare(b[1].since))
  const total = matches.reduce((s, [, v]) => s + v.qty, 0)
  const verb = p.kind === 'out' ? '出库' : '转移'
  if (!matches.length) return { ok: false, reason: `库位 ${p.location} 没有产品 ${p.product} 的库存，无法${verb}` }
  if (total < p.qty) return { ok: false, reason: `库存不足：${p.location} / ${p.product} 现有 ${total} 件，本次${verb} ${p.qty} 件` }
  let remaining = p.qty
  const portions: { batch: string; take: number }[] = []
  for (const [key, val] of matches) {
    if (remaining <= 0) break
    const take = Math.min(val.qty, remaining)
    const batch = key.split('|')[2] ?? ''
    portions.push({ batch, take })
    val.qty -= take
    remaining -= take
    if (val.qty <= 0) state.delete(key)
    if (p.kind === 'move' && p.targetLocation) {
      const tkey = `${p.targetLocation}|${p.product}|${batch}`
      const t = state.get(tkey)
      if (t) t.qty += take
      else state.set(tkey, { qty: take, since: p.at.slice(0, 10) })
    }
  }
  return { ok: true, portions }
}

export async function syncFromDingtalk(): Promise<SyncReport> {
  const state0 = configState()
  if (!state0.configured) throw new Error(`钉钉配置不完整，缺：${state0.missing.join('、')}`)
  const cfg = readConfig()

  // 表里新加的库位选项先登记进本地（否则含新库位的行会被「未登记」跳过）；失败不阻塞同步
  try {
    await syncLocationsFromTable()
  } catch {
    /* 字段读取失败（网络/权限）时按现有登记继续 */
  }

  // 0) 补写此前没写进钉钉的网页记一笔（钉钉故障/未配置恢复后自动追平）
  const ledger0 = readLedger()
  const map0 = readMap()
  const pendingWeb = ledger0.filter((e) => e.type === 'txn' && !e.source && !map0[String(e.seq)])
  for (const ev of pendingWeb) {
    if (ev.type !== 'txn') continue
    try {
      const ids = await writeTxnToDingtalk(ev)
      saveMap(ev.seq, ids)
    } catch (e) {
      const msg = (e as Error).message
      recordSyncError(`补写网页记一笔 #${ev.seq} 到钉钉失败：${msg}`)
      // 数据性问题（图号/库位不在选项中）：重试无意义，跳过继续补后面的；网络/服务问题：下次同步再补
      if (/不在钉钉表/.test(msg)) continue
      break
    }
  }

  const rows = await listAllRecords()
  const ledger = readLedger()
  const seen = new Set(
    ledger
      .filter((e) => e.type === 'txn' && e.sourceId)
      .map((e) => (e as { sourceId?: string }).sourceId!.split('~')[0]),
  )
  const mapped = mappedIds()
  const enabledLocs = new Set(readLocations().filter((l) => l.enabled).map((l) => l.code))

  // 1) 映射并校验全部行（增量入账与镜像重放共用）
  const pendingAll: Pending[] = []
  const invalidAll: { id: string; reason: string }[] = []
  for (const row of rows) {
    const id = String(row?.id || '')
    if (!id) continue
    const f = (row?.fields ?? {}) as Record<string, unknown>

    const kindText = flat(f['操作类型']).trim()
    const kind: TxnKind | null = kindText.includes('入') ? 'in' : kindText.includes('出') ? 'out' : kindText.includes('转') || kindText.includes('流') ? 'move' : null
    const location = locCode(flat(f['库位编号']))
    const product = flat(f['产品图号']).trim()
    const qty = Number(flat(f['件数']))
    const batchRaw = f['批次号']
    const batchNum = Number(batchRaw)
    const batchIsDate = batchRaw != null && batchRaw !== '' && Number.isFinite(batchNum)
    const explicitBatch = batchIsDate ? '' : flat(batchRaw).trim()
    const at = msToDt(f['操作时间']) || (batchIsDate ? msToDt(batchNum) : '') || nowLocal()

    const bad = (reason: string) => invalidAll.push({ id, reason })
    if (!kind) bad(`操作类型「${kindText || '空'}」无法识别（应为 入库/出库/转移）`)
    else if (!location) bad('缺少库位编号')
    else if (!enabledLocs.has(location)) bad(`库位 ${location} 未登记或已停用`)
    else if (!product) bad('缺少产品图号')
    else if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) bad(`件数「${flat(f['件数']) || '空'}」无效（须为 1-1000000 整数）`)
    else if (kind === 'move' && !locCode(flat(f['目标库位']))) bad('转移缺少目标库位')
    else if (kind === 'move' && !enabledLocs.has(locCode(flat(f['目标库位'])))) bad(`目标库位 ${locCode(flat(f['目标库位']))} 未登记或已停用`)
    else if (kind === 'move' && locCode(flat(f['目标库位'])) === location) bad('目标库位与原库位相同')
    else {
      pendingAll.push({
        id,
        kind,
        location,
        targetLocation: kind === 'move' ? locCode(flat(f['目标库位'])) : undefined,
        product,
        batch: explicitBatch,
        qty,
        recorder: flat(f['录入人']).trim() || '钉钉',
        note: flat(f['备注']).trim() || undefined,
        at,
      })
    }
  }

  // 2) 增量入账：只处理本台账没见过的新行（保留逐笔审计流水）
  const pendingNew = pendingAll.filter((p) => !seen.has(p.id) && !mapped.has(p.id)).sort((a, b) => a.at.localeCompare(b.at))
  const { state } = replayState(ledger)
  const skippedRows = invalidAll.filter((r) => !seen.has(r.id) && !mapped.has(r.id))
  let added = 0
  for (const p of pendingNew) {
    const res = applyTxn(state, p)
    if (!res.ok) {
      skippedRows.push({ id: p.id, reason: res.reason })
      continue
    }
    res.portions.forEach((portion, idx) => {
      appendTxnEvent({
        kind: p.kind,
        location: p.location,
        targetLocation: p.kind === 'move' ? p.targetLocation : undefined,
        product: p.product,
        batch: portion.batch,
        qty: portion.take,
        recorder: p.recorder,
        note: p.note,
        txnAt: p.at,
        source: 'dingtalk',
        sourceId: res.portions.length > 1 ? `${p.id}~${idx + 1}~${portion.batch}` : p.id,
      })
      added++
    })
  }

  // 3) 镜像校准：用钉钉全表重算一份状态，与当前看板比对，有差异才追加镜像事件重置
  //    （钉钉里删行/改行由此在看板生效；刚记的网页笔未落表时给 10 分钟宽限期防闪烁）
  if (cfg.mirror) {
    const fresh = new Map<string, { qty: number; since: string }>()
    for (const p of [...pendingAll].sort((a, b) => a.at.localeCompare(b.at))) applyTxn(fresh, p)

    const mapNow = readMap()
    const allRowIds = new Set(rows.map((r) => String(r?.id ?? '')))
    const graceMs = 10 * 60_000
    for (const ev of ledger) {
      if (ev.type !== 'txn' || ev.source) continue
      const ids = mapNow[String(ev.seq)] ?? []
      const inTable = ids.length > 0 && ids.every((i) => allRowIds.has(i))
      // 表格已可见：交给表格；超过宽限期（含回写后被删行、迟迟未能回写的）：严格以钉钉为准
      if (inTable) continue
      if (Date.parse(ev.recordedAt) < Date.now() - graceMs) continue
      applyTxn(fresh, {
        id: `web-${ev.seq}`,
        kind: ev.kind,
        location: ev.location,
        targetLocation: ev.targetLocation,
        product: ev.product,
        batch: ev.batch,
        qty: ev.qty,
        recorder: ev.recorder,
        note: ev.note,
        at: ev.txnAt,
      })
    }

    const serialize = (m: Map<string, { qty: number; since: string }>) =>
      [...m.entries()].map(([k, v]) => `${k}|${v.qty}|${v.since}`).sort().join(';')
    const current = replayState(readLedger()).state
    if (serialize(fresh) !== serialize(current)) {
      const records = [...fresh.entries()].map(([k, v]) => {
        const [location, product, batch] = k.split('|')
        return { location, product: product ?? '', batch: batch ?? '', qty: v.qty, since: v.since }
      })
      appendMirrorEvent(records)
    }
  }

  const report: SyncReport = { at: new Date().toISOString(), total: rows.length, added, skippedRows }
  writeStatus({
    lastSyncAt: report.at,
    total: report.total,
    added: report.added,
    totalAdded: readStatus().totalAdded + report.added,
    skippedCount: skippedRows.length,
    lastError: '',
  })
  return report
}
