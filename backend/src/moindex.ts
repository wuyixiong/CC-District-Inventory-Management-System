/**
 * MO 码在库索引（一件一码防重）：由台账重放得出，与库存状态同一次重放、同一口径。
 *
 * - 带 moCodes 的入库：码加入索引（记库位/图号/批次/入库时间）；出库：移除；转移：移到目标库位（批次不变）。
 * - 不带 moCodes 的出库/转移（钉钉同步行、网页端手填）：该库位×图号件数若少于索引码数，
 *   按先进先出移除（转移则移到目标库位）最早入库的码，使「码数 ≤ 件数」恒成立。
 * - 镜像校准 / 全区快照（不带 moCodes）：校准后若某库位×图号件数少于索引码数，
 *   按「最早入库的码保留」裁剪多余码，并记日志（审计可追溯）。
 */
import type { LedgerEvent } from './store'
import { replayState, type StockItem } from './compute'

export interface MoStock {
  code: string
  location: string
  product: string
  batch: string
  inAt: string // 入库操作时间 'YYYY-MM-DD HH:mm'
  seq: number // 入库事件序号
}

export interface MoReplay {
  state: Map<string, StockItem>
  lastEvent: LedgerEvent | null
  index: Map<string, MoStock>
  log: string[]
}

const lpKey = (loc: string, prod: string) => `${loc}|${prod}`
const byAge = (a: MoStock, b: MoStock) => a.inAt.localeCompare(b.inAt) || a.seq - b.seq || a.code.localeCompare(b.code)

export function replayWithMo(events: LedgerEvent[]): MoReplay {
  const index = new Map<string, MoStock>()
  const byLp = new Map<string, Set<string>>() // 库位|图号 → 在库码
  const log: string[] = []

  const add = (m: MoStock) => {
    remove(m.code)
    index.set(m.code, m)
    const k = lpKey(m.location, m.product)
    if (!byLp.has(k)) byLp.set(k, new Set())
    byLp.get(k)!.add(m.code)
  }
  function remove(code: string) {
    const m = index.get(code)
    if (!m) return
    index.delete(code)
    const k = lpKey(m.location, m.product)
    const s = byLp.get(k)
    if (s) {
      s.delete(code)
      if (!s.size) byLp.delete(k)
    }
  }
  const qtyOf = (state: Map<string, StockItem>, loc: string, prod: string) => {
    const prefix = `${loc}|${prod}|`
    let n = 0
    for (const [k, v] of state) if (k.startsWith(prefix)) n += v.qty
    return n
  }
  const codesAt = (loc: string, prod: string) =>
    [...(byLp.get(lpKey(loc, prod)) ?? [])].map((c) => index.get(c)!).sort(byAge)

  const hook = (e: LedgerEvent, state: Map<string, StockItem>) => {
    if (e.type === 'txn') {
      const codes = e.moCodes ?? []
      if (codes.length) {
        for (const code of codes) {
          if (e.kind === 'in') add({ code, location: e.location, product: e.product, batch: e.batch, inAt: e.txnAt, seq: e.seq })
          else if (e.kind === 'out') remove(code)
          else if (e.targetLocation) {
            const m = index.get(code)
            add({ code, location: e.targetLocation, product: e.product, batch: e.batch, inAt: m?.inAt ?? e.txnAt, seq: m?.seq ?? e.seq })
          }
        }
        return
      }
      if (e.kind === 'in') return
      // 无码出库/转移：件数不足以容纳在库码时，按先进先出处理最早入库的码
      const list = codesAt(e.location, e.product)
      const excess = list.length - qtyOf(state, e.location, e.product)
      if (excess <= 0) return
      const moved = list.slice(0, excess)
      for (const m of moved) {
        if (e.kind === 'move' && e.targetLocation) add({ ...m, location: e.targetLocation })
        else remove(m.code)
      }
      log.push(
        `#${e.seq} 无码${e.kind === 'out' ? '出库' : '转移'} ${e.location}/${e.product}：按先进先出${e.kind === 'out' ? '移出' : '转至 ' + e.targetLocation} ${moved.length} 个码 ${moved.map((m) => m.code).join(',')}`,
      )
      return
    }
    // 镜像校准 / 全区快照：码数超出件数的库位×图号，保留最早入库的码
    for (const k of [...byLp.keys()]) {
      const [loc, prod] = k.split('|')
      const list = codesAt(loc, prod)
      const qty = qtyOf(state, loc, prod)
      if (list.length <= qty) continue
      const dropped = list.slice(qty)
      for (const m of dropped) remove(m.code)
      log.push(
        `#${e.seq} ${e.type === 'mirror' ? '镜像校准' : '快照校准'} ${loc}/${prod}：件数 ${qty} < 在库码 ${list.length}，按最早入库保留 ${qty} 个，移除 ${dropped.map((m) => m.code).join(',')}`,
      )
    }
  }

  const { state, lastEvent } = replayState(events, hook)
  return { state, lastEvent, index, log }
}

/** 校准日志每条只打印一次（重放每次请求都会发生，避免刷屏） */
const printed = new Set<string>()
export function emitMoLog(log: string[]) {
  for (const line of log) {
    if (printed.has(line)) continue
    printed.add(line)
    console.warn(`[MO 在库索引] ${line}`)
  }
}
