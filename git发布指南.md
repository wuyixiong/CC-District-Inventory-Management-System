# 中转虚拟库 · git 发布流程（push 即部署）

> 目标：Windows 开发机上改完代码，`git commit` + `npm run release` 两条命令完成发布；
> 服务器自动「备份 → 覆盖程序（data/ 永不动）→ 重启 → 报版本号」。
> 版本可追溯（线上跑的哪个 commit 一查便知）、可回滚（每次发布自动留备份）。

## 架构：两个 git 仓库，各管各的

| 仓库 | 位置 | 内容 | 作用 |
|---|---|---|---|
| 源码仓库 | Windows 项目目录 | 源代码（不带 data/、不带构建产物） | 日常开发、版本历史 |
| 发布仓库 | 服务器 `~/git/zzk-release.git`（bare） | 打包产物快照：server.cjs + public/ + VERSION | 每次发布一个快照，钩子自动部署到 /opt/zzk |

发布链路：`npm run release` → 构建并组装产物 → 提交快照 → `git push` 到服务器 → post-receive 钩子自动部署。

---

## 一、一次性配置（只做一次，约 5 分钟）

### 1. Windows：配 ssh 免密（免得每次 push 输密码）

Git Bash 里执行（已有密钥可跳过第一条）：

```bash
ssh-keygen -t ed25519            # 一路回车
ssh-copy-id jyb@192.168.0.104    # 输一次密码，以后免密
ssh jyb@192.168.0.104 exit       # 能直接登录即成功
```

### 2. 服务器（Mint）：建发布仓库 + 自动部署钩子

ssh 登录服务器后整段粘贴执行：

```bash
# bare 发布仓库
mkdir -p ~/git && git init --bare ~/git/zzk-release.git

# post-receive 钩子：push 进来自动 备份→覆盖程序→重启
cat > ~/git/zzk-release.git/hooks/post-receive <<'EOF'
#!/bin/bash
set -e
GIT_DIR=$HOME/git/zzk-release.git
DEPLOY=/opt/zzk
WORK=$(mktemp -d)
git --git-dir=$GIT_DIR --work-tree=$WORK checkout -f main
cp -a $DEPLOY /tmp/zzk-bak-$(date +%F-%H%M)          # 回滚保险
rsync -a --delete --exclude=data $WORK/ $DEPLOY/     # data/ 永不覆盖（配置/台账/钉钉凭证）
chown -R jyb:jyb $DEPLOY                              # 防止 root 属主再触发 EACCES
sudo /bin/systemctl restart zzk
find /tmp -maxdepth 1 -name 'zzk-bak-*' -mtime +7 -exec rm -rf {} +   # 只留最近 7 天备份
echo "== 部署完成: $(cat $DEPLOY/VERSION) =="
rm -rf $WORK
EOF
chmod +x ~/git/zzk-release.git/hooks/post-receive

# 允许钩子免密重启服务（仅放行这一条命令）
echo 'jyb ALL=(root) NOPASSWD: /bin/systemctl restart zzk' | sudo tee /etc/sudoers.d/zzk-restart
sudo chmod 440 /etc/sudoers.d/zzk-restart
```

### 3. Windows：核对发布地址

`scripts/release.mjs` 顶部的 `PROD` 常量（默认 `jyb@192.168.0.104:git/zzk-release.git`），
服务器用户名或 IP 变了就改这里。

---

## 二、日常发布（每次更新代码就这两步）

```bash
# 1. 照常提交源码（release 会把这个 commit 记进 VERSION）
git add -A && git commit -m "改动说明"

# 2. 一键发布（构建 → 组装 → push → 服务器自动部署重启，全程约 1 分钟）
npm run release
```

push 结束时终端会回显 `remote: == 部署完成: <commit> <说明> ==`，看到即成功。

## 三、发布后验证（可选，30 秒）

```bash
# 服务器上，或 Windows 上 ssh 过去执行：
cat /opt/zzk/VERSION                    # 线上版本 = 刚才 commit 的 hash
systemctl status zzk                    # active (running)
journalctl -u zzk -f                    # 盯一个同步周期无报错
```

浏览器/手机端强刷一次页面（Ctrl+F5 / 关掉重开）确认新版前端生效。

## 四、回滚（新版有问题时，二选一）

**方式 A · 用自动备份（最快，30 秒）**——每次发布前钩子自动备份到 /tmp：

```bash
ls -dt /tmp/zzk-bak-* | head -3                 # 挑一个时间点
sudo systemctl stop zzk
sudo rm -rf /opt/zzk && sudo mv /tmp/zzk-bak-选中的那个 /opt/zzk
sudo systemctl start zzk
```

**方式 B · 修复代码重新发布**（正规路线）：改好 bug → `git commit` → `npm run release`。

## 五、注意

- 发布产物**不含 data/**：服务器上的库位登记、阈值、钉钉凭证、台账只受设置页和手工操作影响，发布永远不碰。
- `/tmp/zzk-bak-*` 备份保留 7 天，自动清理；重要变更前可手动 `cp -a /opt/zzk /home/jyb/zzk-bak-手动备份名` 留长期档。
- 服务器搬家/换 IP：改 `scripts/release.mjs` 的 `PROD` + 重建 bare 仓库即可，/opt/zzk 整目录拷走照跑。
- 源码仓库本身建议也做异地备份（U 盘 / Gitee 私有仓库）：`git remote add backup <地址>` 后定期 `git push backup`。
