#!/usr/bin/env bash
# 中转虚拟库 · Linux 一键更新：拉代码 → 装依赖 → 构建前端 → 重启服务（自动识别 pm2 / systemd）
# 用法：在项目根目录执行  bash scripts/update-board.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

say "拉取最新代码"
# npm 在 Linux 上安装会重排 package-lock.json（平台相关依赖/版本差异），属可再生成的产物；
# 更新前先还原，避免挡住 pull（此前需手动 git checkout 才能继续）
git checkout -- frontend/package-lock.json backend/package-lock.json 2>/dev/null || true
git pull --ff-only

say "安装依赖（增量安装，很快）"
npm --prefix frontend install --no-audit --no-fund
npm --prefix backend install --no-audit --no-fund

say "重新构建前端"
npm run build

say "重启服务"
if pm2 info zzk >/dev/null 2>&1; then
  pm2 restart zzk
  echo "已重启 pm2 服务 zzk，最近日志："
  pm2 logs zzk --lines 15 --nostream
elif systemctl list-unit-files 2>/dev/null | grep -q '^zzk\.service'; then
  sudo systemctl restart zzk
  systemctl --no-pager status zzk | sed -n '1,5p'
  echo "已重启 systemd 服务 zzk，实时日志：journalctl -u zzk -f"
else
  echo "⚠ 未发现 pm2 或 systemd 的 zzk 服务，请手动重启后端进程。"
fi

say "完成。电脑浏览器请强制刷新（Ctrl+F5），手机/钉钉端退出重进。"
