/**
 * 第二阶段：钉钉双向链路（含真实环境）+ 配置安全
 * 运行前提：主套件已跑完；DT_LIVE=1 时执行真实写入（测完自动清理测试行）
 */
import fs from 'node:fs'

const BASE = process.env.TEST_BASE || 'http://localhost:8799'
const DT_LIVE = process.env.DT_LIVE === '1'
const TEST_DATA = process.env.TEST_DATA || './test-data'

let pass = 0
let fail = 0
const failures = []
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
const assert = (c, m) => { if (!c) throw new Error(m ?? '断言失败') }
const eq = (a, b, l) => { if (a !== b) throw new Error(`${l ?? '值'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`) }
const req = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const POST = (u, b) => req('POST', u, b)
const PUT = (u, b) => req('PUT', u, b)
const GET = (u) => req('GET', u)

console.log(`\n========== F. 钉钉配置与链路 ==========`)

await t('F1 未配置：status 报缺失项清单', async () => {
  const r = (await GET('/api/dingtalk/status')).body
  eq(r.configured, false, 'configured')
  assert(r.missing.includes('appKey') && r.missing.includes('baseId'), '缺失项')
})

await t('F2 未配置：sync 给中文错误而非崩溃', async () => {
  const r = await POST('/api/dingtalk/sync')
  eq(r.status, 400, 'HTTP')
  assert(r.body.message.includes('不完整'), '提示语')
})

await t('F3 配置保存：AppSecret 掩码、baseId 支持贴整段 URL', async () => {
  const url = 'https://alidocs.dingtalk.com/i/nodes/abc?drInstanceId=FAKE_BASE_ID_123'
  const r = await PUT('/api/dingtalk/config', { appKey: 'k', appSecret: 's', operatorId: 'o', baseId: url, sheet: '表', autoSyncMinutes: 30 })
  eq(r.body.configured, true, 'configured')
  eq(r.body.config.baseId, 'FAKE_BASE_ID_123', 'URL 归一化')
  eq(r.body.config.appSecret, '***', '掩码')
  eq(r.body.config.autoSyncMinutes, 30, '间隔')
})

if (DT_LIVE) {
  // 把真实配置写入测试环境（autoSync 拉长避免测试期间自动触发）
  const live = JSON.parse(fs.readFileSync('data/dingtalk.json', 'utf8'))
  fs.writeFileSync(`${TEST_DATA}/dingtalk.json`, JSON.stringify({ ...live, autoSyncMinutes: 30 }, null, 2))

  // 钉钉直连小工具（用白区 .env 凭证）
  const env = Object.fromEntries(
    fs.readFileSync('C:/Users/a/Desktop/WYX/白区看板/白区看板/白区看板/server/.env', 'utf8')
      .split(/\r?\n/)
      .map((l) => l.split('='))
      .filter((p) => p.length >= 2 && p[0].trim())
      .map((p) => [p[0].trim(), p.slice(1).join('=').trim()]),
  )
  const dt = async (method, apiPath, body) => {
    const { accessToken } = await (
      await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: env.DINGTALK_APP_KEY, appSecret: env.DINGTALK_APP_SECRET }),
      })
    ).json()
    const r = await fetch(`https://api.dingtalk.com${apiPath}?operatorId=${encodeURIComponent(env.DINGTALK_OPERATOR_ID)}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { ok: r.ok, body: await r.json().catch(() => ({})) }
  }
  const enc = encodeURIComponent
  const sheetPath = (suffix) => `/v1.0/notable/bases/${enc(live.baseId)}/sheets/${enc(live.sheet)}${suffix}`
  const choiceId = (field, value) => {
    for (const c of field?.property?.choices ?? []) {
      const name = typeof c === 'string' ? c : String(c.name ?? '')
      const id = typeof c === 'string' ? '' : String(c.id ?? '')
      if (name === value || name.split('\t')[0].trim() === value) return id || name
    }
    return ''
  }
  const createdRowIds = []

  await t('F4 真实同步：拉取表格行入账，重复同步幂等', async () => {
    const s1 = await POST('/api/dingtalk/sync')
    eq(s1.status, 200, 'HTTP')
    assert(s1.body.report.added > 0, `首次应拉入 ${s1.body.report.added} 笔`)
    const s2 = await POST('/api/dingtalk/sync')
    eq(s2.body.report.added, 0, '重复同步')
  })

  await t('F5 同步 FIFO：一笔出库跨批扣减拆多笔、库存正确', async () => {
    const st = (await GET('/api/state')).body
    const a06 = st.board.locations.find((l) => l.code === 'A06')
    const batches = a06.items.filter((i) => i.product === '10JSD160TB-1701015C')
    if (batches.length < 2) throw new Error('前置条件不足：A06 该图号不足 2 个批次')
    const total = batches.reduce((a, i) => a + i.qty, 0)
    const oldest = [...batches].sort((a, b) => a.since.localeCompare(b.since))[0]

    // 直接在钉钉表造一笔出库行（数量=最老批次+1，必然扣穿到第二批）
    const fieldsRes = await dt('GET', sheetPath('/fields'))
    const F = {}
    for (const f of fieldsRes.body.value ?? []) F[f.name] = f
    const rowRes = await dt('POST', sheetPath('/records'), {
      records: [
        {
          fields: {
            操作类型: choiceId(F['操作类型'], '出库'),
            库位编号: choiceId(F['库位编号'], 'A06'),
            产品图号: choiceId(F['产品图号'], '10JSD160TB-1701015C'),
            件数: oldest.qty + 1,
            批次号: Date.now(),
            备注: '[autotest] FIFO跨批',
          },
        },
      ],
    })
    const rowId = rowRes.body.records?.[0]?.id ?? rowRes.body.value?.[0]?.id
    assert(rowId, `钉钉造行成功（响应：${JSON.stringify(rowRes.body).slice(0, 120)}）`)
    createdRowIds.push(rowId)

    // 钉钉读写有秒级延迟：轮询同步直到该行被消费（以台账出现该行ID前缀的事件为准）
    let consumed = false
    for (let i = 0; i < 6 && !consumed; i++) {
      await new Promise((r) => setTimeout(r, 2500))
      await POST('/api/dingtalk/sync')
      const audit = (await GET('/api/audit?limit=50')).body.events
      consumed = audit.some((e) => e.seq && true) // 占位，下面用状态判定
      const stX = (await GET('/api/state')).body
      const a06X = stX.board.locations.find((l) => l.code === 'A06')
      const nowTotal = a06X.items.filter((i) => i.product === '10JSD160TB-1701015C').reduce((a, i) => a + i.qty, 0)
      consumed = nowTotal === total - (oldest.qty + 1)
    }
    assert(consumed, '轮询超时：该出库行未被同步消费')

    // 断言最终账务结果（不依赖具体哪次同步完成的）
    const s2 = await POST('/api/dingtalk/sync')
    eq(s2.body.report.added, 0, '消费完毕后同步应幂等')
    const st2 = (await GET('/api/state')).body
    const a06b = st2.board.locations.find((l) => l.code === 'A06')
    const batches2 = a06b.items.filter((i) => i.product === '10JSD160TB-1701015C')
    const total2 = batches2.reduce((a, i) => a + i.qty, 0)
    eq(total2, total - (oldest.qty + 1), '扣减后总量')
    const oldest2 = [...batches2].sort((a, b) => a.batch.localeCompare(b.batch))[0]
    assert(oldest2 && oldest2.qty < oldest.qty, '最老批次应被扣减（先进先出）')
    // 还原：在测试台账里不必还原（隔离环境），但钉钉行要删
  })

  await t('F6 网页记一笔回写钉钉：真实生成行、映射防回声', async () => {
    const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: '10JSD160TB-1701015C', batch: '', qty: 1, recorder: 'autotest', txnAt: '2026-09-26 15:00' })
    eq(r.status, 200, 'HTTP')
    eq(r.body.dtWarning, undefined, '不应有警告（真实回写成功）')
    const map = JSON.parse(fs.readFileSync(`${TEST_DATA}/dingtalk-map.json`, 'utf8'))
    const ids = map[String(r.body.seq)]
    assert(ids?.length === 1, '映射表应有该笔')
    createdRowIds.push(...ids)
    await new Promise((r2) => setTimeout(r2, 2000))
    const s = await POST('/api/dingtalk/sync')
    eq(s.body.report.added, 0, '回写行不得被同步重复入账')
  })

  await t('F7 回写未知图号：本地入账 + 明确警告', async () => {
    const r = await POST('/api/txn', { kind: 'in', location: 'A01', product: 'AUTOTEST-无此图号', batch: '', qty: 1, recorder: 'autotest', txnAt: '2026-09-26 15:05' })
    eq(r.status, 200, '本地应入账')
    assert(r.body.dtWarning?.includes('不在钉钉表选项'), '警告语')
  })

  // 清理：删除本阶段在真实表格里造的测试行
  await t('F8 清理测试行（真实表格恢复原状）', async () => {
    if (createdRowIds.length) {
      await dt('POST', sheetPath('/records/delete'), { recordIds: createdRowIds })
    }
    const after = await POST('/api/dingtalk/sync')
    eq(after.status, 200, '清理后同步仍正常')
  })
} else {
  console.log('  SKIP  F4-F8（DT_LIVE 未开启，跳过钉钉真实链路）')
}

console.log(`\n========== 阶段汇总 ==========`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.msg}`))
  process.exit(1)
}
