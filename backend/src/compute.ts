import type { DayRecord, EffectiveDay, LedgerEvent, LocationItem, Settings, TxnEvent } from './store'
import { effectiveDays } from './store'

export type BatchState = 'ok' | 'yellow' | 'red'

export interface BatchView {
  location: string
  product: string // 产品图号
  batch: string // 批次号（可为空）
  qty: number
  since: string // 停放起始日（入位/转移至该库位/快照回溯的首日）
  days: number // 停放天数 = 今天 - since（日历天）
  state: BatchState
}

export interface LocationView {
  code: string
  zone: string
  note: string
  registered: boolean
  enabled: boolean
  batches: number
  qty: number
  maxDays: number
  state: 'empty' | 'ok' | 'yellow' | 'red'
  items: BatchView[]
}

export interface Board {
  asOf: string // 数据日（最后一个事件的日期）
  lastAt: string // 最后记一笔时间
  recorder: string // 最后记录人
  seq: number // 最后事件序号
  totals: { locations: number; batches: number; qty: number; overage: number }
  locations: LocationView[]
  overageList: BatchView[]
}

const DAY_MS = 86_400_000
// 用本地日期（toISOString 是 UTC，凌晨时段会差一天）
const todayStr = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 10)
}
const calDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / DAY_MS)
const stateOf = (days: number, s: Settings): BatchState => (days >= s.redDays ? 'red' : days >= s.yellowDays ? 'yellow' : 'ok')

/**
 * 状态机：台账按追加顺序重放。
 * - day 事件 = 全量校准点：把状态重置为该日快照（since 沿用快照回溯口径）
 * - txn 事件 = 增量：入库入账、出库扣减、转移扣源加目标（转移后停放在新库位重新起算）
 */
function runsAt(datesAsc: string[], eff: Map<string, EffectiveDay>, idx: number): Map<string, { record: DayRecord; since: string }> {
  const cur = eff.get(datesAsc[idx])!
  const out = new Map<string, { record: DayRecord; since: string }>()
  for (const [key, record] of cur.byKey) {
    let j = idx
    while (j > 0 && eff.get(datesAsc[j - 1])!.byKey.has(key)) j--
    out.set(key, { record, since: datesAsc[j] })
  }
  return out
}

export interface StockItem {
  qty: number
  since: string
}

/** 事件的时间戳（用于判定"数据截至"：取时间上最新的一笔，而非最后追加的一笔） */
const timeKeyOf = (e: LedgerEvent): string =>
  e.type === 'txn' ? e.txnAt : e.type === 'day' ? `${e.date} 23:59` : e.at.slice(0, 16).replace('T', ' ')

export function replayState(events: LedgerEvent[]): { state: Map<string, StockItem>; lastEvent: LedgerEvent | null } {
  const eff = effectiveDays(events.filter((e): e is import('./store').DayEvent => e.type === 'day'))
  const datesAsc = [...eff.keys()].sort()

  const state = new Map<string, StockItem>()
  let lastEvent: LedgerEvent | null = null
  let lastKey = ''

  for (const e of events) {
    if (e.type === 'day') {
      const i = datesAsc.indexOf(e.date)
      state.clear()
      if (i >= 0) {
        for (const [key, r] of runsAt(datesAsc, eff, i)) state.set(key, { qty: r.record.qty, since: r.since })
      }
    } else if (e.type === 'mirror') {
      // 镜像校准：整体重置为钉钉表格当前状态（钉钉删行/改行由此生效）
      state.clear()
      for (const r of e.records) state.set(`${r.location}|${r.product}|${r.batch}`, { qty: r.qty, since: r.since })
    } else {
      const d = e.txnAt.slice(0, 10)
      const key = `${e.location}|${e.product}|${e.batch}`
      if (e.kind === 'in') {
        const cur = state.get(key)
        if (cur) cur.qty += e.qty
        else state.set(key, { qty: e.qty, since: d })
      } else {
        const cur = state.get(key)
        if (cur) {
          cur.qty -= e.qty
          if (cur.qty <= 0) state.delete(key)
        }
      }
      if (e.kind === 'move' && e.targetLocation) {
        const tkey = `${e.targetLocation}|${e.product}|${e.batch}`
        const t = state.get(tkey)
        if (t) t.qty += e.qty
        else state.set(tkey, { qty: e.qty, since: d })
      }
    }
    const k = timeKeyOf(e)
    if (k >= lastKey) {
      lastKey = k
      lastEvent = e
    }
  }
  return { state, lastEvent }
}

/** 库位号自然排序：白区编号无补零（1b2 会排在 1b10 前才算对），楼层降序、层内 C→B→A、序号升序；
 *  非该结构（如 A01）退回字典序。区域节的前后顺序由前端 zoneGroups 决定，这里只保证节内顺序。 */
export function cmpLocCode(a: string, b: string): number {
  const pa = a.match(/^(\d)([A-Z])(\d{1,2})(.*)$/)
  const pb = b.match(/^(\d)([A-Z])(\d{1,2})(.*)$/)
  if (pa && pb) {
    if (pa[1] !== pb[1]) return Number(pb[1]) - Number(pa[1])
    if (pa[2] !== pb[2]) return 'CBA'.indexOf(pa[2]) - 'CBA'.indexOf(pb[2])
    if (Number(pa[3]) !== Number(pb[3])) return Number(pa[3]) - Number(pb[3])
    return (pa[4] || '').localeCompare(pb[4] || '')
  }
  return a.localeCompare(b)
}

export function boardFromState(
  state: Map<string, StockItem>,
  lastEvent: LedgerEvent | null,
  settings: Settings,
  locations: LocationItem[],
): Board {
  const today = todayStr()
  const items: BatchView[] = []
  for (const [key, s] of state) {
    const [location, product, batch] = key.split('|')
    const days = Math.max(0, calDiff(today, s.since))
    items.push({ location, product, batch: batch ?? '', qty: s.qty, since: s.since, days, state: stateOf(days, settings) })
  }

  const locMap = new Map(locations.map((l) => [l.code, l]))
  const byLoc = new Map<string, BatchView[]>()
  for (const it of items) {
    if (!byLoc.has(it.location)) byLoc.set(it.location, [])
    byLoc.get(it.location)!.push(it)
  }
  const codes = new Set<string>([...locMap.keys(), ...byLoc.keys()])
  const locViews: LocationView[] = []
  for (const code of [...codes].sort(cmpLocCode)) {
    const l = locMap.get(code)
    const its = (byLoc.get(code) ?? []).sort((a, b) => b.days - a.days)
    const qty = its.reduce((s, i) => s + i.qty, 0)
    const maxDays = its.length ? Math.max(...its.map((i) => i.days)) : 0
    const state = !its.length ? 'empty' : stateOf(maxDays, settings)
    locViews.push({ code, zone: l?.zone ?? '', note: l?.note ?? '', registered: !!l, enabled: l?.enabled ?? false, batches: its.length, qty, maxDays, state, items: its })
  }

  const overageList = items.filter((i) => i.state !== 'ok').sort((a, b) => b.days - a.days || a.location.localeCompare(b.location))
  return {
    asOf: lastEvent ? timeKeyOf(lastEvent).slice(0, 10) : today,
    lastAt: lastEvent
      ? lastEvent.type === 'txn'
        ? lastEvent.txnAt
        : lastEvent.type === 'day'
          ? lastEvent.date
          : lastEvent.at.slice(0, 16).replace('T', ' ')
      : '',
    recorder: lastEvent ? (lastEvent.type === 'mirror' ? '钉钉同步' : lastEvent.recorder) : '',
    seq: lastEvent ? lastEvent.seq : 0,
    totals: {
      locations: locViews.filter((v) => v.batches > 0).length,
      batches: items.length,
      qty: items.reduce((s, i) => s + i.qty, 0),
      overage: overageList.length,
    },
    locations: locViews,
    overageList,
  }
}

export function buildBoard(events: LedgerEvent[], settings: Settings, locations: LocationItem[]): Board {
  const { state, lastEvent } = replayState(events)
  return boardFromState(state, lastEvent, settings, locations)
}
