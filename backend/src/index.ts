import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import compression from 'compression'
import ExcelJS from 'exceljs'
import {
  appendDayEvent,
  appendTxnEvent,
  readLedger,
  readLocations,
  readSettings,
  writeLocations,
  writeSettings,
  type DayRecord,
} from './store'
import { boardFromState, buildBoard, fifoTake, replayState } from './compute'
import { configState, getUserByAuthCode, issueUserToken, readConfig, readOptions, readStatus, recordSyncError, signJsapi, syncFromDingtalk, verifyUserToken, writeConfig, writeTxnToDingtalk } from './dingtalk'
import { saveMap } from './dingtalk'

const PORT = Number(process.env.PORT || 8792)
const app = express()
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '4mb' }))

const bad = (res: Response, msg: string) => res.status(400).json({ message: msg })
const BAD_CHARS = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/
const KINDS = ['in', 'out', 'move'] as const
const LOCK_MSG = '录入人已锁定为钉钉身份：请从手机/电脑钉钉打开本看板自动登录后操作（普通浏览器不可记一笔）'

/** 严格模式取录入人：锁定时只认免登 token 里的姓名（客户端传的 recorder 一律忽略） */
function verifiedRecorder(req: Request): { ok: true; name: string } | { ok: false } {
  const header = req.headers['x-user-token']
  const name = verifyUserToken((Array.isArray(header) ? header[0] : header) ?? '')
  if (!name) return { ok: false }
  return { ok: true, name: name.slice(0, 20) }
}

/** 出库自动先进先出（跨批）：在 codes 库位范围内按停放最久优先扣足，拆多条事件落账并回写钉钉、应答 */
async function fifoOut(
  res: Response,
  codes: Set<string>,
  label: string,
  prod: string,
  q: number,
  rec: string,
  nt: string | undefined,
  when: string,
): Promise<void> {
  const { state } = replayState(readLedger())
  const take = fifoTake(state, codes, prod, q)
  if (!take.ok) {
    return void bad(
      res,
      take.total ? `库存不足：${label} / ${prod} 现有 ${take.total} 件，本次出库 ${q} 件` : `${label} 没有产品 ${prod} 的库存，无法出库`,
    )
  }
  // 一笔跨批出库拆成多条事件（各带真实批次），共享 groupId 便于追溯
  const groupId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const evs = take.portions.map((p) =>
    appendTxnEvent({
      kind: 'out' as const,
      location: p.location,
      product: prod,
      batch: p.batch,
      qty: p.take,
      recorder: rec,
      note: nt,
      txnAt: when,
      groupId,
    }),
  )
  let dtWarning: string | undefined
  for (const ev of evs) {
    try {
      const ids = await writeTxnToDingtalk(ev)
      saveMap(ev.seq, ids)
    } catch (e) {
      dtWarning = (e as Error).message
      recordSyncError(`网页记一笔 #${ev.seq} 写入钉钉失败：${dtWarning}`)
      break // 数据性错误（图号/库位不在选项）后续笔同样会失败；未写部分由下次同步自动补写
    }
  }
  res.json({ ok: true, seq: evs[0].seq, seqs: evs.map((e) => e.seq), portions: take.portions, dtWarning })
}

/** 记一笔：入库/出库/转移，实时流水。出库与转移会校验现有库存；成功后回写钉钉流水。 */
app.post('/api/txn', async (req: Request, res: Response) => {
  const { kind, location, targetLocation, product, batch, qty, recorder, note, txnAt } = req.body ?? {}
  if (!KINDS.includes(kind)) return bad(res, '操作类型应为 入库/出库/转移')
  let rec = String(recorder ?? '').trim()
  if (readConfig().lockRecorder) {
    const v = verifiedRecorder(req)
    if (!v.ok) return bad(res, LOCK_MSG)
    rec = v.name
  } else {
    if (!rec || rec.length > 20) return bad(res, '请填写录入人（1-20 字）')
    if (BAD_CHARS.test(rec)) return bad(res, '录入人含非法字符（检测到非 UTF-8 编码，请通过网页端录入）')
  }
  const loc = String(location ?? '').trim()
  const prod = String(product ?? '').trim()
  let bat = String(batch ?? '').trim()
  if (!prod || prod.length > 60 || BAD_CHARS.test(prod) || prod.includes('|')) return bad(res, '产品图号不能为空、不超过 60 字符且不含竖线')
  if (bat.length > 40 || BAD_CHARS.test(bat) || bat.includes('|')) return bad(res, '批次号不超过 40 字符且不含竖线（可不填）')
  const q = Number(qty)
  if (!Number.isInteger(q) || q < 1 || q > 1_000_000) return bad(res, '件数须为 1-1000000 的整数')
  const nt = String(note ?? '').trim().slice(0, 100)
  if (BAD_CHARS.test(nt)) return bad(res, '备注含非法字符')

  const at = String(txnAt ?? '').trim()
  const m = at.match(/^(\d{4}-\d{2}-\d{2})( \d{2}:\d{2}(:\d{2})?)?$/)
  if (!m) return bad(res, '操作时间格式应为 YYYY-MM-DD HH:mm')
  const when = m[2] ? at : `${at} ${new Date().toTimeString().slice(0, 5)}`

  // 入库未显式给批次号时，按操作时间自动生成（MMDD-HHmm）
  if (kind === 'in' && !bat) {
    bat = `${when.slice(5, 7)}${when.slice(8, 10)}-${when.slice(11, 13)}${when.slice(14, 16)}`
  }

  const locations = readLocations()
  const registered = new Set(locations.filter((l) => l.enabled).map((l) => l.code))

  if (kind === 'in') {
    if (!registered.has(loc)) return bad(res, `库位 ${loc} 未登记或已停用，请先在设置中登记`)
  } else if (kind === 'out' && !bat) {
    // 出库不指定批次 = 自动先进先出：该库位（小区域）下多批一次扣足，按停放最久优先跨批扣减
    if (!loc) return bad(res, '请选择库位')
    return await fifoOut(res, new Set([loc]), `库位 ${loc}`, prod, q, rec, nt || undefined, when)
  } else {
    const { state } = replayState(readLedger())
    const cur = state.get(`${loc}|${prod}|${bat}`)
    if (!cur) return bad(res, `库位 ${loc} 没有产品 ${prod}${bat ? '（批次 ' + bat + '）' : ''}`)
    if (cur.qty < q) return bad(res, `库存不足：${loc} / ${prod}${bat ? ' / ' + bat : ''} 现有 ${cur.qty} 件`)
    if (kind === 'move') {
      const target = String(targetLocation ?? '').trim()
      if (!registered.has(target)) return bad(res, `目标库位 ${target} 未登记或已停用`)
      if (target === loc) return bad(res, '目标库位不能与原库位相同')
    }
  }

  const ev = appendTxnEvent({
    kind,
    location: loc,
    product: prod,
    batch: bat,
    qty: q,
    recorder: rec,
    targetLocation: kind === 'move' ? String(targetLocation ?? '').trim() : undefined,
    note: nt || undefined,
    txnAt: when,
  })
  // 双向：本地已入账，再回写钉钉流水表；失败不阻塞（下次同步自动补写）
  let dtWarning: string | undefined
  try {
    const ids = await writeTxnToDingtalk(ev)
    saveMap(ev.seq, ids)
  } catch (e) {
    dtWarning = (e as Error).message
    recordSyncError(`网页记一笔 #${ev.seq} 写入钉钉失败：${dtWarning}`)
  }
  res.json({ ok: true, seq: ev.seq, dtWarning })
})

/** 全区域快照校准（保留的盘点入口：整体重置为某日实盘） */
app.post('/api/day', (req: Request, res: Response) => {
  const { date, recorder, records } = req.body ?? {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return bad(res, '日期格式应为 YYYY-MM-DD')
  let rec = String(recorder ?? '').trim()
  if (readConfig().lockRecorder) {
    const v = verifiedRecorder(req)
    if (!v.ok) return bad(res, LOCK_MSG)
    rec = v.name
  } else {
    if (!rec || rec.length > 20) return bad(res, '请填写录入人（1-20 字）')
    if (BAD_CHARS.test(rec)) return bad(res, '录入人含非法字符')
  }
  if (!Array.isArray(records) || records.length === 0) return bad(res, '记录不能为空')
  if (records.length > 2000) return bad(res, '单日记录数超出上限 2000')

  const locs = readLocations()
  const enabled = new Set(locs.filter((l) => l.enabled).map((l) => l.code))
  const seen = new Set<string>()
  const clean: DayRecord[] = []
  for (const r of records) {
    const location = String(r?.location ?? '').trim()
    const product = String(r?.product ?? '').trim()
    const batch = String(r?.batch ?? '').trim()
    const qty = Number(r?.qty)
    if (!location) return bad(res, '存在未选择库位的行')
    if (!enabled.has(location)) return bad(res, `库位 ${location} 未登记或已停用，请先在设置中登记`)
    if (!product || product.length > 60 || BAD_CHARS.test(product) || product.includes('|')) return bad(res, `产品图号不能为空且不超过 60 字符（库位 ${location}）`)
    if (batch.length > 40 || BAD_CHARS.test(batch) || batch.includes('|')) return bad(res, `批次号不超过 40 字符（${location} / ${product}）`)
    if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) return bad(res, `件数须为 1-1000000 的整数（${location} / ${product}）`)
    const key = `${location}|${product}|${batch}`
    if (seen.has(key)) return bad(res, `重复记录：${location} / ${product}${batch ? ' / ' + batch : ''}`)
    seen.add(key)
    clean.push({ location, product, batch, qty })
  }
  const ev = appendDayEvent(String(date), rec, clean)
  res.json({ ok: true, date: ev.date, revision: ev.revision, seq: ev.seq, count: clean.length })
})

/** 看板（流水重放的当前状态） */
app.get('/api/state', (_req: Request, res: Response) => {
  const board = buildBoard(readLedger(), readSettings(), readLocations())
  res.json({ empty: readLedger().length === 0, settings: readSettings(), board })
})

/** 出库/转移选批参考：当前库存清单（按停放天数倒序，先进先出） */
app.get('/api/stock', (_req: Request, res: Response) => {
  const { state } = replayState(readLedger())
  const board = boardFromState(state, null, readSettings(), readLocations())
  res.json({ items: board.locations.flatMap((l) => l.items.map((i) => ({ ...i }))) })
})

/** 导出库存清单：Excel 文件，按停放时间降序（停得最久的排最前） */
app.get('/api/export', async (_req: Request, res: Response) => {
  const settings = readSettings()
  const { state } = replayState(readLedger())
  const board = boardFromState(state, null, settings, readLocations())
  const rows = board.locations
    .flatMap((l) => l.items.map((i) => ({ ...i, zone: l.zone || '' })))
    .sort((a, b) => b.days - a.days || a.location.localeCompare(b.location, 'zh') || a.product.localeCompare(b.product, 'zh'))
  const stateLabel: Record<string, string> = { ok: '正常', yellow: '预警', red: '严重' }

  const wb = new ExcelJS.Workbook()
  wb.creator = '白区库存管理看板'
  const ws = wb.addWorksheet('库存清单')
  ws.columns = [
    { header: '产品图号', key: 'product', width: 28 },
    { header: '批次号', key: 'batch', width: 13 },
    { header: '库位', key: 'location', width: 8 },
    { header: '区域', key: 'zone', width: 7 },
    { header: '件数', key: 'qty', width: 8 },
    { header: '入库时间', key: 'since', width: 18 },
    { header: '停放天数', key: 'days', width: 10 },
    { header: `状态(黄${settings.yellowDays}天/红${settings.redDays}天)`, key: 'state', width: 15 },
  ]
  for (const r of rows) {
    ws.addRow({ product: r.product, batch: r.batch || '（无批次）', location: r.location, zone: r.zone, qty: r.qty, since: r.since, days: r.days, state: stateLabel[r.state] ?? r.state })
  }
  // 表头样式：品牌绿底白字
  const header = ws.getRow(1)
  header.height = 22
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3AA85B' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  // 状态列按看板口径着色，件数列居中
  const colorOf: Record<string, string> = { 正常: 'FF226B38', 预警: 'FF845E0B', 严重: 'FF912E2C' }
  ws.eachRow((row, n) => {
    if (n === 1) return
    const c = row.getCell('state')
    const col = colorOf[String(c.value)]
    if (col) c.font = { bold: true, color: { argb: col } }
    row.getCell('qty').alignment = { horizontal: 'center' }
    row.getCell('days').alignment = { horizontal: 'center' }
  })
  // 合计行
  const total = ws.addRow({ product: `合计：${rows.length} 批`, qty: rows.reduce((s, r) => s + r.qty, 0), days: '' })
  total.font = { bold: true }
  total.getCell('qty').alignment = { horizontal: 'center' }

  const buf = await wb.xlsx.writeBuffer()
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  const p = (x: number) => String(x).padStart(2, '0')
  const name = `白区库存_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.xlsx`
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.send(Buffer.from(buf as ArrayBuffer))
})

/** 库位登记 */
app.get('/api/locations', (_req: Request, res: Response) => {
  res.json({ locations: readLocations() })
})

app.post('/api/locations', (req: Request, res: Response) => {
  const { code, zone, note } = req.body ?? {}
  const c = String(code ?? '').trim().toUpperCase()
  if (!/^[\u4e00-\u9fa5A-Z0-9_-]{1,16}$/.test(c)) return bad(res, '库位号须为 1-16 位字母/数字/横线/下划线/中文，如 1B1-半成品')
  const list = readLocations()
  if (list.some((l) => l.code === c)) return bad(res, `库位 ${c} 已存在`)
  list.push({ code: c, zone: String(zone ?? '').trim(), note: String(note ?? '').trim(), enabled: true })
  writeLocations(list)
  res.json({ ok: true })
})

/** 批量登记：每行「库位号[,区域[,备注]]」 */
app.post('/api/locations/bulk', (req: Request, res: Response) => {
  const text = String(req.body?.text ?? '')
  const list = readLocations()
  const have = new Set(list.map((l) => l.code))
  const added: string[] = []
  const skipped: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [code, zone, note] = line.split(/[,，\t]/).map((s) => (s ?? '').trim())
    const c = (code ?? '').toUpperCase()
    if (!/^[\u4e00-\u9fa5A-Z0-9_-]{1,16}$/.test(c) || have.has(c)) {
      skipped.push(line)
      continue
    }
    have.add(c)
    list.push({ code: c, zone: zone ?? '', note: note ?? '', enabled: true })
    added.push(c)
  }
  if (added.length) writeLocations(list)
  res.json({ ok: true, added, skipped })
})

app.put('/api/locations/:code', (req: Request, res: Response) => {
  const code = String(req.params.code).toUpperCase()
  const list = readLocations()
  const l = list.find((x) => x.code === code)
  if (!l) return bad(res, `库位 ${code} 不存在`)
  const { zone, note, enabled } = req.body ?? {}
  if (zone !== undefined) l.zone = String(zone).trim()
  if (note !== undefined) l.note = String(note).trim()
  if (enabled !== undefined) l.enabled = !!enabled
  writeLocations(list)
  res.json({ ok: true })
})

/** 阈值设置 */
app.put('/api/settings', (req: Request, res: Response) => {
  const cur = readSettings()
  const { yellowDays, redDays } = req.body ?? {}
  const y = Number(yellowDays)
  const r = Number(redDays)
  const s = {
    yellowDays: Number.isInteger(y) ? Math.min(365, Math.max(1, y)) : cur.yellowDays,
    redDays: Number.isInteger(r) ? Math.min(365, Math.max(1, r)) : cur.redDays,
  }
  if (s.redDays < s.yellowDays) return bad(res, '红色阈值不能小于黄色阈值')
  writeSettings(s)
  res.json({ ok: true, settings: s })
})

/** 台账审计：最近记一笔/快照（谁、何时、干了什么） */
app.get('/api/audit', (req: Request, res: Response) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15))
  const events = readLedger().slice(-limit).reverse()
  res.json({
    events: events.map((e) => ({
      seq: e.seq,
      date: e.type === 'txn' ? e.txnAt.slice(0, 10) : e.type === 'mirror' ? e.at.slice(0, 10) : e.date,
      at: e.type === 'txn' ? e.txnAt : e.type === 'mirror' ? e.at.slice(0, 16).replace('T', ' ') : e.recordedAt,
      recorder: e.type === 'mirror' ? '钉钉同步' : e.recorder,
      type: e.type === 'txn' ? (e.kind === 'in' ? '入库' : e.kind === 'out' ? '出库' : '转移') : e.type === 'mirror' ? '镜像校准' : `快照第${e.revision}版`,
      summary:
        e.type === 'txn'
          ? e.kind === 'move'
            ? `${e.location} → ${e.targetLocation} · ${e.product}${e.batch ? ' / ' + e.batch : ''} × ${e.qty}`
            : `${e.location} · ${e.product}${e.batch ? ' / ' + e.batch : ''} × ${e.qty}`
          : e.type === 'mirror'
            ? `${e.records.length} 批 / ${e.records.reduce((s, r) => s + r.qty, 0)} 件（与钉钉表格对齐）`
            : `${e.records.length} 条记录`,
    })),
  })
})

/** 钉钉同步（录入端）：配置、状态、手动同步、自动轮询 */
app.get('/api/dingtalk/status', (_req: Request, res: Response) => {
  res.json({ ...configState(), status: readStatus() })
})

app.put('/api/dingtalk/config', (req: Request, res: Response) => {
  const cur = readConfig()
  const b = req.body ?? {}
  const secret = typeof b.appSecret === 'string' && b.appSecret !== '***' ? b.appSecret : cur.appSecret
  const n = Number(b.autoSyncMinutes)
  writeConfig({
    appKey: String(b.appKey ?? cur.appKey).trim(),
    appSecret: String(secret).trim(),
    operatorId: String(b.operatorId ?? cur.operatorId).trim(),
    baseId: String(b.baseId ?? cur.baseId).trim(),
    sheet: String(b.sheet ?? cur.sheet).trim() || '中转库流水',
    autoSyncMinutes: Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : cur.autoSyncMinutes,
    mirror: b.mirror === undefined ? cur.mirror : !!b.mirror,
    corpId: String(b.corpId ?? cur.corpId).trim(),
    agentId: String(b.agentId ?? cur.agentId).trim(),
    lockRecorder: b.lockRecorder === undefined ? cur.lockRecorder : !!b.lockRecorder,
  })
  restartAutoSync()
  res.json({ ok: true, ...configState() })
})

/** 钉钉免登（录入人锁定用）：前端传一次性 authCode，返回钉钉姓名 + 12 小时会话 token */
app.post('/api/dingtalk/login', async (req: Request, res: Response) => {
  const authCode = String(req.body?.authCode ?? '').trim()
  if (!authCode) return bad(res, '缺少免登码 authCode')
  try {
    const { name } = await getUserByAuthCode(authCode)
    res.json({ name, token: issueUserToken(name) })
  } catch (e) {
    res.status(400).json({ message: (e as Error).message })
  }
})

/** 手机钉钉内扫码（dd.scanCode）的 dd.config 鉴权签名：前端传当前页面 URL（去掉 # 后），返回签名四件套 */
app.get('/api/dingtalk/jsapi-sign', async (req: Request, res: Response) => {
  const url = String(req.query.url ?? '')
  try {
    res.json(await signJsapi(url))
  } catch (e) {
    res.status(400).json({ message: (e as Error).message })
  }
})

app.post('/api/dingtalk/sync', async (_req: Request, res: Response) => {
  try {
    const report = await syncFromDingtalk()
    res.json({ ok: true, report })
  } catch (e) {
    recordSyncError((e as Error).message)
    res.status(400).json({ message: (e as Error).message })
  }
})

/** 记一笔选项：产品图号取钉钉表单选选项，录入人取表格历史+本地台账 */
app.get('/api/dingtalk/options', async (_req: Request, res: Response) => {
  try {
    res.json(await readOptions())
  } catch (e) {
    res.status(400).json({ message: (e as Error).message })
  }
})

let dtTimer: ReturnType<typeof setInterval> | null = null
function restartAutoSync() {
  if (dtTimer) clearInterval(dtTimer)
  dtTimer = null
  const c = readConfig()
  if (c.appKey && c.appSecret && c.operatorId && c.baseId && c.sheet && c.autoSyncMinutes > 0) {
    dtTimer = setInterval(() => {
      syncFromDingtalk().catch((e) => recordSyncError((e as Error).message))
    }, c.autoSyncMinutes * 60_000)
    console.log(`[白区库存管理] 钉钉自动同步已开启：每 ${c.autoSyncMinutes} 分钟拉取「${c.sheet}」`)
    setTimeout(() => {
      syncFromDingtalk().catch((e) => recordSyncError((e as Error).message))
    }, 3000)
  }
}

// 前端静态资源（vite build 输出）
const PUBLIC_DIR = path.join(process.cwd(), 'public')
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR))
  app.use((req: Request, res: Response) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
    } else {
      res.status(404).json({ message: 'not found' })
    }
  })
}

restartAutoSync()

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces()
  const lan: string[] = []
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address)
    }
  }
  console.log(`[白区库存管理] 服务已启动: http://localhost:${PORT}`)
  for (const ip of lan) console.log(`[白区库存管理] 局域网访问: http://${ip}:${PORT}`)
})
