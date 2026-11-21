import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
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
  DATA_DIR,
  type DayRecord,
  type TxnEvent,
} from './store'
import { replayWithMo, emitMoLog } from './moindex'
import { alignDrawing, importRows, moRegex, parseText, parseXlsx, readAlias, readMoMap, writeAlias, writeMoMap, type MoEntry } from './momap'
import { boardFromState, buildBoard, fifoTake, replayState } from './compute'
import { readProductOptions } from './dingtalk'
import { configState, getUserByAuthCode, issueUserToken, readConfig, readOptions, readStatus, recordSyncError, signJsapi, syncFromDingtalk, verifyUserToken, writeConfig, writeTxnToDingtalk } from './dingtalk'
import { saveMap } from './dingtalk'
import { lanIPv4, loadOrCreateCert } from './cert'

const PORT = Number(process.env.PORT || 8792)
/** 可选 HTTPS 端口（0 = 不启用） */
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 0)
const app = express()
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '20mb' })) // MES 清单粘贴导入可达数万行

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

type TxnResult = { status: number; body: Record<string, unknown> }
const fail = (message: string): TxnResult => ({ status: 400, body: { message } })
const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 已落账事件逐条回写钉钉流水表；失败不阻塞（下次同步自动补写），返回首个错误作为提示 */
async function writeBack(evs: TxnEvent[]): Promise<string | undefined> {
  for (const ev of evs) {
    try {
      const ids = await writeTxnToDingtalk(ev)
      saveMap(ev.seq, ids)
    } catch (e) {
      const msg = (e as Error).message
      recordSyncError(`网页记一笔 #${ev.seq} 写入钉钉失败：${msg}`)
      return msg // 数据性错误（图号/库位不在选项）后续笔同样会失败；未写部分由下次同步自动补写
    }
  }
  return undefined
}

interface TxnCtx {
  kind: (typeof KINDS)[number]
  loc: string
  target: string
  prod: string
  bat: string
  q: number
  rec: string
  nt: string | undefined
  when: string
  requestId?: string
  registered: Set<string>
}

/** 出库自动先进先出（跨批）：在 codes 库位范围内按停放最久优先扣足，拆多条事件落账并回写钉钉 */
async function fifoOut(c: TxnCtx, codes: Set<string>, label: string): Promise<TxnResult> {
  const { state } = replayState(readLedger())
  const take = fifoTake(state, codes, c.prod, c.q)
  if (!take.ok) {
    return fail(
      take.total ? `库存不足：${label} / ${c.prod} 现有 ${take.total} 件，本次出库 ${c.q} 件` : `${label} 没有产品 ${c.prod} 的库存，无法出库`,
    )
  }
  // 一笔跨批出库拆成多条事件（各带真实批次），共享 groupId 便于追溯
  const groupId = newGroupId()
  const evs = take.portions.map((p) =>
    appendTxnEvent({
      kind: 'out' as const,
      location: p.location,
      product: c.prod,
      batch: p.batch,
      qty: p.take,
      recorder: c.rec,
      note: c.nt,
      txnAt: c.when,
      groupId,
      requestId: c.requestId,
    }),
  )
  const dtWarning = await writeBack(evs)
  return { status: 200, body: { ok: true, seq: evs[0].seq, seqs: evs.map((e) => e.seq), portions: take.portions, dtWarning } }
}

/** 一件一码记账（带 moCodes）：入库查重；出库/转移按码所在批次精确扣减（不走 FIFO） */
async function moTxn(c: TxnCtx, codes: string[]): Promise<TxnResult> {
  const { state, index, log } = replayWithMo(readLedger())
  emitMoLog(log)
  const where = (code: string) => {
    const m = index.get(code)
    return m ? `${code}（在 ${m.location}）` : `${code}（不在库）`
  }
  const brief = (list: string[], f: (s: string) => string) => list.slice(0, 10).map(f).join('、') + (list.length > 10 ? ` 等 ${list.length} 个` : '')

  if (c.kind === 'in') {
    if (!c.registered.has(c.loc)) return fail(`库位 ${c.loc} 未登记或已停用，请先在设置中登记`)
    const dup = codes.filter((x) => index.has(x))
    if (dup.length) return fail(`MO 码已在库，不能重复入库：${brief(dup, where)}`)
    const ev = appendTxnEvent({
      kind: 'in',
      location: c.loc,
      product: c.prod,
      batch: c.bat,
      qty: codes.length,
      recorder: c.rec,
      note: c.nt,
      txnAt: c.when,
      moCodes: codes,
      requestId: c.requestId,
    })
    const dtWarning = await writeBack([ev])
    return { status: 200, body: { ok: true, seq: ev.seq, seqs: [ev.seq], portions: [{ location: c.loc, batch: c.bat, take: codes.length }], dtWarning } }
  }

  if (!c.loc) return fail('请选择库位')
  if (c.kind === 'move') {
    if (!c.registered.has(c.target)) return fail(`目标库位 ${c.target} 未登记或已停用`)
    if (c.target === c.loc) return fail('目标库位不能与原库位相同')
  }
  const verb = c.kind === 'out' ? '出库' : '转移'
  const notHere = codes.filter((x) => index.get(x)?.location !== c.loc)
  if (notHere.length) return fail(`MO 码不在库位 ${c.loc}，无法${verb}：${brief(notHere, where)}`)
  const wrong = codes.filter((x) => index.get(x)!.product !== c.prod)
  if (wrong.length) return fail(`MO 码图号与本笔不符（本笔 ${c.prod}）：${brief(wrong, (x) => `${x}（${index.get(x)!.product}）`)}`)

  // 按码所在批次精确扣减；批次已被校准改写（镜像后批次不存在/件数不够）的码，在本库位内按先进先出补齐
  const byBatch = new Map<string, string[]>()
  for (const x of codes) {
    const b = index.get(x)!.batch
    if (!byBatch.has(b)) byBatch.set(b, [])
    byBatch.get(b)!.push(x)
  }
  const parts = new Map<string, string[]>()
  const push = (b: string, cs: string[]) => parts.set(b, [...(parts.get(b) ?? []), ...cs])
  const leftover: string[] = []
  for (const [b, cs] of byBatch) {
    const key = `${c.loc}|${c.prod}|${b}`
    const cur = state.get(key)
    const n = Math.min(cur?.qty ?? 0, cs.length)
    if (n > 0) {
      push(b, cs.slice(0, n))
      cur!.qty -= n
      if (cur!.qty <= 0) state.delete(key)
    }
    leftover.push(...cs.slice(n))
  }
  if (leftover.length) {
    const take = fifoTake(state, new Set([c.loc]), c.prod, leftover.length)
    if (!take.ok) return fail(`库存不足：${c.loc} / ${c.prod} 台账件数少于扫码件数（差 ${leftover.length - take.total} 件），请先同步/核对`)
    let i = 0
    for (const p of take.portions) {
      push(p.batch, leftover.slice(i, i + p.take))
      i += p.take
    }
  }
  const groupId = parts.size > 1 ? newGroupId() : undefined
  const evs = [...parts.entries()].map(([b, cs]) =>
    appendTxnEvent({
      kind: c.kind,
      location: c.loc,
      targetLocation: c.kind === 'move' ? c.target : undefined,
      product: c.prod,
      batch: b,
      qty: cs.length,
      recorder: c.rec,
      note: c.nt,
      txnAt: c.when,
      groupId,
      moCodes: cs,
      requestId: c.requestId,
    }),
  )
  const dtWarning = await writeBack(evs)
  return {
    status: 200,
    body: { ok: true, seq: evs[0].seq, seqs: evs.map((e) => e.seq), portions: evs.map((e) => ({ location: e.location, batch: e.batch, take: e.qty })), dtWarning },
  }
}

/** 记一笔：入库/出库/转移，实时流水。出库与转移会校验现有库存；成功后回写钉钉流水。
 *  可选 moCodes（一件一码，件数须等于码数）与 requestId（幂等）。 */
async function processTxn(req: Request, requestId: string | undefined): Promise<TxnResult> {
  const { kind, location, targetLocation, product, batch, qty, recorder, note, txnAt, moCodes } = req.body ?? {}
  if (!KINDS.includes(kind)) return fail('操作类型应为 入库/出库/转移')
  let rec = String(recorder ?? '').trim()
  if (readConfig().lockRecorder) {
    const v = verifiedRecorder(req)
    if (!v.ok) return { status: 400, body: { message: LOCK_MSG, code: 'RECORDER_LOCKED' } }
    rec = v.name
  } else {
    if (!rec || rec.length > 20) return fail('请填写录入人（1-20 字）')
    if (BAD_CHARS.test(rec)) return fail('录入人含非法字符（检测到非 UTF-8 编码，请通过网页端录入）')
  }
  const loc = String(location ?? '').trim()
  const prod = String(product ?? '').trim()
  let bat = String(batch ?? '').trim()
  if (!prod || prod.length > 60 || BAD_CHARS.test(prod) || prod.includes('|')) return fail('产品图号不能为空、不超过 60 字符且不含竖线')
  if (bat.length > 40 || BAD_CHARS.test(bat) || bat.includes('|')) return fail('批次号不超过 40 字符且不含竖线（可不填）')
  const q = Number(qty)
  if (!Number.isInteger(q) || q < 1 || q > 1_000_000) return fail('件数须为 1-1000000 的整数')
  const nt = String(note ?? '').trim().slice(0, 100)
  if (BAD_CHARS.test(nt)) return fail('备注含非法字符')

  // 一件一码：MO 码清单（去空白、转大写），件数必须等于码数，同笔不可重复
  let codes: string[] | null = null
  if (moCodes != null) {
    if (!Array.isArray(moCodes)) return fail('moCodes 应为 MO 码数组')
    if (moCodes.length) {
      codes = moCodes.map((x: unknown) => String(x ?? '').trim().toUpperCase())
      if (codes.length > 1000) return fail('单笔 MO 码不超过 1000 个')
      const re = moRegex(readSettings().moPattern)
      const badCodes = codes.filter((x) => !re.test(x))
      if (badCodes.length) return fail(`MO 码格式不符（${re.source}）：${badCodes.slice(0, 10).join('、')}`)
      const dups = codes.filter((x, i) => codes!.indexOf(x) !== i)
      if (dups.length) return fail(`同一笔里 MO 码重复：${[...new Set(dups)].slice(0, 10).join('、')}`)
      if (q !== codes.length) return fail(`件数（${q}）须等于 MO 码数（${codes.length}）`)
    }
  }

  const at = String(txnAt ?? '').trim()
  const m = at.match(/^(\d{4}-\d{2}-\d{2})( \d{2}:\d{2}(:\d{2})?)?$/)
  if (!m) return fail('操作时间格式应为 YYYY-MM-DD HH:mm')
  const when = m[2] ? at : `${at} ${new Date().toTimeString().slice(0, 5)}`

  // 入库未显式给批次号时，按操作时间自动生成（MMDD-HHmm）
  if (kind === 'in' && !bat) {
    bat = `${when.slice(5, 7)}${when.slice(8, 10)}-${when.slice(11, 13)}${when.slice(14, 16)}`
  }

  const locations = readLocations()
  const registered = new Set(locations.filter((l) => l.enabled).map((l) => l.code))
  const target = String(targetLocation ?? '').trim()
  const ctx: TxnCtx = { kind, loc, target, prod, bat, q, rec, nt: nt || undefined, when, requestId, registered }

  if (codes) return moTxn(ctx, codes)

  if (kind === 'in') {
    if (!registered.has(loc)) return fail(`库位 ${loc} 未登记或已停用，请先在设置中登记`)
  } else if (kind === 'out' && !bat) {
    // 出库不指定批次 = 自动先进先出：该库位（小区域）下多批一次扣足，按停放最久优先跨批扣减
    if (!loc) return fail('请选择库位')
    return fifoOut(ctx, new Set([loc]), `库位 ${loc}`)
  } else {
    const { state } = replayState(readLedger())
    const cur = state.get(`${loc}|${prod}|${bat}`)
    if (!cur) return fail(`库位 ${loc} 没有产品 ${prod}${bat ? '（批次 ' + bat + '）' : ''}`)
    if (cur.qty < q) return fail(`库存不足：${loc} / ${prod}${bat ? ' / ' + bat : ''} 现有 ${cur.qty} 件`)
    if (kind === 'move') {
      if (!registered.has(target)) return fail(`目标库位 ${target} 未登记或已停用`)
      if (target === loc) return fail('目标库位不能与原库位相同')
    }
  }

  const ev = appendTxnEvent({
    kind,
    location: loc,
    product: prod,
    batch: bat,
    qty: q,
    recorder: rec,
    targetLocation: kind === 'move' ? target : undefined,
    note: nt || undefined,
    txnAt: when,
    requestId,
  })
  // 双向：本地已入账，再回写钉钉流水表；失败不阻塞（下次同步自动补写）
  const dtWarning = await writeBack([ev])
  return { status: 200, body: { ok: true, seq: ev.seq, dtWarning } }
}

/* ===== requestId 幂等：成功结果落盘保存 7 天，重复提交原样返回首次结果（附 duplicate: true） ===== */
const REQ_FILE = path.join(DATA_DIR, 'txn-requests.json')
const REQ_TTL = 7 * 86_400_000
const inflight = new Map<string, Promise<TxnResult>>()
function readReqs(): Record<string, { at: string; body: Record<string, unknown> }> {
  try {
    return JSON.parse(fs.readFileSync(REQ_FILE, 'utf8')) ?? {}
  } catch {
    return {}
  }
}
function saveReq(id: string, body: Record<string, unknown>) {
  const all = readReqs()
  const cutoff = Date.now() - REQ_TTL
  for (const [k, v] of Object.entries(all)) if (Date.parse(v.at) < cutoff) delete all[k]
  all[id] = { at: new Date().toISOString(), body }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(REQ_FILE, JSON.stringify(all), 'utf8')
}
/** 已落账但结果没来得及保存（如进程中途退出）：从台账按 requestId 还原 */
function recoverReq(id: string): Record<string, unknown> | null {
  const evs = readLedger().filter((e): e is TxnEvent => e.type === 'txn' && e.requestId === id)
  if (!evs.length) return null
  return { ok: true, seq: evs[0].seq, seqs: evs.map((e) => e.seq), portions: evs.map((e) => ({ location: e.location, batch: e.batch, take: e.qty })) }
}

app.post('/api/txn', async (req: Request, res: Response) => {
  const ridRaw = req.body?.requestId
  let rid = ''
  if (ridRaw != null && ridRaw !== '') {
    rid = String(ridRaw).trim()
    if (!/^[\w.:-]{1,64}$/.test(rid)) return bad(res, 'requestId 须为 1-64 位字母/数字/._:-')
    const done = readReqs()[rid]?.body ?? recoverReq(rid)
    if (done) return res.json({ ...done, duplicate: true })
    const running = inflight.get(rid)
    if (running) {
      const r = await running
      return res.status(r.status).json(r.status === 200 ? { ...r.body, duplicate: true } : r.body)
    }
  }
  const p = processTxn(req, rid || undefined)
  if (rid) inflight.set(rid, p)
  try {
    const r = await p
    if (rid && r.status === 200) saveReq(rid, r.body)
    res.status(r.status).json(r.body)
  } catch (e) {
    res.status(500).json({ message: `记账异常：${(e as Error).message}` })
  } finally {
    if (rid) inflight.delete(rid)
  }
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
/** 服务地址信息：前端提示手机用 https 地址打开（摄像头扫码） */
app.get('/api/server-info', (_req: Request, res: Response) => {
  res.json({ httpPort: PORT, httpsPort: HTTPS_PORT || null, lan: lanIPv4() })
})

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
  const { yellowDays, redDays, moPattern } = req.body ?? {}
  const y = Number(yellowDays)
  const r = Number(redDays)
  const s = {
    yellowDays: Number.isInteger(y) ? Math.min(365, Math.max(1, y)) : cur.yellowDays,
    redDays: Number.isInteger(r) ? Math.min(365, Math.max(1, r)) : cur.redDays,
    moPattern: cur.moPattern,
  }
  if (s.redDays < s.yellowDays) return bad(res, '红色阈值不能小于黄色阈值')
  if (moPattern !== undefined) {
    const p = String(moPattern ?? '').trim()
    if (!p || p.length > 100) return bad(res, 'MO 码规则（正则）不能为空且不超过 100 字符')
    try {
      new RegExp(p)
    } catch {
      return bad(res, `MO 码规则不是合法的正则表达式：${p}`)
    }
    s.moPattern = p
  }
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
          ? (e.kind === 'move'
            ? `${e.location} → ${e.targetLocation} · ${e.product}${e.batch ? ' / ' + e.batch : ''} × ${e.qty}`
            : `${e.location} · ${e.product}${e.batch ? ' / ' + e.batch : ''} × ${e.qty}`) + (e.moCodes?.length ? ` · MO ${e.moCodes.length} 码` : '')
          : e.type === 'mirror'
            ? `${e.records.length} 批 / ${e.records.reduce((s, r) => s + r.qty, 0)} 件（与钉钉表格对齐）`
            : `${e.records.length} 条记录`,
    })),
  })
})

/* ===================== 第一期 PDA 扫码：MES 清单 / 扫码解析 / MO 在库 ===================== */

const xlsxBody = express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: '20mb' })
const textOk = (s: string, max: number) => s.length <= max && !BAD_CHARS.test(s) && !s.includes('|')

/** MES 清单导入：JSON {text}（粘贴 TSV/CSV）或直接上传 xlsx 二进制；按表头名识别列，同码覆盖更新 */
app.post('/api/momap/import', xlsxBody, async (req: Request, res: Response) => {
  let parsed: { rows: Record<string, string>[]; error?: string }
  if (Buffer.isBuffer(req.body)) {
    if (!req.body.length) return bad(res, '上传的文件为空')
    parsed = await parseXlsx(req.body)
  } else {
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return bad(res, '请粘贴 MES 导出清单（含表头）或上传 xlsx')
    parsed = parseText(text)
  }
  if (parsed.error) return bad(res, parsed.error)
  if (!parsed.rows.length) return bad(res, '清单只有表头，没有数据行')
  const r = importRows(parsed.rows, readSettings().moPattern)
  res.json({ ok: true, ...r, mapSize: Object.keys(readMoMap()).length })
})

/** 对照表查询：q 匹配 码/物料编号/名称/图号/模号/单据编号（不区分大小写） */
app.get('/api/momap', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const map = readMoMap()
  const { index } = replayWithMo(readLedger())
  const all = Object.entries(map)
  const hits = q
    ? all.filter(([code, e]) =>
        [code, e.materialNo, e.materialName, e.drawingNo, e.moldNo, e.docNo].some((v) => String(v ?? '').toLowerCase().includes(q)),
      )
    : all
  hits.sort((a, b) => b[0].localeCompare(a[0]))
  res.json({
    total: all.length,
    matched: hits.length,
    items: hits.slice(0, limit).map(([code, e]) => {
      const st = index.get(code)
      return { code, ...e, stock: st ? { location: st.location, product: st.product, batch: st.batch, inAt: st.inAt } : null }
    }),
  })
})

/** 手工修正 / 补录一条（未导入的码也可新建，需给物料图号） */
app.put('/api/momap/:code', (req: Request, res: Response) => {
  const code = String(req.params.code ?? '').trim().toUpperCase()
  const re = moRegex(readSettings().moPattern)
  if (!re.test(code)) return bad(res, `模号唯一码格式不符（${re.source}）`)
  const b = req.body ?? {}
  const map = readMoMap()
  const cur = map[code]
  const pick = (k: keyof MoEntry, max: number) => {
    const v = b[k] === undefined ? String(cur?.[k] ?? '') : String(b[k] ?? '').trim()
    return v.slice(0, max)
  }
  const next: MoEntry = {
    materialNo: pick('materialNo', 40),
    materialName: pick('materialName', 60),
    drawingNo: pick('drawingNo', 60),
    moldNo: pick('moldNo', 40),
    docNo: pick('docNo', 40),
    importedAt: new Date().toISOString(),
    manual: true,
  }
  if (!next.drawingNo) return bad(res, '物料图号不能为空')
  for (const v of Object.values(next)) if (typeof v === 'string' && !textOk(v, 60)) return bad(res, '字段含非法字符或竖线')
  map[code] = next
  writeMoMap(map)
  res.json({ ok: true, created: !cur, entry: { code, ...next } })
})

/** 图号别名：物料编号 / MES 原图号 → 钉钉「产品图号」选项（PDA 人工选一次后记住） */
app.get('/api/momap/alias', (_req: Request, res: Response) => {
  res.json({ alias: readAlias() })
})
app.post('/api/momap/alias', (req: Request, res: Response) => {
  const materialNo = String(req.body?.materialNo ?? '').trim()
  const drawingNo = String(req.body?.drawingNo ?? '').trim()
  const target = String(req.body?.target ?? '').trim()
  if (!materialNo && !drawingNo) return bad(res, '需提供物料编号或原图号')
  if (!target || !textOk(target, 60)) return bad(res, '目标图号不能为空、不超过 60 字符且不含竖线')
  if (!textOk(materialNo, 40) || !textOk(drawingNo, 60)) return bad(res, '物料编号/原图号含非法字符')
  const alias = readAlias()
  if (materialNo) alias[materialNo] = target
  if (drawingNo) alias[drawingNo] = target
  writeAlias(alias)
  res.json({ ok: true, keys: [materialNo, drawingNo].filter(Boolean), target })
})

/** 扫码解析：库位码 → location；MO 码 → mo（含物料信息、图号对齐、在库位置）；其余 → product */
app.get('/api/scan/resolve', async (req: Request, res: Response) => {
  const raw = String(req.query.code ?? '').trim()
  if (!raw) return bad(res, '缺少扫码内容 code')
  if (raw.length > 200 || BAD_CHARS.test(raw)) return res.json({ type: 'unknown', code: raw.slice(0, 200), message: '无法识别的扫码内容' })
  const up = raw.toUpperCase()
  const loc = readLocations().find((l) => l.code === up)
  if (loc) return res.json({ type: 'location', code: up, location: loc })

  if (moRegex(readSettings().moPattern).test(up)) {
    const { index, log } = replayWithMo(readLedger())
    emitMoLog(log)
    const st = index.get(up)
    const stock = st ? { location: st.location, product: st.product, batch: st.batch, inAt: st.inAt } : null
    const entry = readMoMap()[up]
    if (!entry) {
      return res.json({
        type: 'mo',
        code: up,
        mo: { code: up, imported: false, materialNo: '', materialName: '', drawingNo: st?.product ?? '', rawDrawingNo: '', moldNo: '', docNo: '', aligned: st ? 'stock' : 'none' },
        stock,
        needPick: !st,
      })
    }
    const options = await readProductOptions()
    const al = alignDrawing(entry.materialNo, entry.drawingNo, options)
    return res.json({
      type: 'mo',
      code: up,
      mo: {
        code: up,
        imported: true,
        materialNo: entry.materialNo,
        materialName: entry.materialName,
        drawingNo: al.drawing,
        rawDrawingNo: entry.drawingNo,
        moldNo: entry.moldNo,
        docNo: entry.docNo,
        aligned: al.via,
      },
      stock,
      // 已在库的码以台账图号为准，无需再选
      needPick: !st && al.needPick,
    })
  }

  if (raw.length > 60 || raw.includes('|')) return res.json({ type: 'unknown', code: raw, message: '既不是库位码/MO 码，也不像产品图号' })
  res.json({ type: 'product', code: raw, product: raw })
})

/** MO 在库索引查询（按库位/图号/码过滤）+ 最近的校准日志 */
app.get('/api/mo/stock', (req: Request, res: Response) => {
  const location = String(req.query.location ?? '').trim().toUpperCase()
  const product = String(req.query.product ?? '').trim()
  const code = String(req.query.code ?? '').trim().toUpperCase()
  const { index, log } = replayWithMo(readLedger())
  emitMoLog(log)
  const items = [...index.values()]
    .filter((m) => (!location || m.location === location) && (!product || m.product === product) && (!code || m.code === code))
    .sort((a, b) => a.inAt.localeCompare(b.inAt) || a.code.localeCompare(b.code))
  res.json({ total: index.size, count: items.length, items, log: log.slice(-50) })
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
  const lan = lanIPv4()
  console.log(`[白区库存管理] 服务已启动: http://localhost:${PORT}`)
  for (const ip of lan) console.log(`[白区库存管理] 局域网访问: http://${ip}:${PORT}`)
})

// 可选 HTTPS（手机浏览器摄像头扫码需要安全上下文）：设置 HTTPS_PORT 时额外启动，同一个 app
if (HTTPS_PORT) {
  try {
    const c = loadOrCreateCert(DATA_DIR)
    if (c.generated) console.log(`[白区库存管理] 已自动生成自签 HTTPS 证书: ${c.dir}`)
    else console.log(`[白区库存管理] 使用 HTTPS 证书: ${c.dir}`)
    https.createServer({ key: c.key, cert: c.cert }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[白区库存管理] HTTPS 已启动: https://localhost:${HTTPS_PORT}`)
      for (const ip of lanIPv4()) console.log(`[白区库存管理] 局域网 HTTPS（手机摄像头扫码用）: https://${ip}:${HTTPS_PORT}/#pda`)
    })
  } catch (e) {
    console.error(`[白区库存管理] HTTPS 启动失败（HTTP 不受影响）: ${(e as Error).message}`)
  }
}
