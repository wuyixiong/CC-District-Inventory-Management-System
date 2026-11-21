import fs from 'node:fs'
import path from 'node:path'

export interface DayRecord {
  location: string
  product: string // 产品图号
  batch: string // 批次号（选填，空 = 不分批次）
  qty: number
}

/** 台账事件：一次「某日全区域快照」的提交。只追加、不修改；同日重复提交为修正版（revision 递增）。 */
export interface DayEvent {
  seq: number
  type: 'day'
  date: string // YYYY-MM-DD
  recorder: string
  recordedAt: string // ISO
  revision: number
  records: DayRecord[]
}

export type TxnKind = 'in' | 'out' | 'move'

/** 镜像记录：以钉钉表格当前状态为准的一条库存快照（库位×产品×批次×件数+起算日）。 */
export interface MirrorRecord {
  location: string
  product: string
  batch: string
  qty: number
  since: string
}

/** 台账事件：镜像校准（镜像模式下每次同步后与钉钉表格对齐，仅状态有变化时追加）。 */
export interface MirrorEvent {
  seq: number
  type: 'mirror'
  at: string // ISO，同步时间
  records: MirrorRecord[]
}

/** 台账事件：记一笔（入库/出库/转移），实时流水。 */
export interface TxnEvent {
  seq: number
  type: 'txn'
  kind: TxnKind
  location: string
  targetLocation?: string // 转移目标
  product: string // 产品图号
  batch: string // 批次号（选填）
  qty: number
  recorder: string
  note?: string
  txnAt: string // 'YYYY-MM-DD HH:mm'，操作时间
  recordedAt: string // ISO，服务端落账时间
  source?: 'dingtalk' // 录入来源（缺省 = 网页端记一笔）
  sourceId?: string // 来源记录ID（钉钉行ID，同步去重用）
  groupId?: string // 跨批拆分组ID（网页端一笔跨批出库拆出的多条事件共用，便于追溯）
  moCodes?: string[] // 本笔涉及的 MES 模号唯一码（一码一件，PDA 扫码录入；件数 = 码数）
  requestId?: string // 客户端请求ID（幂等：重复提交返回首次结果）
}

export type LedgerEvent = DayEvent | TxnEvent | MirrorEvent

export interface LocationItem {
  code: string
  zone: string
  note: string
  enabled: boolean
}

export interface Settings {
  yellowDays: number
  redDays: number
  moPattern: string // MES 模号唯一码正则（PDA 扫码识别 MO 码），默认 ^MO\d{12}$
}

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const LEDGER = path.join(DATA_DIR, 'snapshots.jsonl')
const LOC_FILE = path.join(DATA_DIR, 'locations.json')
const SET_FILE = path.join(DATA_DIR, 'settings.json')

export const DEFAULT_SETTINGS: Settings = { yellowDays: 3, redDays: 5, moPattern: '^MO\\d{12}$' }

export function readLedger(): LedgerEvent[] {
  if (!fs.existsSync(LEDGER)) return []
  const out: LedgerEvent[] = []
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as LedgerEvent
      if (e && e.type === 'day' && typeof e.date === 'string' && Array.isArray(e.records)) out.push(e)
      else if (e && e.type === 'txn' && typeof e.product === 'string') out.push(e)
      else if (e && e.type === 'mirror' && Array.isArray(e.records)) out.push(e)
    } catch {
      // 单行损坏不拖垮整个台账，跳过
    }
  }
  return out
}

export function nextSeq(): number {
  const events = readLedger()
  return (events.length ? events[events.length - 1].seq : 0) + 1
}

export function appendDayEvent(date: string, recorder: string, records: DayRecord[]): DayEvent {
  const events = readLedger()
  const ev: DayEvent = {
    seq: nextSeq(),
    type: 'day',
    date,
    recorder,
    recordedAt: new Date().toISOString(),
    revision: events.filter((e) => e.type === 'day' && e.date === date).length + 1,
    records,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.appendFileSync(LEDGER, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

export function appendTxnEvent(t: {
  kind: TxnKind
  location: string
  product: string
  batch: string
  qty: number
  recorder: string
  targetLocation?: string
  note?: string
  txnAt: string
  source?: 'dingtalk'
  sourceId?: string
  groupId?: string
  moCodes?: string[]
  requestId?: string
}): TxnEvent {
  const ev: TxnEvent = {
    seq: nextSeq(),
    type: 'txn',
    kind: t.kind,
    location: t.location,
    targetLocation: t.targetLocation,
    product: t.product,
    batch: t.batch,
    qty: t.qty,
    recorder: t.recorder,
    note: t.note,
    txnAt: t.txnAt,
    recordedAt: new Date().toISOString(),
    source: t.source,
    sourceId: t.sourceId,
    groupId: t.groupId,
    moCodes: t.moCodes && t.moCodes.length ? t.moCodes : undefined,
    requestId: t.requestId,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.appendFileSync(LEDGER, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

export function appendMirrorEvent(records: MirrorRecord[]): MirrorEvent {
  const ev: MirrorEvent = {
    seq: nextSeq(),
    type: 'mirror',
    at: new Date().toISOString(),
    records,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.appendFileSync(LEDGER, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

export interface EffectiveDay {
  date: string
  recorder: string
  recordedAt: string
  revision: number
  byKey: Map<string, DayRecord>
}

/** 每个日期的有效快照 = 该日最后一个事件（修正版覆盖早版，早版仍留在文件里可审计）。 */
export function effectiveDays(events: DayEvent[]): Map<string, EffectiveDay> {
  const m = new Map<string, EffectiveDay>()
  for (const e of events) {
    m.set(e.date, {
      date: e.date,
      recorder: e.recorder,
      recordedAt: e.recordedAt,
      revision: e.revision,
      byKey: new Map(e.records.map((r) => [`${r.location}|${r.product}|${r.batch}`, r])),
    })
  }
  return m
}

export function readLocations(): LocationItem[] {
  if (!fs.existsSync(LOC_FILE)) return []
  try {
    const arr = JSON.parse(fs.readFileSync(LOC_FILE, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((l: any) => l && typeof l.code === 'string')
      .map((l: any) => ({ code: l.code, zone: String(l.zone ?? ''), note: String(l.note ?? ''), enabled: l.enabled !== false }))
  } catch {
    return []
  }
}

export function writeLocations(list: LocationItem[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(LOC_FILE, JSON.stringify(list, null, 2), 'utf8')
}

export function readSettings(): Settings {
  if (!fs.existsSync(SET_FILE)) return { ...DEFAULT_SETTINGS }
  try {
    const s = JSON.parse(fs.readFileSync(SET_FILE, 'utf8'))
    return {
      yellowDays: clampInt(s.yellowDays, DEFAULT_SETTINGS.yellowDays, 1, 365),
      redDays: clampInt(s.redDays, DEFAULT_SETTINGS.redDays, 1, 365),
      moPattern: typeof s.moPattern === 'string' && s.moPattern.trim() ? s.moPattern.trim() : DEFAULT_SETTINGS.moPattern,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(s: Settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SET_FILE, JSON.stringify(s, null, 2), 'utf8')
}

export function ledgerPath() {
  return LEDGER
}

function clampInt(v: unknown, dft: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isInteger(n)) return dft
  return Math.min(max, Math.max(min, n))
}
