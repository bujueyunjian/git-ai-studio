"""在无特权、离线的 X11 会话中验证 AppImage 窗口和持续运行状态。"""

import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time


def check_permissions(app_dir):
    """要求所有普通文件可读，目录和可执行文件允许其他用户执行。"""
    if os.geteuid() == 0 or os.geteuid() == app_dir.stat().st_uid:
        raise RuntimeError("Smoke test must run as a different, unprivileged user")
    for path in [app_dir, *app_dir.rglob("*")]:
        if path.is_symlink():
            continue
        mode = path.stat().st_mode
        required = stat.S_IROTH
        if path.is_dir() or mode & 0o111:
            required |= stat.S_IXOTH
        if mode & required != required:
            raise RuntimeError(f"Package permissions deny other users: {path} {stat.S_IMODE(mode):04o}")
    for name in ("AppRun", "AppRun.wrapped", "usr/bin/git-ai-studio"):
        if not os.access(app_dir / name, os.X_OK):
            raise RuntimeError(f"Launcher is not executable: {name}")


def wait_for_window(process):
    """等待主窗口可见，启动失败或超过 30 秒时保留真实失败。"""
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"AppImage exited before showing a window: {process.returncode}")
        windows = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", "^Git AI Studio$"],
            capture_output=True, text=True, check=False,
        )
        if windows.returncode == 0:
            return windows.stdout.splitlines()[0]
        if windows.returncode != 1:
            raise RuntimeError(f"Window query failed: {windows.stderr}")
        time.sleep(0.5)
    raise RuntimeError("AppImage did not show its main window within 30 seconds")


def main():
    """检查权限、启动主窗口并观察 15 秒，保存日志与截图后清理进程。"""
    app_dir, results_dir = map(Path, sys.argv[1:])

    # 1. 以包拥有者之外的用户验证实际访问权限。
    check_permissions(app_dir)
    with (results_dir / "application.log").open("w") as log:
        process = subprocess.Popen(
            [str(app_dir / "AppRun")], cwd=app_dir,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            # 2. 确认窗口出现并持续运行，覆盖目录测试中 11 秒内退出的失败路径。
            window = wait_for_window(process)
            for _ in range(15):
                time.sleep(1)
                if process.poll() is not None:
                    raise RuntimeError(f"AppImage exited after opening its window: {process.returncode}")
            subprocess.run(["xdotool", "getwindowname", window], check=True)
            subprocess.run(["import", "-window", window, str(results_dir / "window.png")], check=True)
            colors = subprocess.check_output(
                ["identify", "-format", "%k", str(results_dir / "window.png")], text=True,
            )
            if int(colors) <= 1:
                raise RuntimeError("AppImage opened a blank window; inspect application.log and window.png")
            report = {"uid": os.geteuid(), "package_owner": app_dir.stat().st_uid,
                      "window": window, "offline": True, "stable_seconds": 15,
                      "rendered_colors": int(colors), "passed": True}
            (results_dir / "startup.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report))
        finally:
            # 3. 清理本次应用及其子进程，保留日志供失败诊断。
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


if __name__ == "__main__":
    main()
