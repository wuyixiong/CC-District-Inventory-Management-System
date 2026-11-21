/**
 * 第一期 PDA 扫码录入 · 自动化测试（MES 清单导入 / 扫码解析 / 图号对齐 / 一件一码 / 幂等 / 按码出库 / 转移 / 镜像后索引）
 *
 * 运行：先起隔离测试服务（PORT=8799, DATA_DIR=临时目录），再
 *   TEST_BASE=http://localhost:8799 DATA_DIR=同一临时目录 node test/pda-test.mjs
 * DATA_DIR 用于模拟「钉钉图号选项缓存」与「镜像校准事件」（真实环境由钉钉同步写入）；不传则相关用例跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'

const BASE = process.env.TEST_BASE || 'http://localhost:8799'
const DATA_DIR = process.env.DATA_DIR || ''

let pass = 0
let fail = 0
let skip = 0
const failures = []

async function req(method, url, body, headers) {
  const isBuf = body instanceof Uint8Array
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  })
  let j = null
  try {
    j = await r.json()
  } catch {
    j = null
  }
  return { status: r.status, body: j }
}
const POST = (u, b) => req('POST', u, b)
const PUT = (u, b) => req('PUT', u, b)
const GET = (u) => req('GET', u)

async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, msg: e.message })
    console.log(`  FAIL  ${name}  →  ${e.message}`)
  }
}
function needData(name) {
  if (DATA_DIR) return false
  skip++
  console.log(`  SKIP  ${name}（未传 DATA_DIR）`)
  return true
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败')
}
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label ?? '值'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}
const ok200 = (r, label) => {
  if (r.status !== 200) throw new Error(`${label ?? 'HTTP'}：期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`)
}
const err400 = (r, label, re) => {
  if (r.status !== 400) throw new Error(`${label ?? 'HTTP'}：期望 400，实际 ${r.status} ${JSON.stringify(r.body)}`)
  if (re && !re.test(r.body?.message ?? '')) throw new Error(`${label}：提示「${r.body?.message}」不含 ${re}`)
}
const state = async () => (await GET('/api/state')).body
const qtyAt = async (loc, product) => {
  const l = (await state()).board.locations.find((x) => x.code === loc)
  return (l?.items ?? []).filter((i) => i.product === product).reduce((s, i) => s + i.qty, 0)
}
const batchesAt = async (loc, product) => {
  const l = (await state()).board.locations.find((x) => x.code === loc)
  return (l?.items ?? []).filter((i) => i.product === product)
}
const moAt = async (loc, product) =>
  (await GET(`/api/mo/stock?location=${encodeURIComponent(loc)}${product ? '&product=' + encodeURIComponent(product) : ''}`)).body.items.map((m) => m.code)
const setOptions = (list) => fs.writeFileSync(path.join(DATA_DIR, 'dt-products.json'), JSON.stringify(list), 'utf8')

const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
const T = (offsetDays, hm = '10:00') => new Date(now.getTime() - offsetDays * 86400000).toISOString().slice(0, 10) + ' ' + hm
const mo = (n) => `MO2611210000${String(n).padStart(2, '0')}`
const DRAW_L = '92056593(6545、6563)' // 左壳体（带括号变体）
const DRAW_M = '4570H5' // 中间箱体

const HEADER = '模号唯一码	年度	月份	月份代码	物料编号	物料名称	物料图号	模号	单据编号	制单人名称	制单日期	备注	日期	老物料号	老物料图号	修改人编号	修改人名称	最后修改日期'
const row = (n, matNo, name, draw, mold, doc) =>
  [mo(n), '2026', '11', 'B', matNo, name, draw, mold, doc, '张三', '2026-11-21', '', '2026-11-21', '', '', '001', '张三', '2026-11-21 08:00'].join('\t')
const SAMPLE = [
  HEADER,
  row(1, 'A000717', '左壳体', DRAW_L, 'R137', 'BC2611210000'),
  row(2, 'A000717', '左壳体', DRAW_L, 'R138', 'BC2611210000'),
  row(3, 'A000717', '左壳体', DRAW_L, 'R139', 'BC2611210000'),
  row(4, 'A000717', '左壳体', DRAW_L, 'R140', 'BC2611210000'),
  row(5, 'A000264', '中间箱体', DRAW_M, 'R131', 'BC2611210001'),
  row(6, 'A000264', '中间箱体', DRAW_M, 'R132', 'BC2611210001'),
  row(7, 'A000264', '中间箱体', DRAW_M, 'R133', 'BC2611210001'),
  row(8, 'A000264', '中间箱体', DRAW_M, 'R134', 'BC2611210001'),
].join('\n')

// 环境：登记 P01-P04
{
  const r = await POST('/api/locations/bulk', { text: ['P01,P区', 'P02,P区', 'P03,P区', 'P04,P区'].join('\n') })
  if (r.status !== 200 || r.body.added.length !== 4) {
    console.log('环境准备失败：库位注册异常', JSON.stringify(r.body).slice(0, 200))
    process.exit(1)
  }
}
const txn = (b) => POST('/api/txn', { recorder: 'PDA测试', txnAt: T(0, '08:00'), ...b })

console.log('\n========== H. MES 清单导入 ==========')

await t('H1 导入 TSV 样例 8 条：全部新增，含 1 条格式错误行被跳过', async () => {
  const r = await POST('/api/momap/import', { text: SAMPLE + '\n' + ['XYZ001', '2026'].join('\t') })
  ok200(r)
  eq(r.body.added, 8, '新增')
  eq(r.body.skipped, 1, '跳过')
  eq(r.body.mapSize, 8, '对照表条数')
})

await t('H2 重复导入同清单：0 新增 8 不变；改一行模号：1 更新', async () => {
  const r1 = await POST('/api/momap/import', { text: SAMPLE })
  eq(r1.body.added, 0, '新增')
  eq(r1.body.unchanged, 8, '不变')
  const r2 = await POST('/api/momap/import', { text: SAMPLE.replace('R134', 'R134-改') })
  eq(r2.body.updated, 1, '更新')
  const q = await GET(`/api/momap?q=${mo(8)}`)
  eq(q.body.items[0].moldNo, 'R134-改', '模号已覆盖')
})

await t('H3 列顺序不同 + CSV 也能按表头识别；缺「物料图号」列 → 400', async () => {
  const csv = '物料图号,模号唯一码,物料名称\n4570H5,MO261121000099,中间箱体'
  const r = await POST('/api/momap/import', { text: csv })
  ok200(r)
  eq(r.body.added, 1, 'CSV 新增')
  err400(await POST('/api/momap/import', { text: '模号唯一码\tX\nMO261121000098\t1' }), '缺图号列', /物料图号/)
  err400(await POST('/api/momap/import', { text: '随便什么' }), '无表头', /模号唯一码/)
})

await t('H4 上传 xlsx（exceljs 生成）导入', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('MES')
  ws.addRow(['MES 导出（标题行）'])
  ws.addRow(HEADER.split('\t'))
  ws.addRow(row(9, 'A000264', '中间箱体', DRAW_M, 'R135', 'BC2611210001').split('\t'))
  const buf = new Uint8Array(await wb.xlsx.writeBuffer())
  const r = await POST('/api/momap/import', buf)
  ok200(r, 'xlsx 导入')
  eq(r.body.added, 1, 'xlsx 新增')
})

await t('H5 查询：按物料编号 / 单据编号命中；PUT 手工修正与补录', async () => {
  eq((await GET('/api/momap?q=A000717')).body.matched, 4, 'A000717 条数')
  eq((await GET('/api/momap?q=bc2611210001')).body.matched, 5, '单据编号（不区分大小写）')
  const r = await PUT(`/api/momap/${mo(99)}`, { materialName: '中间箱体-修正' })
  ok200(r)
  eq(r.body.created, false, '修正非新建')
  const r2 = await PUT('/api/momap/MO261121999999', { drawingNo: 'P-MAN', materialName: '手工补录' })
  eq(r2.body.created, true, '补录新建')
  err400(await PUT('/api/momap/MO261121999998', { materialName: '无图号' }), '新建缺图号', /物料图号/)
  err400(await PUT('/api/momap/BAD', { drawingNo: 'x' }), '码格式', /格式/)
})

console.log('\n========== I. 扫码解析 /api/scan/resolve ==========')

await t('I1 库位码（大小写不敏感）→ location', async () => {
  const r = await GET('/api/scan/resolve?code=p01')
  eq(r.body.type, 'location')
  eq(r.body.code, 'P01')
})

await t('I2 已导入 MO 码 → mo（物料名称/模号/原图号）；无钉钉选项时 needPick', async () => {
  const r = await GET(`/api/scan/resolve?code=${mo(5)}`)
  eq(r.body.type, 'mo')
  eq(r.body.mo.materialName, '中间箱体')
  eq(r.body.mo.moldNo, 'R131')
  eq(r.body.mo.rawDrawingNo, DRAW_M)
  if (DATA_DIR) return
  eq(r.body.needPick, true, '无选项 needPick')
})

await t('I3 未导入的 MO 码 → mo + imported:false + needPick；其他内容 → product；非法 → unknown', async () => {
  const r = await GET('/api/scan/resolve?code=MO261121888888')
  eq(r.body.type, 'mo')
  eq(r.body.mo.imported, false)
  eq(r.body.needPick, true)
  const p = await GET('/api/scan/resolve?code=18686-ABC')
  eq(p.body.type, 'product')
  eq(p.body.product, '18686-ABC')
  eq((await GET('/api/scan/resolve?code=' + encodeURIComponent('a|b'))).body.type, 'unknown')
  err400(await GET('/api/scan/resolve?code='), '空码')
})

await t('I4 图号对齐：全文 → 去括号 → 括号变体多选一需人工 → alias', async () => {
  if (needData('I4')) return
  setOptions([DRAW_L, DRAW_M, '18686'])
  let r = await GET(`/api/scan/resolve?code=${mo(1)}`)
  eq(r.body.mo.drawingNo, DRAW_L, '全文匹配')
  eq(r.body.mo.aligned, 'exact')
  eq(r.body.needPick, false)
  setOptions(['92056593', DRAW_M])
  r = await GET(`/api/scan/resolve?code=${mo(1)}`)
  eq(r.body.mo.drawingNo, '92056593', '去括号后匹配')
  eq(r.body.mo.aligned, 'strip')
  setOptions(['92056593(6545)', '92056593(6563)', DRAW_M])
  r = await GET(`/api/scan/resolve?code=${mo(1)}`)
  eq(r.body.needPick, true, '多个括号变体 → 人工选')
  eq(r.body.mo.drawingNo, DRAW_L, '未对齐时用原文')
  ok200(await POST('/api/momap/alias', { materialNo: 'A000717', drawingNo: DRAW_L, target: '92056593(6563)' }), '记住 alias')
  r = await GET(`/api/scan/resolve?code=${mo(2)}`)
  eq(r.body.mo.drawingNo, '92056593(6563)', 'alias 对齐')
  eq(r.body.mo.aligned, 'alias')
  eq(r.body.needPick, false)
  setOptions([DRAW_L, DRAW_M]) // 复原：后续入库用完整写法
})

await t('I5 MO 规则可配置：改规则后原 MO 码按产品码处理；非法正则 → 400', async () => {
  err400(await PUT('/api/settings', { moPattern: '([' }), '非法正则', /正则/)
  ok200(await PUT('/api/settings', { moPattern: '^XX\\d+$' }))
  eq((await GET(`/api/scan/resolve?code=${mo(1)}`)).body.type, 'product', '规则改后')
  ok200(await PUT('/api/settings', { moPattern: '^MO\\d{12}$' }))
  eq((await GET(`/api/scan/resolve?code=${mo(1)}`)).body.type, 'mo', '规则复原')
  eq((await state()).settings.moPattern, '^MO\\d{12}$', 'state 带出规则')
})

console.log('\n========== J. 一件一码入库 / 幂等 ==========')

await t('J1 带 moCodes 入库 4 件：件数=码数，看板与 MO 索引一致', async () => {
  const r = await txn({ kind: 'in', location: 'P01', product: DRAW_L, qty: 4, moCodes: [1, 2, 3, 4].map(mo), requestId: 'req-j1' })
  ok200(r)
  eq(await qtyAt('P01', DRAW_L), 4, '看板件数')
  eq((await moAt('P01', DRAW_L)).length, 4, '索引码数')
  const resolved = await GET(`/api/scan/resolve?code=${mo(1)}`)
  eq(resolved.body.stock?.location, 'P01', 'resolve 带出在库位置')
})

await t('J2 校验：件数≠码数 / 同笔重复码 / 格式不符 → 400', async () => {
  err400(await txn({ kind: 'in', location: 'P02', product: DRAW_M, qty: 3, moCodes: [mo(5), mo(6)] }), '件数≠码数', /等于 MO 码数/)
  err400(await txn({ kind: 'in', location: 'P02', product: DRAW_M, qty: 2, moCodes: [mo(5), mo(5).toLowerCase()] }), '重复码', /重复/)
  err400(await txn({ kind: 'in', location: 'P02', product: DRAW_M, qty: 1, moCodes: ['MO123'] }), '格式', /格式不符/)
})

await t('J3 一件一码防重：已在库的码再入库（换库位也不行）→ 400', async () => {
  err400(await txn({ kind: 'in', location: 'P02', product: DRAW_L, qty: 1, moCodes: [mo(1)] }), '重复入库', /已在库/)
  eq(await qtyAt('P02', DRAW_L), 0, '未入账')
})

await t('J4 requestId 幂等：重复提交返回首次结果，不重复入账', async () => {
  const r = await txn({ kind: 'in', location: 'P01', product: DRAW_L, qty: 4, moCodes: [1, 2, 3, 4].map(mo), requestId: 'req-j1' })
  ok200(r)
  eq(r.body.duplicate, true, 'duplicate 标记')
  eq(await qtyAt('P01', DRAW_L), 4, '件数不变')
})

await t('J5 requestId 并发：同一请求同时提交 3 次只落账一次、序号相同', async () => {
  const body = { kind: 'in', location: 'P01', product: DRAW_M, qty: 2, moCodes: [mo(5), mo(6)], requestId: 'req-j5' }
  const rs = await Promise.all([txn(body), txn(body), txn(body)])
  rs.forEach((r) => ok200(r))
  eq(new Set(rs.map((r) => r.body.seq)).size, 1, '序号一致')
  eq(rs.filter((r) => r.body.duplicate).length, 2, '其中 2 次为 duplicate')
  eq(await qtyAt('P01', DRAW_M), 2, '件数')
})

console.log('\n========== K. 按码出库 / 转移 ==========')

await t('K1 按码出库：精确扣码所在批次，不走先进先出', async () => {
  ok200(await txn({ kind: 'in', location: 'P01', product: DRAW_M, qty: 1, moCodes: [mo(7)], txnAt: T(2, '09:00') }))
  ok200(await txn({ kind: 'in', location: 'P01', product: DRAW_M, qty: 1, moCodes: [mo(8)], txnAt: T(1, '09:00') }))
  eq((await batchesAt('P01', DRAW_M)).length, 3, '3 个批次')
  const r = await txn({ kind: 'out', location: 'P01', product: DRAW_M, qty: 2, moCodes: [mo(8), mo(5)], requestId: 'req-k1' })
  ok200(r)
  eq(r.body.seqs.length, 2, '按批拆 2 笔')
  const left = await batchesAt('P01', DRAW_M)
  eq(left.length, 2, '剩 2 批')
  const oldest = left.find((b) => b.since === T(2).slice(0, 10))
  assert(oldest && oldest.qty === 1, '最早一批（MO07）未被先进先出扣掉')
  eq((await moAt('P01', DRAW_M)).sort().join(','), [mo(6), mo(7)].join(','), '索引剩 06/07')
})

await t('K2 出库校验：码不在本库位 / 已出库 / 图号不符 → 400', async () => {
  err400(await txn({ kind: 'out', location: 'P02', product: DRAW_L, qty: 1, moCodes: [mo(1)] }), '不在本库位', /不在库位 P02.*在 P01/)
  err400(await txn({ kind: 'out', location: 'P01', product: DRAW_M, qty: 1, moCodes: [mo(8)] }), '已出库', /不在库/)
  err400(await txn({ kind: 'out', location: 'P01', product: DRAW_M, qty: 1, moCodes: [mo(1)] }), '图号不符', /图号/)
})

await t('K3 按码转移：码随件到目标库位；原库位再出该码被拒', async () => {
  const r = await txn({ kind: 'move', location: 'P01', targetLocation: 'P03', product: DRAW_L, qty: 2, moCodes: [mo(1), mo(2)] })
  ok200(r)
  eq(await qtyAt('P01', DRAW_L), 2, '原库位剩 2')
  eq(await qtyAt('P03', DRAW_L), 2, '目标库位 2')
  eq((await moAt('P03')).sort().join(','), [mo(1), mo(2)].join(','), '索引在 P03')
  err400(await txn({ kind: 'out', location: 'P01', product: DRAW_L, qty: 1, moCodes: [mo(1)] }), '原库位出', /在 P03/)
  err400(await txn({ kind: 'move', location: 'P03', targetLocation: 'P03', product: DRAW_L, qty: 1, moCodes: [mo(1)] }), '同库位', /相同/)
})

await t('K4 已出库的码可再次入库（返修回流）', async () => {
  ok200(await txn({ kind: 'in', location: 'P02', product: DRAW_M, qty: 1, moCodes: [mo(8)] }))
  eq((await moAt('P02')).join(','), mo(8))
})

await t('K5 无码出库（先进先出）后索引同步移出最早入库的码', async () => {
  ok200(await txn({ kind: 'out', location: 'P01', product: DRAW_M, qty: 1 }))
  eq((await moAt('P01', DRAW_M)).join(','), mo(6), '最早的 MO07 随先进先出出库')
})

await t('K6 锁定录入人时提交被拒并给出 RECORDER_LOCKED', async () => {
  ok200(await PUT('/api/dingtalk/config', { lockRecorder: true }))
  const r = await txn({ kind: 'in', location: 'P02', product: DRAW_M, qty: 1, moCodes: ['MO261121777777'] })
  ok200(await PUT('/api/dingtalk/config', { lockRecorder: false }))
  err400(r, '锁定', /钉钉/)
  eq(r.body.code, 'RECORDER_LOCKED')
})

console.log('\n========== L. 镜像校准后的 MO 索引 ==========')

await t('L1 镜像件数少于码数：按最早入库的码保留并记日志；被移除的码可重新入库', async () => {
  if (needData('L1')) return
  const P = 'P-MIR'
  const c1 = 'MO261121100001'
  const c2 = 'MO261121100002'
  const c3 = 'MO261121100003'
  ok200(await txn({ kind: 'in', location: 'P04', product: P, qty: 1, moCodes: [c2], txnAt: T(1, '10:00') }))
  ok200(await txn({ kind: 'in', location: 'P04', product: P, qty: 1, moCodes: [c1], txnAt: T(3, '10:00') }))
  ok200(await txn({ kind: 'in', location: 'P04', product: P, qty: 1, moCodes: [c3], txnAt: T(2, '10:00') }))
  // 模拟钉钉同步追加的镜像事件：P04 只剩 1 件（落在 c2 的批次上），其他库位原样
  const stock = (await GET('/api/stock')).body.items
  const c2Batch = stock.find((i) => i.location === 'P04' && i.since === T(1).slice(0, 10)).batch
  const records = stock
    .filter((i) => i.location !== 'P04')
    .map((i) => ({ location: i.location, product: i.product, batch: i.batch, qty: i.qty, since: i.since }))
  records.push({ location: 'P04', product: P, batch: c2Batch, qty: 1, since: T(1).slice(0, 10) })
  const ledger = path.join(DATA_DIR, 'snapshots.jsonl')
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n')
  const seq = JSON.parse(lines[lines.length - 1]).seq + 1
  fs.appendFileSync(ledger, JSON.stringify({ seq, type: 'mirror', at: new Date().toISOString(), records }) + '\n')

  const after = await GET('/api/mo/stock?location=P04')
  eq(after.body.items.map((m) => m.code).join(','), c1, '保留最早入库的 c1')
  assert(after.body.log.some((l) => l.includes('镜像校准') && l.includes('P04')), '有镜像校准日志')
  eq((await moAt('P01', DRAW_L)).length, 2, '其他库位的码不受影响')
  // c1 的原批次已被镜像改写：按码出库落到本库位现有批次
  const out = await txn({ kind: 'out', location: 'P04', product: P, qty: 1, moCodes: [c1] })
  ok200(out, '镜像后按码出库')
  eq(await qtyAt('P04', P), 0, 'P04 清空')
  ok200(await txn({ kind: 'in', location: 'P04', product: P, qty: 1, moCodes: [c2] }), '被移除的码可重新入库')
})

await t('L2 全区快照校准同口径：库位清空 → 索引同步清空', async () => {
  const stock = (await GET('/api/stock')).body.items.filter((i) => i.location !== 'P03')
  const r = await POST('/api/day', {
    date: T(0).slice(0, 10),
    recorder: '盘点',
    records: stock.map((i) => ({ location: i.location, product: i.product, batch: i.batch, qty: i.qty })),
  })
  ok200(r)
  eq((await moAt('P03')).length, 0, 'P03 码清空')
  ok200(await txn({ kind: 'in', location: 'P03', product: DRAW_L, qty: 1, moCodes: [mo(1)] }), 'MO01 可重新入库')
})

console.log('\n========== 汇总 ==========')
console.log(`通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''}`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`)
  process.exit(1)
}
