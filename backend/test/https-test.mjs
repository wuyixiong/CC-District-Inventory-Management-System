/**
 * HTTPS 启动自动化测试（手机摄像头扫码需要 https）
 * 自行起隔离服务（临时 DATA_DIR），无需预先启动：
 *   cd backend && node test/https-test.mjs
 * 覆盖：HTTPS_PORT 启动 → 自动生成自签证书 → https 请求 /api/state → 重启复用同一证书 → HTTP 端口不受影响 → 不设 HTTPS_PORT 不监听 https
 * 端口可用 TEST_HTTP_PORT / TEST_HTTPS_PORT 覆盖（默认 8797 / 8798）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HTTP_PORT = Number(process.env.TEST_HTTP_PORT || 8797)
const HTTPS_PORT = Number(process.env.TEST_HTTPS_PORT || 8798)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'board-https-test-'))
const CERT_DIR = path.join(DATA_DIR, 'cert')

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败')
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { rejectUnauthorized: false }, (res) => {
      const cert = res.socket.getPeerCertificate?.()
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), cert }),
      )
    })
    r.on('error', reject)
    r.setTimeout(5000, () => r.destroy(new Error('超时')))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(300)
    }
  }
  throw new Error(`等待超时：${last?.message ?? ''}`)
}

function startServer(extraEnv) {
  const env = { ...process.env, PORT: String(HTTP_PORT), DATA_DIR, ...extraEnv }
  if (!('HTTPS_PORT' in extraEnv)) delete env.HTTPS_PORT
  // 单进程运行（node --import tsx），便于测试结束时可靠关停；需 Node ≥18.19
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: BACKEND, env })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  return { child, log: () => log }
}
async function stopServer(s) {
  if (s.child.exitCode !== null) return
  const done = new Promise((r) => s.child.once('exit', r))
  s.child.kill()
  await Promise.race([done, sleep(5000)])
}
const fingerprint = (pem) => crypto.createHash('sha256').update(pem).digest('hex')

console.log(`HTTPS 测试（DATA_DIR=${DATA_DIR}）`)
let fp1 = ''
let srv = startServer({ HTTPS_PORT: String(HTTPS_PORT) })
try {
  await t('H1 HTTPS_PORT 启动：https 可访问 /api/state', async () => {
    const r = await waitFor(() => httpsGet(`https://localhost:${HTTPS_PORT}/api/state`))
    assert(r.status === 200, `状态码 ${r.status}`)
    const j = JSON.parse(r.body)
    assert(j && typeof j === 'object', '返回不是 JSON 对象')
  })
  await t('H2 自动生成证书保存到 DATA_DIR/cert', async () => {
    const k = path.join(CERT_DIR, 'key.pem')
    const c = path.join(CERT_DIR, 'cert.pem')
    assert(fs.existsSync(k) && fs.existsSync(c), '未生成 key.pem/cert.pem')
    const pem = fs.readFileSync(c, 'utf8')
    assert(pem.includes('BEGIN CERTIFICATE'), 'cert.pem 格式不对')
    fp1 = fingerprint(pem)
    assert(/自动生成自签 HTTPS 证书/.test(srv.log()), '启动日志未提示生成证书')
    assert(/https:\/\/localhost:\d+/.test(srv.log()), '启动日志未打印 https 地址')
  })
  await t('H3 证书 SAN 含 localhost 与 127.0.0.1、有效期 ≤825 天', async () => {
    const x = new crypto.X509Certificate(fs.readFileSync(path.join(CERT_DIR, 'cert.pem')))
    const san = x.subjectAltName ?? ''
    assert(san.includes('DNS:localhost'), `SAN 缺 localhost：${san}`)
    assert(san.includes('IP Address:127.0.0.1'), `SAN 缺 127.0.0.1：${san}`)
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86400000
    assert(days <= 825, `有效期 ${days} 天`)
  })
  await t('H4 HTTP 端口同时可用', async () => {
    const r = await fetch(`http://localhost:${HTTP_PORT}/api/state`)
    assert(r.status === 200, `状态码 ${r.status}`)
    const info = await (await fetch(`http://localhost:${HTTP_PORT}/api/server-info`)).json()
    assert(info.httpsPort === HTTPS_PORT && info.httpPort === HTTP_PORT, `server-info 不对：${JSON.stringify(info)}`)
  })
  await stopServer(srv)

  srv = startServer({ HTTPS_PORT: String(HTTPS_PORT) })
  await t('H5 第二次启动复用已有证书（不重新生成）', async () => {
    const r = await waitFor(() => httpsGet(`https://localhost:${HTTPS_PORT}/api/state`))
    assert(r.status === 200, `状态码 ${r.status}`)
    const pem = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'), 'utf8')
    assert(fingerprint(pem) === fp1, '证书文件被重新生成')
    assert(/使用 HTTPS 证书/.test(srv.log()), '启动日志未提示复用证书')
    assert(!/自动生成自签/.test(srv.log()), '第二次启动不应再生成')
    const served = r.cert?.raw ? new crypto.X509Certificate(r.cert.raw).fingerprint256 : ''
    const onDisk = new crypto.X509Certificate(pem).fingerprint256
    assert(served === onDisk, '服务端下发的证书与磁盘证书不一致')
  })
  await stopServer(srv)

  srv = startServer({})
  await t('H6 未设置 HTTPS_PORT：只起 HTTP、不监听 https', async () => {
    await waitFor(async () => {
      const r = await fetch(`http://localhost:${HTTP_PORT}/api/state`)
      if (r.status !== 200) throw new Error(String(r.status))
    })
    let ok = false
    try {
      await httpsGet(`https://localhost:${HTTPS_PORT}/api/state`)
    } catch {
      ok = true
    }
    assert(ok, 'https 端口仍可访问')
    assert(!/HTTPS/.test(srv.log()), '日志出现 HTTPS 字样')
    const info = await (await fetch(`http://localhost:${HTTP_PORT}/api/server-info`)).json()
    assert(info.httpsPort === null, `httpsPort 应为 null：${JSON.stringify(info)}`)
  })
} finally {
  await stopServer(srv)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
for (const f of failures) console.log(`  ✗ ${f.name}：${f.msg}`)
process.exit(fail ? 1 : 0)
