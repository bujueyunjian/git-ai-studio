#!/usr/bin/env bash
# 准备 Tauri 官方启动器，避免上游以 0770 下载后将该权限带入发布包。
set -euo pipefail

architecture="$(uname -m)"
case "$architecture" in
  x86_64|aarch64) ;;
  *) echo "Unsupported AppImage architecture: $architecture" >&2; exit 1 ;;
esac

# 1. 使用与 Tauri 2.12.4 相同的缓存位置和官方启动器来源。
tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$tools_dir"
app_run="$tools_dir/AppRun-$architecture"
if [ ! -f "$app_run" ]; then
  download="$(mktemp "$tools_dir/AppRun-download.XXXXXX")"
  trap 'rm -f -- "$download"' EXIT
  curl --fail --location --silent --show-error \
    "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-$architecture" \
    --output "$download"
  mv "$download" "$app_run"
fi

# 2. 同时覆盖全新下载与已有缓存；Tauri 随后复制此权限并签名最终产物。
chmod 0755 "$app_run"
stat -c 'AppImage launcher: %n %a' "$app_run"
