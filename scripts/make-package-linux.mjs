/**
 * 一键制作 Linux 服务器部署包：node scripts/make-package-linux.mjs
 * 产物：分发包/白区看板-linux.tar.gz（server.cjs + 前端 + 配置 + systemd 服务 + 部署说明）
 * 服务器要求：任意 Linux x64 + Node.js ≥14（推荐 LTS 20/22），能访问 api.dingtalk.com
 * 说明：Windows 包捆绑 node.exe，Linux 包不捆 Node（服务器用系统 Node 即可），
 *       server.cjs 为纯 JS 无原生依赖，Windows/Linux 通用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, '分发包')
// 打包过程用 ASCII 目录/文件名避免 Windows cmd 编码坑，最后再改中文名
const stageRoot = path.join(pkgDir, 'bq-linux-stage')
const stageApp = path.join(stageRoot, 'zzk')
const asciiTar = path.join(pkgDir, 'bq-linux.tar.gz')
const finalTar = path.join(pkgDir, '白区看板-linux.tar.gz')

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', shell: true, ...opts })

console.log('[1/5] 构建前端...')
run('npm run build', { cwd: root })

console.log('[2/5] 打包后端为单文件 server.cjs ...')
run('npx esbuild src/index.ts --bundle --platform=node --target=node14 --format=cjs --outfile=../dist-server.cjs', { cwd: path.join(root, 'backend') })

console.log('[3/5] 组装目录...')
fs.rmSync(stageRoot, { recursive: true, force: true })
fs.mkdirSync(stageApp, { recursive: true })
fs.mkdirSync(path.join(stageApp, 'data'), { recursive: true })
fs.copyFileSync(path.join(root, 'dist-server.cjs'), path.join(stageApp, 'server.cjs'))
fs.cpSync(path.join(root, 'backend', 'public'), path.join(stageApp, 'public'), { recursive: true })
// 配置随包（含钉钉凭证；台账不带走，首启自动从钉钉镜像拉取）
for (const f of ['locations.json', 'settings.json', 'dingtalk.json']) {
  const src = path.join(root, 'backend', 'data', f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stageApp, 'data', f))
}

console.log('[4/5] 写入 systemd 服务与部署说明...')
fs.writeFileSync(
  path.join(stageApp, 'bq.service'),
  `[Unit]
Description=BQ Board (baiqu inventory, port 8792)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 以普通用户运行（与解压目录属主一致，避免 root/普通用户交替写 data/ 出现权限问题）
# 取消下行注释并填你的登录用户名（如 jyb）
#User=jyb
WorkingDirectory=/opt/bq
# 若 which node 不是 /usr/bin/node，把下面这行改成实际路径
ExecStart=/usr/bin/node server.cjs
Environment=PORT=8792
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`,
  'utf8',
)
fs.writeFileSync(
  path.join(stageApp, 'DEPLOY-Linux.md'),
  `# Linux 服务器部署说明

## 服务器要求
- Linux x64（CentOS / Ubuntu / 统信 UOS 等均可）
- Node.js ≥ 14（推荐 LTS 20/22）
- 能访问 api.dingtalk.com（钉钉表格同步）
- 固定内网 IP（地址不变，大家才好收藏/配钉钉入口）

## 1. 安装 Node.js（已有可跳过）
有外网时：
  # Ubuntu / Debian
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
  # CentOS / RHEL
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs
离线时：到 https://nodejs.org 下载 linux-x64 的 tar.xz，解压后把 bin/node 链到 /usr/local/bin/。

验证：node -v

## 2. 上传解压
  scp 白区看板-linux.tar.gz 用户@服务器IP:/tmp/
  sudo mkdir -p /opt/bq
  sudo tar -xzf /tmp/白区看板-linux.tar.gz -C /opt/bq --strip-components=1
  # 必做：把目录属主改成你的登录用户（程序运行时要写 data/ 下的台账与同步状态，
  # 属主是 root 的话普通用户启动会报 EACCES: permission denied）
  sudo chown -R $USER:$USER /opt/bq

## 3. 手动试跑一次
  cd /opt/bq && node server.cjs
看到「服务已启动: http://localhost:8792」即正常，Ctrl+C 停止。

## 4. 设为常驻服务（开机自启 + 挂了自动拉起）
  which node                       # 确认路径，若非 /usr/bin/node 先改 bq.service 里的 ExecStart
  nano bq.service                 # 建议取消 #User=jyb 注释并填你的登录用户名，
                                   # 让服务与手动运行用同一身份写 data/（否则 root 写过的文件普通用户又碰不了）
  sudo cp /opt/bq/bq.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now bq
  systemctl status bq             # active (running) 即成功

## 5. 防火墙放行 8792
  # firewalld（CentOS 默认）
  sudo firewall-cmd --permanent --add-port=8792/tcp && sudo firewall-cmd --reload
  # 或 ufw（Ubuntu 默认）
  sudo ufw allow 8792/tcp

## 6. 分发访问地址
  http://服务器IP:8792
  电脑/手机/大屏（与服务器同内网）直接打开；二维码、钉钉工作台首页地址也填它。

## 日常运维
  日志：journalctl -u bq -f
  重启：sudo systemctl restart bq
  备份（建议 crontab 每天）：cp -a /opt/bq/data /备份盘/zzk-$(date +%F)
  升级（代码更新后重新发布，约 1 分钟）：
    开发机：node scripts/make-package-linux.mjs
            scp 分发包/白区看板-linux.tar.gz 用户@服务器IP:/tmp/
    服务器：
      cp -a /opt/bq /tmp/zzk-bak-$(date +%F-%H%M)   # 整目录备份（回滚保险）
      # --exclude=data：服务器上的库位/阈值/钉钉凭证/台账不被开发机打包时的旧配置覆盖
      sudo tar -xzf /tmp/白区看板-linux.tar.gz -C /opt/bq --strip-components=1 --exclude=data
      sudo chown -R $USER:$USER /opt/bq             # sudo 解压属主会变 root，必须改回，否则写 data/ 报 EACCES
      sudo systemctl restart bq && journalctl -u bq -f   # 验证：active + 同步周期无报错
    回滚（新版有问题时）：
      sudo systemctl stop zzk && rm -rf /opt/bq && mv /tmp/zzk-bak-日期 /opt/bq && sudo systemctl start zzk
    只改了前端的偷懒方式：开发机 npm run build 后传 backend/public 覆盖 /opt/bq/public 即可，无需重启。

## 安全（必读）
  系统无登录鉴权，仅限内网使用，绝不可把 8792 端口映射到公网（路由器不做端口映射/DMZ）。
  data/ 内含钉钉应用凭证，请勿外传。
`,
  'utf8',
)

console.log('[5/5] 压缩 tar.gz ...')
fs.rmSync(asciiTar, { force: true })
fs.rmSync(finalTar, { force: true })
run('tar -czf bq-linux.tar.gz -C bq-linux-stage zzk', { cwd: pkgDir })
fs.renameSync(asciiTar, finalTar)
fs.rmSync(stageRoot, { recursive: true, force: true })
const mb = (fs.statSync(finalTar).size / 1024 / 1024).toFixed(1)
console.log(`\n完成：${finalTar}（${mb} MB）`)
console.log('上传服务器 → 按 包内 DEPLOY-Linux.md 五步部署（装Node / 解压 / systemd / 防火墙 / 分发地址）。')
