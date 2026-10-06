/**
 * 一键发布到服务器：npm run release
 * 前提（一次性配置，见 git发布指南.md）：
 *   1. 服务器已建 bare 仓库 ~/git/zzk-release.git 并装好 post-receive 钩子
 *   2. Windows 已配 ssh 免密登录服务器（ssh-copy-id）
 * 流程：构建前端/后端 → 组装产物（不含 data/，服务器配置与台账永不覆盖）
 *      → 写 VERSION(源码 commit) → 提交发布快照 → push 触发服务器自动部署+重启
 * 服务器验证：cat /opt/zzk/VERSION && journalctl -u zzk -f
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ===== 按实际环境修改这里 =====
const PROD = 'jyb@192.168.0.104:git/zzk-release.git' // 服务器 bare 仓库（ssh 地址:路径，路径相对家目录）
// ==============================

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '分发包', 'zzk-release-work')
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', shell: true, ...opts })
const out = (cmd, opts = {}) => execSync(cmd, { shell: true, ...opts }).toString().trim()

// 0. 源码有未提交改动时警告（VERSION 记录的是最后一次 commit，未提交的改动不会包含在版本号语义里）
const dirty = out('git status --porcelain', { cwd: root })
if (dirty) console.log('[警告] 源码有未提交的改动，建议先 git commit 再发布（本次 VERSION 将记为上一次 commit）\n')

const hash = out('git rev-parse --short HEAD', { cwd: root })
const subject = out('git log -1 --pretty=%s', { cwd: root })

console.log('[1/4] 构建前端 + 打包后端 ...')
run('npm run build', { cwd: root })
run('npx esbuild src/index.ts --bundle --platform=node --target=node14 --format=cjs --outfile=../dist-server.cjs', { cwd: path.join(root, 'backend') })

console.log('[2/4] 组装发布产物（不含 data/）...')
if (!fs.existsSync(work)) fs.mkdirSync(work, { recursive: true })
// 清空工作目录但保留 .git（保留发布历史，便于回滚重发）
for (const e of fs.readdirSync(work)) if (e !== '.git') fs.rmSync(path.join(work, e), { recursive: true, force: true })
fs.copyFileSync(path.join(root, 'dist-server.cjs'), path.join(work, 'server.cjs'))
fs.cpSync(path.join(root, 'backend', 'public'), path.join(work, 'public'), { recursive: true })
fs.writeFileSync(path.join(work, 'VERSION'), `${hash} ${subject} @ ${new Date().toLocaleString('zh-CN')}\n`, 'utf8')

console.log('[3/4] 提交发布快照 ...')
if (!fs.existsSync(path.join(work, '.git'))) run('git init -q', { cwd: work })
run('git add -A', { cwd: work })
run(`git diff --cached --quiet || git commit -q -m "release ${hash} ${subject}"`, { cwd: work })
run('git branch -M main', { cwd: work })

console.log('[4/4] 推送到服务器（触发自动部署）...')
run(`git push -f ${PROD} main`, { cwd: work })
console.log(`\n发布完成：${hash} ${subject}`)
console.log('服务器验证：cat /opt/zzk/VERSION && journalctl -u zzk -f')
