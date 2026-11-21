/**
 * HTTPS 证书：手机浏览器调用摄像头扫码要求安全上下文（https），局域网内用自签证书即可。
 * 优先读 DATA_DIR/cert/key.pem + cert.pem；不存在则自动生成自签证书（SAN 含 localhost、127.0.0.1 与本机所有局域网 IPv4）并保存复用。
 * 生成用 Node 自带 crypto.generateKeyPairSync（Node ≥10.12）+ node-forge（纯 JS）签发证书，兼容分发包的 Node 14。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import forge from 'node-forge'

export function lanIPv4(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      // Node 18.0~18.3 的 family 可能是数字 4
      if ((n.family === 'IPv4' || (n.family as unknown) === 4) && !n.internal) out.push(n.address)
    }
  }
  return out
}

export function generateSelfSigned(ips: string[]): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey)
  cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex')
  const now = new Date()
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  // iOS 对 >825 天的证书会拒绝，取 820 天
  cert.validity.notAfter = new Date(now.getTime() + 820 * 24 * 3600 * 1000)
  const attrs = [
    { name: 'commonName', value: 'baiqu-inventory-board' },
    { name: 'organizationName', value: 'Baiqu Inventory Board (self-signed)' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  const altNames: Array<{ type: number; value?: string; ip?: string }> = [{ type: 2, value: 'localhost' }]
  for (const ip of Array.from(new Set(['127.0.0.1', ...ips]))) altNames.push({ type: 7, ip })
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ])
  cert.sign(forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey, forge.md.sha256.create())
  return { key: privateKey, cert: forge.pki.certificateToPem(cert) }
}

/** 读取或生成证书；generated=true 表示本次新生成 */
export function loadOrCreateCert(dataDir: string): { key: string; cert: string; dir: string; generated: boolean } {
  const dir = path.join(dataDir, 'cert')
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), dir, generated: false }
  }
  const pair = generateSelfSigned(lanIPv4())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(keyFile, pair.key, { mode: 0o600 })
  fs.writeFileSync(certFile, pair.cert)
  return { ...pair, dir, generated: true }
}
