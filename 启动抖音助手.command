#!/bin/zsh
set -u
SCRIPT_DIR="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$SCRIPT_DIR" || exit 1
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  print -r -- "未找到 Node.js，请安装 Node.js 22 或更新版本后重试。"
  read -r '?按回车关闭…'
  exit 1
fi
if ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print -r -- "当前 Node.js 版本低于 22，请更新后重试。"
  if [[ -t 0 ]]; then read -r '?按回车关闭…'; fi
  exit 1
fi
"$NODE_BIN" scripts/start-local.mjs "$@"
START_RESULT=$?
if [[ -t 0 ]]; then
  print
  read -r '?按回车关闭此窗口，后台会继续运行…'
fi
exit "$START_RESULT"
