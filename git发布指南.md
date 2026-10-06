# 白区库存管理 · git 发布流程（push 即部署）

> 目标：Windows 开发机上改完代码，`git commit` + `npm run release` 两条命令完成发布；
> 服务器自动「备份 → 覆盖程序（data/ 永不动）→ 重启 → 报版本号」。
> 版本可追溯（线上跑的哪个 commit 一查便知）、可回滚（每次发布自动留备份）。

## 架构：两个 git 仓库，各管各的

| 仓库 | 位置 | 内容 | 作用 |
|---|---|---|---|
| 源码仓库 | Gitee `w18636350057/white-area-inventory-management` | 源代码（不带 data/、不带构建产物） | 日常开发、版本历史 |
| 发布仓库 | 服务器 `~/git/bq-release.git`（bare） | 打包产物快照：server.cjs + public/ + VERSION | 每次发布一个快照，钩子自动部署到 /opt/bq |

发布链路：`npm run release` → 构建并组装产物 → 提交快照 → `git push` 到服务器 → post-receive 钩子自动部署到 /opt/bq 并重启 `bq` 服务（端口 **8792**）。

**与中转区并存**：中转虚拟库（zzk，端口 8791）与白区（bq，端口 8792）是同机两个独立服务，各有各的发布仓库和部署目录，互不影响。

---

## 一、一次性配置（只做一次，约 5 分钟）

### 1. Windows：配 ssh 免密

这台开发机配中转区时已做过 `ssh-copy-id jyb@192.168.0.104`，**直接复用，可跳过**。
仅换新电脑时需要：

```bash
ssh-keygen -t ed25519            # 一路回车
ssh-copy-id jyb@192.168.0.104    # 输一次密码，以后免密
ssh jyb@192.168.0.104 exit       # 能直接登录即成功
```

### 2. 服务器（192.168.0.104，ssh 登录后整段粘贴）

```bash
# ---- 部署目录 + systemd 服务（首次）----
sudo mkdir -p /opt/bq && sudo chown -R jyb:jyb /opt/bq
sudo tee /etc/systemd/system/bq.service > /dev/null <<'EOF'
[Unit]
Description=BQ Board (baiqu inventory, port 8792)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 以普通用户运行（与目录属主一致）；取消下行注释并填登录用户名
#User=jyb
WorkingDirectory=/opt/bq
# 若 which node 不是 /usr/bin/node，改成实际路径
ExecStart=/usr/bin/node server.cjs
Environment=PORT=8792
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable bq

# ---- bare 发布仓库 ----
mkdir -p ~/git && git init --bare ~/git/bq-release.git

# ---- post-receive 钩子：push 进来自动 备份→覆盖程序→重启 ----
cat > ~/git/bq-release.git/hooks/post-receive <<'EOF'
#!/bin/bash
set -e
GIT_DIR=$HOME/git/bq-release.git
DEPLOY=/opt/bq
WORK=$(mktemp -d)
git --git-dir=$GIT_DIR --work-tree=$WORK checkout -f main
cp -a $DEPLOY /tmp/bq-bak-$(date +%F-%H%M)          # 回滚保险
rsync -a --delete --exclude=data $WORK/ $DEPLOY/     # data/ 永不覆盖（配置/台账/钉钉凭证）
chown -R jyb:jyb $DEPLOY                              # 防止 root 属主再触发 EACCES
sudo /bin/systemctl restart bq
find /tmp -maxdepth 1 -name 'bq-bak-*' -mtime +7 -exec rm -rf {} +   # 只留最近 7 天备份
echo "== 白区部署完成: $(cat $DEPLOY/VERSION) =="
rm -rf $WORK
EOF
chmod +x ~/git/bq-release.git/hooks/post-receive

# ---- 允许钩子免密重启服务（仅放行这一条命令）----
echo 'jyb ALL=(root) NOPASSWD: /bin/systemctl restart bq' | sudo tee /etc/sudoers.d/bq-restart
sudo chmod 440 /etc/sudoers.d/bq-restart

# ---- 防火墙放行 8792（中转区当年放行过 8791 的做法一样）----
sudo firewall-cmd --permanent --add-port=8792/tcp && sudo firewall-cmd --reload 2>/dev/null || sudo ufw allow 8792/tcp 2>/dev/null || true
```

### 3. 首次部署前：把 data/ 传到服务器（一次性）

发布产物**不含 data/**，所以服务器的钉钉配置、库位登记要先放过去（Windows 项目目录 Git Bash 执行）：

```bash
scp -r backend/data jyb@192.168.0.104:/opt/bq/
```

之后所有发布都不会碰服务器上的 data/。

### 4. Windows：核对发布地址

`scripts/release.mjs` 顶部的 `PROD` 常量（当前为 `jyb@192.168.0.104:git/bq-release.git`），
服务器用户名或 IP 变了就改这里。

---

## 二、日常发布（每次更新代码就这两步）

```bash
# 1. 照常提交源码（release 会把这个 commit 记进 VERSION；顺手推 Gitee 做源码备份）
git add -A && git commit -m "改动说明" && git push

# 2. 一键发布（构建 → 组装 → push → 服务器自动部署重启，全程约 1 分钟）
npm run release
```

push 结束时终端会回显 `remote: == 白区部署完成: <commit> <说明> ==`，看到即成功。

## 三、发布后验证（可选，30 秒）

```bash
# 服务器上，或 Windows 上 ssh 过去执行：
cat /opt/bq/VERSION                     # 线上版本 = 刚才 commit 的 hash
systemctl status bq                     # active (running)
journalctl -u bq -f                     # 盯一个同步周期无报错
```

浏览器/手机端强刷一次 http://192.168.0.104:8792（Ctrl+F5 / 关掉重开）确认新版前端生效。

## 四、回滚（新版有问题时，二选一）

**方式 A · 用自动备份（最快，30 秒）**——每次发布前钩子自动备份到 /tmp：

```bash
ls -dt /tmp/bq-bak-* | head -3                 # 挑一个时间点
sudo systemctl stop bq
sudo rm -rf /opt/bq && sudo mv /tmp/bq-bak-选中的那个 /opt/bq
sudo systemctl start bq
```

**方式 B · 修复代码重新发布**（正规路线）：改好 bug → `git commit` → `npm run release`。

## 五、注意

- 发布产物**不含 data/**：服务器上的库位登记、阈值、钉钉凭证、台账只受设置页和手工操作影响，发布永远不碰。
- `/tmp/bq-bak-*` 备份保留 7 天，自动清理；重要变更前可手动 `cp -a /opt/bq /home/jyb/bq-bak-手动备份名` 留长期档。
- 源码推 Gitee（`git push`）与发布推服务器（`npm run release`）是**两条独立链路**：忘记 git push 只是 Gitee 上没有这次改动的记录，不影响线上部署。
- 服务器搬家/换 IP：改 `scripts/release.mjs` 的 `PROD` + 重建 bare 仓库即可，/opt/bq 整目录拷走照跑。
- 中转区（/opt/zzk、服务 zzk、8791）与白区（/opt/bq、服务 bq、8792）互不干扰，可各自发布、各自回滚。
