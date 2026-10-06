/**
 * 一键制作免安装分发包：node scripts/make-package.mjs
 * 产物：分发包/白区看板-免安装版.zip（收件人解压后双击 start-board.bat 即用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, '分发包')
const appDir = path.join(pkgDir, '白区看板')
const zipFile = path.join(pkgDir, '白区看板-免安装版.zip')

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', shell: process.platform === 'win32' ? 'powershell.exe' : true, ...opts })

console.log('[1/6] 构建前端...')
run('npm run build', { cwd: root, shell: true })

console.log('[2/6] 打包后端为单文件 server.cjs ...')
// target=node14：分发包捆绑的便携 Node 是 v14（官方支持 Win7 SP1 的最后主线），
// 代码里不用全局 fetch 等 Node18+ API，esbuild 负责把更新的语法降级
run('npx esbuild src/index.ts --bundle --platform=node --target=node14 --format=cjs --outfile=../dist-server.cjs', { cwd: path.join(root, 'backend'), shell: true })

console.log('[3/6] 组装目录...')
fs.rmSync(appDir, { recursive: true, force: true })
fs.mkdirSync(path.join(appDir, 'node'), { recursive: true })
fs.mkdirSync(path.join(appDir, 'data'), { recursive: true })
fs.copyFileSync(path.join(root, 'dist-server.cjs'), path.join(appDir, 'server.cjs'))
fs.cpSync(path.join(root, 'backend', 'public'), path.join(appDir, 'public'), { recursive: true })

// 配置随包：库位、阈值、钉钉凭证（台账不带走，收件端首启自动从钉钉拉取）
for (const f of ['locations.json', 'settings.json', 'dingtalk.json']) {
  const src = path.join(root, 'backend', 'data', f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, 'data', f))
}

console.log('[4/6] 附带便携版 node.exe (v14.21.3，官方支持 Win7 SP1+) ...')
// 不用本机 node（v24 在 Win7/8 及未打补丁的旧系统上会报“动态库缺失/失效”），
// 固定用 Node 14 官方 zip 里的 node.exe：Win7 SP1 → Win11 全线可跑
const nodeVer = '14.21.3'
const cacheDir = path.join(pkgDir, '.cache')
const nodeZip = path.join(cacheDir, `node-v${nodeVer}-win-x64.zip`)
const nodeExeDir = path.join(cacheDir, `node-v${nodeVer}-win-x64`)
fs.mkdirSync(cacheDir, { recursive: true })
if (!fs.existsSync(path.join(nodeExeDir, 'node.exe'))) {
  if (!fs.existsSync(nodeZip)) {
    const url = `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip`
    console.log(`  首次需要下载 Node v${nodeVer}（约 30MB，之后走本地缓存）`)
    execSync(`curl -L --fail -o "${nodeZip}" "${url}"`, { shell: true, stdio: 'inherit' })
  }
  fs.rmSync(nodeExeDir, { recursive: true, force: true })
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${nodeZip.replace(/'/g, "''")}' -DestinationPath '${cacheDir.replace(/'/g, "''")}' -Force"`,
    { shell: true, stdio: 'inherit' },
  )
}
fs.copyFileSync(path.join(nodeExeDir, 'node.exe'), path.join(appDir, 'node', 'node.exe'))

// 旧 Windows（Win7/8、精简版、未打补丁的 Win10）常缺 VC++ 与 UCRT 运行库，
// node.exe 一启动就弹“丢失/失效动态库”。运行库 DLL 直接放在 node.exe 同目录即可
// （Windows 加载器优先搜 exe 所在目录），收件电脑无需安装任何东西。
const sysDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
// UCRT 存根(api-ms-win-crt-*.dll)在 Win10/11 的 System32 里不是实体文件：
// 优先用 Windows SDK Redist 的官方 app-local 分发集，其次退回 System32\downlevel
const redistRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\Redist'
const ucrtDirs = fs.existsSync(redistRoot)
  ? fs.readdirSync(redistRoot).filter((d) => /^\d+(\.\d+)+$/.test(d)).sort().reverse()
      .map((d) => path.join(redistRoot, d, 'ucrt', 'DLLs', 'x64'))
      .filter((d) => fs.existsSync(d))
  : []
const stubDir = ucrtDirs[0] || path.join(sysDir, 'downlevel')
if (!fs.existsSync(stubDir)) throw new Error('找不到 UCRT 运行库来源（SDK Redist / System32\\downlevel 均缺失）')
const stubs = fs.readdirSync(stubDir).filter((f) => /^api-ms-win-crt-.*\.dll$/i.test(f))
const ucrtBase = path.join(stubDir, 'ucrtbase.dll')
const rtDlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']
  .map((f) => path.join(sysDir, f))
  .filter((f) => fs.existsSync(f))
  .concat(stubs.map((f) => path.join(stubDir, f)))
  .concat(fs.existsSync(ucrtBase) ? [ucrtBase] : [path.join(sysDir, 'ucrtbase.dll')].filter((f) => fs.existsSync(f)))
let dllCount = 0
for (const src of rtDlls) {
  fs.copyFileSync(src, path.join(appDir, 'node', path.basename(src)))
  dllCount++
}
console.log(`  已附带 ${dllCount} 个运行库 DLL（VC++/UCRT，来源：${stubDir}）`)

console.log('[5/6] 写入启动脚本与说明...')
fs.writeFileSync(
  path.join(appDir, 'start-board.bat'),
  `@echo off
title ZZK Board (portable)
cd /d "%~dp0"
echo ============================================================
echo   ZZK Board - ZhongZhuan Kanban (portable edition)
echo   Data source: DingTalk AI table (auto sync every 2 min)
echo ============================================================
netstat -ano | findstr ":8792" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [OK] Board is already running. Opening browser...
  start "" http://localhost:8792
  exit /b 0
)
echo [START] http://localhost:8792
echo [NOTE]  Keep this window open. Closing it stops the board.
echo ============================================================
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://localhost:8792'"
"node\\node.exe" server.cjs
echo Board service exited.
if errorlevel 1 (
  echo [FAIL] Board service failed to start.
  echo   - Missing/invalid DLL error: your Windows needs Service Pack 1 ^(Win7^) or later.
  echo   - Port 8792 busy: close other running copies of this board first.
)
pause
`,
  'utf8',
)
fs.writeFileSync(
  path.join(appDir, '使用说明.txt'),
  `白区库存管理 · 库位看板 —— 免安装版使用说明
================================================

【怎么用】
1. 解压整个文件夹到任意位置（如 D:\\白区看板），不要只拷里面的文件
2. 双击 start-board.bat —— 3 秒后浏览器自动打开看板
3. 黑色窗口不要关（关了看板就停）；不用时直接关窗口即可，下次双击照常打开

【数据在哪】
所有数据以【钉钉表格 · 出入库流水表】为准：
- 看板每 2 分钟自动同步一次表格；在钉钉里加行/删行/改行，看板自动跟着变
- 网页端点「记一笔」也会自动写入钉钉表格，全组共享
- 每台电脑的看板都是独立显示器，关机、换电脑都不影响数据

【谁在录】
- 一线推荐用手机钉钉在「出入库流水表」里记（入库/出库）
- 电脑端也可以在看板上点绿色「记一笔」按钮

【常见问题】
- 打开后看不到数据：等 2 分钟（首次同步），或检查电脑能否上钉钉
- 双击闪退：右键 start-board.bat → 以管理员运行一次；或检查 8792 端口被占用
- 提示“动态库缺失/失效”：本包自带运行库，一般可直接运行；若仍提示，说明系统过旧
  （Windows 7 需装 SP1 补丁，可搜索“Win7 SP1 离线安装包”），装完再双击即可
- 换电脑：整个文件夹拷走即可，数据在钉钉不受影响
- 停止：关掉黑窗口

【注意】
本程序只能在公司内网使用；data 文件夹里含钉钉应用凭证，请勿外传。
`,
  'utf8',
)

console.log('[6/6] 压缩 zip ...')
fs.rmSync(zipFile, { force: true })
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${appDir.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force"`,
  { shell: true, stdio: 'inherit' },
)
const mb = (fs.statSync(zipFile).size / 1024 / 1024).toFixed(1)
console.log(`\n完成：${zipFile}（${mb} MB）`)
console.log('收件人解压 → 双击 start-board.bat → 浏览器自动打开看板，首启自动从钉钉拉取数据。')
