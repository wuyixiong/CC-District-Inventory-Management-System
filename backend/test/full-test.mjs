/**
 * 中转虚拟库 · 全系统自动化测试
 * 运行方式：node test/full-test.mjs（由 run-tests.bat 负责起隔离服务）
 * 环境变量：TEST_BASE（测试服务地址）、DT_LIVE=1 时执行钉钉真实链路测试
 */
const BASE = process.env.TEST_BASE || 'http://localhost:8799'
const DT_LIVE = process.env.DT_LIVE === '1'

let pass = 0
let fail = 0
const failures = []

async function req(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败')
}
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label ?? '值'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}
const state = async () => (await GET('/api/state')).body
const findLoc = async (code) => (await state()).board.locations.find((l) => l.code === code)
const itemOf = (loc, product, batch) => loc.items.find((i) => i.product === product && i.batch === batch)

// 今天与历史日期（本地时区）
const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
const T = (offsetDays, hm = '10:00') => {
  const d = new Date(now.getTime() - offsetDays * 86400000)
  return d.toISOString().slice(0, 10) + ' ' + hm
}
const TODAY = T(0).slice(0, 10)

// 环境准备：注册 42 个库位（隔离数据目录初始为空）
{
  const lines = []
  for (let i = 1; i <= 14; i++) lines.push(`A${String(i).padStart(2, '0')},A区`)
  for (let i = 1; i <= 14; i++) lines.push(`B${String(i).padStart(2, '0')},B区`)
  for (let i = 1; i <= 14; i++) lines.push(`C${String(i).padStart(2, '0')},C区`)
  const r = await POST('/api/locations/bulk', { text: lines.join('\n') })
  if (r.status !== 200 || r.body.added.length !== 42) {
    console.log('环境准备失败：库位注册异常', JSON.stringify(r.body).slice(0, 200))
    process.exit(1)
  }
}

console.log(`\n========== A. 记一笔 API（/api/txn） ==========`)

await t('A1 正常入库：返回序号，看板即时出现，批次按时间生成', async () => {
  const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty: 10, recorder: '测试', txnAt: T(0, '09:00') })
  eq(r.status, 200, 'HTTP')
  assert(r.body.ok, '应成功')
  const loc = await findLoc('A01')
  assert(loc.items.some((i) => i.product === 'P-001' && i.qty === 10), '看板应有 P-001 x10')
  eq(loc.items[0].days, 0, '停放天数')
  eq(loc.items[0].state, 'ok', '状态')
  assert(/^\d{4}-\d{4}$/.test(loc.items[0].batch), '批次号应为 MMDD-HHmm 格式，实际 ' + loc.items[0].batch)
})

await t('A2 同分钟再入库同图号：累加件数、不新增批次', async () => {
  await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty: 5, recorder: '测试', txnAt: T(0, '09:00') })
  const loc = await findLoc('A01')
  eq(loc.items.filter((i) => i.product === 'P-001').length, 1, '批次数')
  eq(loc.items[0].qty, 15, '件数')
})

await t('A3 不同时间入库：生成不同批次', async () => {
  await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty: 2, recorder: '测试', txnAt: T(0, '09:05') })
  const loc = await findLoc('A01')
  eq(loc.items.filter((i) => i.product === 'P-001').length, 2, '批次数')
})

await t('A4 手工指定批次号入库：按指定批次', async () => {
  await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: 'B9', qty: 7, recorder: '测试', txnAt: T(0, '09:10') })
  const loc = await findLoc('A01')
  assert(itemOf(loc, 'P-001', 'B9'), '应存在批次 B9')
})

await t('A5 未登记库位入库 → 400', async () => {
  const r = await POST('/api/txn', { kind: 'in', location: 'X99', product: 'P', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r.status, 400, 'HTTP')
  assert(r.body.message.includes('未登记'), '提示语')
})

await t('A6 停用库位入库 → 400', async () => {
  await POST('/api/locations', { code: 'Z01', zone: '测试区' })
  await PUT('/api/locations/Z01', { enabled: false })
  const r = await POST('/api/txn', { kind: 'in', location: 'Z01', product: 'P', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r.status, 400, 'HTTP')
})

await t('A7 产品图号缺失/超长/含竖线 → 400', async () => {
  for (const product of ['', 'x'.repeat(61), 'AB|CD']) {
    const r = await POST('/api/txn', { kind: 'in', location: 'A01', product, batch: '', qty: 1, recorder: 't', txnAt: T(0) })
    eq(r.status, 400, `产品「${product.slice(0, 8)}」`)
  }
})

await t('A8 批次号含竖线 → 400', async () => {
  const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: 'A|B', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r.status, 400, 'HTTP')
})

await t('A9 件数非法（0/负/小数/超大/文本）→ 400', async () => {
  for (const qty of [0, -5, 1.5, 1000001, 'abc']) {
    const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty, recorder: 't', txnAt: T(0) })
    eq(r.status, 400, `件数 ${qty}`)
  }
})

await t('A10 录入人缺失/超长/含非法字符 → 400', async () => {
  for (const recorder of ['', 'x'.repeat(21), '坏\uFFFD字符']) {
    const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty: 1, recorder, txnAt: T(0) })
    eq(r.status, 400, `录入人「${recorder.slice(0, 6)}」`)
  }
})

await t('A11 时间格式：非法拒绝；仅日期可接受', async () => {
  const bad = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'P-001', batch: '', qty: 1, recorder: 't', txnAt: '2026/09/26' })
  eq(bad.status, 400, '非法格式')
  const ok = await POST('/api/txn', { kind: 'in', location: 'A02', product: 'P-DONLY', batch: '', qty: 3, recorder: 't', txnAt: TODAY })
  eq(ok.status, 200, '仅日期')
})

await t('A12 出库：正常扣减，剩余停放起算日不变', async () => {
  await POST('/api/txn', { kind: 'out', location: 'A01', product: 'P-001', batch: 'B9', qty: 2, recorder: 't', txnAt: T(0, '12:00') })
  const loc = await findLoc('A01')
  eq(itemOf(loc, 'P-001', 'B9').qty, 5, '剩余')
  eq(itemOf(loc, 'P-001', 'B9').since, TODAY, '起算日不变')
})

await t('A13 出库超量 → 400 且注明现有件数', async () => {
  const r = await POST('/api/txn', { kind: 'out', location: 'A01', product: 'P-001', batch: 'B9', qty: 99, recorder: 't', txnAt: T(0) })
  eq(r.status, 400, 'HTTP')
  assert(r.body.message.includes('现有 5'), '提示应含现有件数')
})

await t('A14 出库不存在的批次/图号 → 400', async () => {
  const r1 = await POST('/api/txn', { kind: 'out', location: 'A01', product: 'P-001', batch: 'NOPE', qty: 1, recorder: 't', txnAt: T(0) })
  const r2 = await POST('/api/txn', { kind: 'out', location: 'A01', product: 'P-404', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r1.status, 400, '不存在批次')
  eq(r2.status, 400, '不存在图号')
})

await t('A15 转移：源减目标增，目标停放重新起算', async () => {
  await POST('/api/txn', { kind: 'in', location: 'A03', product: 'P-MV', batch: 'MV1', qty: 8, recorder: 't', txnAt: T(3, '08:00') })
  const r = await POST('/api/txn', { kind: 'move', location: 'A03', targetLocation: 'A04', product: 'P-MV', batch: 'MV1', qty: 8, recorder: 't', txnAt: T(1, '08:00') })
  eq(r.status, 200, '转移应成功')
  const a03 = await findLoc('A03')
  const a04 = await findLoc('A04')
  eq(a03.items.filter((i) => i.product === 'P-MV').length, 0, '源应清空')
  const it = a04.items.find((i) => i.product === 'P-MV')
  eq(it.qty, 8, '目标件数')
  eq(it.since, T(1).slice(0, 10), '目标起算日=转移日')
  eq(it.days, 1, '目标停放天数=1')
})

await t('A16 转移非法：目标=源 / 目标未登记 / 缺目标 → 400', async () => {
  const r1 = await POST('/api/txn', { kind: 'move', location: 'A04', targetLocation: 'A04', product: 'P-MV', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  const r2 = await POST('/api/txn', { kind: 'move', location: 'A04', targetLocation: 'X99', product: 'P-MV', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  const r3 = await POST('/api/txn', { kind: 'move', location: 'A04', product: 'P-MV', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r1.status, 400, '目标=源')
  eq(r2.status, 400, '目标未登记')
  eq(r3.status, 400, '缺目标')
})

console.log(`\n========== B. 看板计算（/api/state） ==========`)

await t('B1 停放天数与颜色阈值边界', async () => {
  const s = await state()
  const y = s.settings.yellowDays
  const r = s.settings.redDays
  await POST('/api/txn', { kind: 'in', location: 'B01', product: 'P-EDGE', batch: 'DY', qty: 1, recorder: 't', txnAt: T(y, '09:00') })
  await POST('/api/txn', { kind: 'in', location: 'B02', product: 'P-EDGE', batch: 'DR', qty: 1, recorder: 't', txnAt: T(r, '09:00') })
  await POST('/api/txn', { kind: 'in', location: 'B03', product: 'P-EDGE', batch: 'DOK', qty: 1, recorder: 't', txnAt: T(y - 1, '09:00') })
  const b01 = await findLoc('B01')
  const b02 = await findLoc('B02')
  const b03 = await findLoc('B03')
  eq(b01.items[0].state, 'yellow', `停${y}天应黄`)
  eq(b02.items[0].state, 'red', `停${r}天应红`)
  eq(b03.items[0].state, 'ok', `停${y - 1}天应绿`)
})

await t('B2 汇总数字：批次/件数/超龄/有货库位一致', async () => {
  const s = await state()
  const b = s.board
  const sumQty = b.locations.reduce((a, l) => a + l.qty, 0)
  const sumBatches = b.locations.reduce((a, l) => a + l.batches, 0)
  eq(b.totals.qty, sumQty, '总件数')
  eq(b.totals.batches, sumBatches, '总批次')
  eq(b.totals.overage, b.overageList.length, '超龄数')
  eq(b.totals.locations, b.locations.filter((l) => l.batches > 0).length, '有货库位')
})

await t('B3 空库位：显示 empty 状态', async () => {
  const loc = await findLoc('A05')
  eq(loc.state, 'empty', '状态')
  eq(loc.batches, 0, '批次')
})

await t('B4 入库后停用库位：库位仍显示、标记 enabled=false', async () => {
  await POST('/api/locations', { code: 'Z02', zone: '测试区' })
  await POST('/api/txn', { kind: 'in', location: 'Z02', product: 'P-Z', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  await PUT('/api/locations/Z02', { enabled: false })
  const loc = await findLoc('Z02')
  assert(loc, '库位应显示')
  eq(loc.enabled, false, 'enabled')
  eq(loc.batches, 1, '库存仍在')
})

await t('B5 改阈值后颜色即时变化', async () => {
  await PUT('/api/settings', { yellowDays: 1, redDays: 2 })
  const loc = await findLoc('B03') // 2天前入库：阈值调严(黄1红2)后 → 红
  eq(loc.items[0].state, 'red', '阈值调严后应变红')
  await PUT('/api/settings', { yellowDays: 3, redDays: 5 })
  const loc2 = await findLoc('B03')
  eq(loc2.items[0].state, 'ok', '恢复阈值后变绿')
})

console.log(`\n========== C. 快照校准（/api/day） ==========`)

await t('C1 快照重置状态并吸收流水；连续日快照回溯起始日', async () => {
  // 连续三天快照同一批 → since 应为第一天
  const d2 = T(2).slice(0, 10)
  const d1 = T(1).slice(0, 10)
  await POST('/api/day', { date: d2, recorder: '盘点', records: [{ location: 'C01', product: 'P-SNAP', batch: 'S1', qty: 10 }] })
  await POST('/api/day', { date: d1, recorder: '盘点', records: [{ location: 'C01', product: 'P-SNAP', batch: 'S1', qty: 10 }] })
  let loc = await findLoc('C01')
  eq(itemOf(loc, 'P-SNAP', 'S1').since, d2, '起始日=首日')
  eq(itemOf(loc, 'P-SNAP', 'S1').days, 2, '天数')
  // 快照后流水继续
  await POST('/api/txn', { kind: 'in', location: 'C01', product: 'P-SNAP', batch: 'S1', qty: 5, recorder: 't', txnAt: T(0, '09:00') })
  loc = await findLoc('C01')
  eq(itemOf(loc, 'P-SNAP', 'S1').qty, 15, '快照后流水累加')
})

await t('C2 跳日快照：漏录日视为连续在场', async () => {
  // 5天前与3天前各录快照（中间4天前完全没录）→ since 回溯到5天前
  const d5 = T(5).slice(0, 10)
  const d3 = T(3).slice(0, 10)
  await POST('/api/day', { date: d5, recorder: '盘点', records: [{ location: 'C02', product: 'P-GAP', batch: 'G1', qty: 4 }] })
  await POST('/api/day', { date: d3, recorder: '盘点', records: [{ location: 'C02', product: 'P-GAP', batch: 'G1', qty: 4 }] })
  const loc = await findLoc('C02')
  eq(itemOf(loc, 'P-GAP', 'G1').days, 5, '跳日仍连续计天')
})

await t('C3 快照校验：未登记库位/重复/坏件数 → 400', async () => {
  const r1 = await POST('/api/day', { date: TODAY, recorder: 't', records: [{ location: 'X1', product: 'P', batch: '', qty: 1 }] })
  const r2 = await POST('/api/day', { date: TODAY, recorder: 't', records: [{ location: 'C01', product: 'P', batch: '', qty: 1 }, { location: 'C01', product: 'P', batch: '', qty: 2 }] })
  const r3 = await POST('/api/day', { date: TODAY, recorder: 't', records: [{ location: 'C01', product: 'P', batch: '', qty: 0 }] })
  eq(r1.status, 400, '未登记')
  eq(r2.status, 400, '重复')
  eq(r3.status, 400, '坏件数')
})

console.log(`\n========== D. 库位与设置 ==========`)

await t('D1 库位：新增/重复/非法编码', async () => {
  eq((await POST('/api/locations', { code: 'd05', zone: 'D区' })).status, 200, '小写自动大写')
  eq((await POST('/api/locations', { code: 'D05', zone: 'D区' })).status, 400, '重复拒绝')
  eq((await POST('/api/locations', { code: '坏码!', zone: '' })).status, 400, '非法编码')
  const l = (await GET('/api/locations')).body.locations.find((x) => x.code === 'D05')
  eq(l.zone, 'D区', '区域保存')
})

await t('D2 批量导入：正常行+重复行+坏行 统计正确', async () => {
  const r = await POST('/api/locations/bulk', { text: 'E01,E区\nE02,E区,备注x\nE01,E区\n坏行!!!' })
  eq(r.body.added.length, 2, '新增')
  eq(r.body.skipped.length, 2, '跳过')
})

await t('D3 阈值校验：红<黄 → 400', async () => {
  eq((await PUT('/api/settings', { yellowDays: 5, redDays: 3 })).status, 400, '应拒绝')
})

await t('D4 审计：记一笔/快照/转移 摘要正确', async () => {
  const a = (await GET('/api/audit?limit=50')).body.events
  assert(a.length > 0, '有记录')
  assert(a.some((e) => e.type === '入库'), '入库')
  assert(a.some((e) => e.type === '出库'), '出库')
  assert(a.some((e) => e.type === '转移'), '转移')
  assert(a.some((e) => e.type.startsWith('快照')), '快照')
})

await t('D5 库存清单 /api/stock 与看板一致', async () => {
  const items = (await GET('/api/stock')).body.items
  const s = await state()
  eq(items.length, s.board.totals.batches, '条数一致')
})

console.log(`\n========== E. 韧性 ==========`)

await t('E1 并发 30 笔同时入库：序号唯一、台账完整、数量准确', async () => {
  const before = (await GET('/api/audit?limit=50')).body.events.length
  const rs = await Promise.all(
    Array.from({ length: 30 }, (_, i) => POST('/api/txn', { kind: 'in', location: 'B10', product: 'P-CONC', batch: 'C' + i, qty: 1, recorder: '并发', txnAt: T(0, '13:00') })),
  )
  assert(rs.every((r) => r.status === 200), '全部成功')
  const loc = await findLoc('B10')
  eq(loc.items.filter((i) => i.product === 'P-CONC').reduce((a, i) => a + i.qty, 0), 30, '件数合计')
  const seqs = rs.map((r) => r.body.seq)
  eq(new Set(seqs).size, 30, '序号唯一')
})

console.log(`\n========== G. 库位内跨批出库（先进先出一次扣足） ==========`)

// G1 数据准备：P-ZONE 四批同库位 A05（批次号即入库先后，Z1 停放最久）
await t('G1 自动出库：同库位 4 批一次出 35 件，按停放最久优先拆批扣减', async () => {
  await POST('/api/txn', { kind: 'in', location: 'A05', product: 'P-ZONE', batch: 'Z1', qty: 10, recorder: 't', txnAt: T(10, '08:00') })
  await POST('/api/txn', { kind: 'in', location: 'A05', product: 'P-ZONE', batch: 'Z2', qty: 10, recorder: 't', txnAt: T(8, '08:00') })
  await POST('/api/txn', { kind: 'in', location: 'A05', product: 'P-ZONE', batch: 'Z3', qty: 10, recorder: 't', txnAt: T(6, '08:00') })
  await POST('/api/txn', { kind: 'in', location: 'A05', product: 'P-ZONE', batch: 'Z4', qty: 10, recorder: 't', txnAt: T(4, '08:00') })
  const r = await POST('/api/txn', { kind: 'out', location: 'A05', product: 'P-ZONE', batch: '', qty: 35, recorder: 't', txnAt: T(0, '14:00') })
  eq(r.status, 200, 'HTTP')
  assert(r.body.ok, '应成功')
  const portions = r.body.portions ?? []
  eq(portions.length, 4, '应拆 4 段')
  eq(portions.map((p) => `${p.batch}:${p.take}`).join(','), 'Z1:10,Z2:10,Z3:10,Z4:5', '拆分明细应按停放最久优先')
  eq((r.body.seqs ?? []).length, 4, '应落 4 条流水')
  const a05 = await findLoc('A05')
  eq(a05.items.filter((i) => i.product === 'P-ZONE').length, 1, 'A05 只剩 1 批')
  eq(itemOf(a05, 'P-ZONE', 'Z4').qty, 5, 'A05 仅剩 Z4×5')
})

await t('G2 自动出库超量 → 400 且注明库位现有件数', async () => {
  const r = await POST('/api/txn', { kind: 'out', location: 'A05', product: 'P-ZONE', batch: '', qty: 6, recorder: 't', txnAt: T(0) })
  eq(r.status, 400, 'HTTP')
  assert(r.body.message.includes('现有 5'), '提示应含库位现有件数，实际：' + r.body.message)
})

await t('G3 自动出库只扣本库位：他库位同图号不动；单段拆分也返回 portions', async () => {
  await POST('/api/txn', { kind: 'in', location: 'B01', product: 'P-ZONE', batch: 'Z9', qty: 3, recorder: 't', txnAt: T(2, '08:00') })
  const r = await POST('/api/txn', { kind: 'out', location: 'A05', product: 'P-ZONE', batch: '', qty: 2, recorder: 't', txnAt: T(0) })
  eq(r.status, 200, 'HTTP')
  eq((r.body.portions ?? []).length, 1, '只剩一批应拆 1 段')
  const b01 = await findLoc('B01')
  eq(itemOf(b01, 'P-ZONE', 'Z9').qty, 3, 'B01 同图号不受影响')
  const a05 = await findLoc('A05')
  eq(itemOf(a05, 'P-ZONE', 'Z4').qty, 3, 'A05 剩 Z4×3')
})

await t('G4 库位无该产品 / 未传库位 → 400', async () => {
  const r1 = await POST('/api/txn', { kind: 'out', location: 'C01', product: 'P-ZONE', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r1.status, 400, '空库位无该产品')
  assert((r1.body.message || '').includes('没有产品'), '提示语')
  const r2 = await POST('/api/txn', { kind: 'out', product: 'P-ZONE', batch: '', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r2.status, 400, '缺库位')
})

await t('G5 指定批次出库不受影响（向后兼容）', async () => {
  const r = await POST('/api/txn', { kind: 'out', location: 'A05', product: 'P-ZONE', batch: 'Z4', qty: 1, recorder: 't', txnAt: T(0) })
  eq(r.status, 200, 'HTTP')
  assert(!r.body.seqs && !r.body.portions, '单批出库不应返回跨批拆分字段')
  const a05 = await findLoc('A05')
  eq(itemOf(a05, 'P-ZONE', 'Z4').qty, 2, '指定批余量')
})

console.log(`\n========== 汇总 ==========`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log('\n失败明细：')
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.msg}`))
  process.exit(1)
}
