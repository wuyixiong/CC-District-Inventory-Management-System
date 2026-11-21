/**
 * 演示数据生成器：以「记一笔」流水生成历史（入库/出库/转移）。
 * 场景设计：2 个红色超龄、2 个黄色超龄、几个正常流转、1 个今日新入、
 * 若干已出库批次、1 次跨库位转移，另留 3 个空库位。
 * 用法：npm run seed   （台账非空时拒绝执行，防止污染真实数据）
 */
import { appendTxnEvent, readLedger, readLocations, writeLocations, writeSettings, DEFAULT_SETTINGS } from './store'

function workingDaysBack(n: number): string[] {
  const days: string[] = []
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  while (days.length < n) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() - 1)
  }
  return days.reverse()
}

type Job =
  | { kind: 'in'; loc: string; product: string; batch: string; qty: number; day: number; time: string }
  | { kind: 'out'; loc: string; product: string; batch: string; qty: number; day: number; time: string }
  | { kind: 'move'; loc: string; target: string; product: string; batch: string; qty: number; day: number; time: string }

function main() {
  if (readLedger().length > 0 && !process.env.FORCE) {
    console.log('台账已存在数据，拒绝生成演示数据。确需覆盖生成请用: FORCE=1 npm run seed')
    process.exit(1)
  }

  if (!readLocations().length) {
    const locs: { code: string; zone: string; note: string; enabled: boolean }[] = []
    for (let i = 1; i <= 14; i++) locs.push({ code: `A${String(i).padStart(2, '0')}`, zone: 'A区', note: '', enabled: true })
    for (let i = 1; i <= 14; i++) locs.push({ code: `B${String(i).padStart(2, '0')}`, zone: 'B区', note: '', enabled: true })
    for (let i = 1; i <= 14; i++) locs.push({ code: `C${String(i).padStart(2, '0')}`, zone: 'C区', note: '', enabled: true })
    writeLocations(locs)
    console.log('已写入示例库位 A01-A14 / B01-B14 / C01-C14（可在设置页修改或批量导入真实库位）')
  }
  writeSettings({ ...DEFAULT_SETTINGS })

  const N = 10
  const days = workingDaysBack(N) // days[0] 最早，days[N-1] 今天

  const jobs: Job[] = [
    // 老库存 → 停满全程，演示「红」（批次号 = 操作时间 MMDD-HHmm）
    { kind: 'in', loc: 'A01', product: '5802136617', batch: '', qty: 120, day: 0, time: '09:40' },
    { kind: 'in', loc: 'A03', product: 'HX-88-05', batch: '0911-1015', qty: 36, day: 0, time: '10:15' },
    // 中段入库 → 演示「黄」
    { kind: 'in', loc: 'A02', product: 'SC2609-021', batch: '', qty: 64, day: 6, time: '08:50' },
    { kind: 'in', loc: 'B01', product: 'ZJ-33-102', batch: '0921-1430', qty: 210, day: 6, time: '14:30' },
    // 正常流转（1-2 天）
    { kind: 'in', loc: 'A01', product: 'SC2609-027', batch: '', qty: 88, day: 8, time: '09:10' },
    { kind: 'in', loc: 'A04', product: 'SC2609-030', batch: '0922-1500', qty: 45, day: 7, time: '15:00' },
    { kind: 'in', loc: 'B02', product: 'HX-90-11', batch: '', qty: 152, day: 8, time: '11:20' },
    // 今日新入
    { kind: 'in', loc: 'B03', product: 'SC2609-033', batch: '', qty: 30, day: 9, time: '08:30' },
    // 已出库的历史批次
    { kind: 'in', loc: 'A02', product: 'SC2609-012', batch: '', qty: 70, day: 0, time: '14:00' },
    { kind: 'out', loc: 'A02', product: 'SC2609-012', batch: '', qty: 70, day: 4, time: '09:30' },
    { kind: 'in', loc: 'B01', product: 'HX-87-02', batch: '', qty: 140, day: 1, time: '09:00' },
    { kind: 'out', loc: 'B01', product: 'HX-87-02', batch: '', qty: 140, day: 6, time: '16:00' },
    { kind: 'in', loc: 'A03', product: 'SC2609-024', batch: '0918-1040', qty: 61, day: 5, time: '10:40' },
    { kind: 'out', loc: 'A03', product: 'SC2609-024', batch: '0918-1040', qty: 61, day: 8, time: '13:15' },
    // 跨库位转移：B04 入库 → 转到 A04 → 出库
    { kind: 'in', loc: 'B04', product: '84432996', batch: '', qty: 52, day: 2, time: '11:00' },
    { kind: 'move', loc: 'B04', target: 'A04', product: '84432996', batch: '', qty: 52, day: 3, time: '15:20' },
    { kind: 'out', loc: 'A04', product: '84432996', batch: '', qty: 52, day: 7, time: '10:00' },
  ]

  // 按时间顺序入账，审计阅读更自然
  jobs.sort((a, b) => (days[a.day] + a.time).localeCompare(days[b.day] + b.time))
  for (const j of jobs) {
    appendTxnEvent({
      kind: j.kind,
      location: j.loc,
      targetLocation: j.kind === 'move' ? j.target : undefined,
      product: j.product,
      batch: j.batch,
      qty: j.qty,
      recorder: '测试数据',
      txnAt: `${days[j.day]} ${j.time}`,
    })
  }
  console.log(`已生成 ${jobs.length} 笔演示流水，覆盖 ${days[0]} ~ ${days[N - 1]} 共 ${N} 个工作日`)
  console.log('清空演示数据请用: npm run reset')
}

main()
