#!/usr/bin/env bash
# 保留成品权限解包，再以不同的普通用户在离线 X11 会话中验证启动。
set -euo pipefail

appimage="$(realpath "$1")"
results_dir="$(realpath -m "$2")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$results_dir"
# 初始化本次检查的三个产物，失败时不能留下旧的通过记录。
rm -f -- "$results_dir/startup.json" "$results_dir/application.log" "$results_dir/window.png"
check_dir="$(mktemp -d /tmp/git-ai-studio-appimage.XXXXXX)"

# 保存诊断结果并只清理本次创建的验证目录。
cleanup() {
  status=$?
  if [ -d "$check_dir/results" ]; then
    cp -R "$check_dir/results/." "$results_dir/"
  fi
  sudo rm -rf -- "$check_dir"
  exit "$status"
}
trap cleanup EXIT

# 1. 按 SquashFS 元数据解包；runtime 的 --appimage-extract 会将根目录创建为 0700。
chmod 0755 "$check_dir"
appimage_offset="$("$appimage" --appimage-offset)"
unsquashfs -no-progress -o "$appimage_offset" -d "$check_dir/squashfs-root" "$appimage" >/dev/null
for entry in "$check_dir/squashfs-root/.DirIcon" "$check_dir/squashfs-root/"*.desktop; do
  if [ ! -f "$entry" ]; then
    echo "AppImage metadata missing or broken: $entry" >&2
    exit 1
  fi
  if [ -L "$entry" ] && [[ "$(readlink "$entry")" = /* ]]; then
    echo "AppImage metadata uses an absolute symlink: $entry" >&2
    exit 1
  fi
done

# 2. 为无特权账号提供独立目录和显示服务，同时隔离外部网络。
sudo install -d -o nobody -g nogroup -m 0755 "$check_dir/results"
sudo install -d -o nobody -g nogroup -m 0700 "$check_dir/home" "$check_dir/runtime"
cp "$script_dir/check-appimage-window.py" "$check_dir/check-window.py"
sudo unshare --net -- runuser -u nobody -- env \
  -u XDG_CONFIG_HOME -u XDG_CACHE_HOME -u XDG_DATA_HOME \
  HOME="$check_dir/home" XDG_RUNTIME_DIR="$check_dir/runtime" \
  GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' \
  dbus-run-session -- python3 "$check_dir/check-window.py" \
  "$check_dir/squashfs-root" "$check_dir/results"
