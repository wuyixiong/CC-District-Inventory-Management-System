/**
 * MES 模号唯一码（MO 码）对照表 —— 第一期 PDA 扫码录入。
 *
 * - mo-map.json：{ [moCode]: { materialNo, materialName, drawingNo, moldNo, docNo, importedAt } }
 *   由设置页「MES 清单导入」写入（粘贴 TSV/CSV 或上传 xlsx），同码覆盖更新；也可手工修正。
 * - drawing-alias.json：{ [物料编号 | 原图号]: 钉钉图号选项 }，PDA 端人工确认图号时写入，下次自动对齐。
 *
 * 一码 = 一件产品；一码对应一个物料图号。图号对齐顺序：钉钉选项全文 → 去括号部分 → alias → 原文（needPick）。
 */
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { DATA_DIR } from './store'

export interface MoEntry {
  materialNo: string
  materialName: string
  drawingNo: string // MES 物料图号原文（可能带括号变体，如 92056593(6545、6563)）
  moldNo: string
  docNo: string
  importedAt: string // ISO
  manual?: boolean // 手工新增/修正
}

const MAP_FILE = () => path.join(DATA_DIR, 'mo-map.json')
const ALIAS_FILE = () => path.join(DATA_DIR, 'drawing-alias.json')

export const DEFAULT_MO_PATTERN = '^MO\\d{12}$'

function readJson<T>(file: string, dft: T): T {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as T) : dft
  } catch {
    return dft
  }
}
function writeJson(file: string, v: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1), 'utf8')
  fs.renameSync(tmp, file)
}

export const readMoMap = () => readJson<Record<string, MoEntry>>(MAP_FILE(), {})
export const writeMoMap = (m: Record<string, MoEntry>) => writeJson(MAP_FILE(), m)
export const readAlias = () => readJson<Record<string, string>>(ALIAS_FILE(), {})
export const writeAlias = (m: Record<string, string>) => writeJson(ALIAS_FILE(), m)

export function moRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern || DEFAULT_MO_PATTERN)
  } catch {
    return new RegExp(DEFAULT_MO_PATTERN)
  }
}

// ---------------------------------------------------------------------------
// 清单解析：按表头名识别列（列顺序不限，多余列忽略）
// ---------------------------------------------------------------------------

const COLS = {
  code: '模号唯一码',
  materialNo: '物料编号',
  materialName: '物料名称',
  drawingNo: '物料图号',
  moldNo: '模号',
  docNo: '单据编号',
} as const

/** 一行 CSV（支持双引号包裹与 "" 转义） */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"' && cur === '') q = true
    else if (ch === ',' || ch === '，') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** 二维表（首个含「模号唯一码」的行为表头）→ 行对象 */
export function rowsFromTable(table: string[][]): { rows: Record<string, string>[]; error?: string } {
  const hi = table.findIndex((r) => r.some((c) => c.trim() === COLS.code))
  if (hi < 0) return { rows: [], error: `未找到表头「${COLS.code}」（需含列：${COLS.code}、${COLS.drawingNo}）` }
  const header = table[hi].map((c) => c.trim().replace(/^﻿/, ''))
  if (!header.includes(COLS.drawingNo)) return { rows: [], error: `表头缺少「${COLS.drawingNo}」列` }
  const rows: Record<string, string>[] = []
  for (const r of table.slice(hi + 1)) {
    if (!r.some((c) => c.trim())) continue
    const o: Record<string, string> = {}
    header.forEach((h, i) => {
      // 同名列（如「模号」只取第一次出现，避免被后面的同名列覆盖）
      if (h && !(h in o)) o[h] = String(r[i] ?? '').trim()
    })
    rows.push(o)
  }
  return { rows }
}

/** 粘贴文本：含制表符按 TSV，否则按 CSV */
export function parseText(text: string): { rows: Record<string, string>[]; error?: string } {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)
  const headerLine = lines.find((l) => l.includes(COLS.code)) ?? ''
  const tsv = headerLine.includes('\t')
  return rowsFromTable(lines.map((l) => (tsv ? l.split('\t') : splitCsvLine(l))))
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as any
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('')
    if ('text' in o) return String(o.text ?? '')
    if ('result' in o) return String(o.result ?? '')
    return ''
  }
  return String(v)
}

export async function parseXlsx(buf: Buffer): Promise<{ rows: Record<string, string>[]; error?: string }> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as any)
  } catch (e) {
    return { rows: [], error: `xlsx 解析失败：${(e as Error).message}（仅支持 .xlsx，旧版 .xls 请另存为 .xlsx）` }
  }
  let lastErr = '文件中没有工作表'
  for (const ws of wb.worksheets) {
    const table: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellText(cell.value).trim()
      })
      table.push(Array.from(cells, (c) => c ?? ''))
    })
    const r = rowsFromTable(table)
    if (!r.error) return r
    lastErr = r.error
  }
  return { rows: [], error: lastErr }
}

export interface ImportResult {
  total: number
  added: number
  updated: number
  unchanged: number
  skipped: number
  skippedRows: { row: number; code: string; reason: string }[]
}

/** 导入：同码覆盖更新；无效行（码为空/不符 MO 格式/缺图号）跳过并给原因 */
export function importRows(rows: Record<string, string>[], pattern: string): ImportResult {
  const re = moRegex(pattern)
  const map = readMoMap()
  const now = new Date().toISOString()
  const res: ImportResult = { total: rows.length, added: 0, updated: 0, unchanged: 0, skipped: 0, skippedRows: [] }
  const skip = (i: number, code: string, reason: string) => {
    res.skipped++
    if (res.skippedRows.length < 50) res.skippedRows.push({ row: i + 1, code, reason })
  }
  rows.forEach((r, i) => {
    const code = String(r[COLS.code] ?? '').trim().toUpperCase()
    const drawingNo = String(r[COLS.drawingNo] ?? '').trim()
    if (!code) return skip(i, code, '模号唯一码为空')
    if (!re.test(code)) return skip(i, code, `模号唯一码格式不符（${re.source}）`)
    if (!drawingNo) return skip(i, code, '物料图号为空')
    if (drawingNo.length > 60 || drawingNo.includes('|')) return skip(i, code, '物料图号超过 60 字符或含竖线')
    const next: MoEntry = {
      materialNo: String(r[COLS.materialNo] ?? '').trim().slice(0, 40),
      materialName: String(r[COLS.materialName] ?? '').trim().slice(0, 60),
      drawingNo,
      moldNo: String(r[COLS.moldNo] ?? '').trim().slice(0, 40),
      docNo: String(r[COLS.docNo] ?? '').trim().slice(0, 40),
      importedAt: now,
    }
    const cur = map[code]
    if (!cur) res.added++
    else if (
      cur.materialNo === next.materialNo &&
      cur.materialName === next.materialName &&
      cur.drawingNo === next.drawingNo &&
      cur.moldNo === next.moldNo &&
      cur.docNo === next.docNo &&
      !cur.manual
    ) {
      res.unchanged++
      return
    } else res.updated++
    map[code] = next
  })
  if (res.added || res.updated) writeMoMap(map)
  return res
}

// ---------------------------------------------------------------------------
// 图号对齐：MES 物料图号 → 钉钉表「产品图号」选项
// ---------------------------------------------------------------------------

export type AlignVia = 'exact' | 'strip' | 'alias' | 'none'

/** 去掉括号部分：92056593(6545、6563) → 92056593（中英文括号均可） */
export function stripParen(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, '').trim()
}

export function alignDrawing(
  materialNo: string,
  drawingNo: string,
  options: string[],
  alias: Record<string, string> = readAlias(),
): { drawing: string; via: AlignVia; needPick: boolean } {
  const raw = drawingNo.trim()
  if (raw && options.includes(raw)) return { drawing: raw, via: 'exact', needPick: false }
  const base = stripParen(raw)
  if (base) {
    // 去括号后唯一命中才自动对齐；同一基础图号有多个括号变体时交给人工选
    const same = options.filter((o) => o === base)
    const cands = same.length ? same : options.filter((o) => stripParen(o) === base)
    if (cands.length === 1) return { drawing: cands[0], via: 'strip', needPick: false }
  }
  const a = (materialNo && alias[materialNo]) || (raw && alias[raw]) || ''
  if (a) return { drawing: a, via: 'alias', needPick: false }
  return { drawing: raw, via: 'none', needPick: true }
}
