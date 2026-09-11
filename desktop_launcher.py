"""Launch the K-line training app as a local Windows desktop application."""

from __future__ import annotations

import os
from pathlib import Path
import socket
import sys
import threading
import time
import traceback
import webbrowser


def find_free_port(start: int = 18000) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("找不到可用的本地端口，请关闭占用 18000-18049 的程序后重试。")


def runtime_base_dir():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def wait_until_ready(port: int, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def show_startup_error(message: str) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, "K线训练启动失败", 0x10)
    except Exception:
        pass


def write_startup_failure(stage: str, exc: Exception) -> None:
    try:
        log_path = Path(os.getenv("TEMP", ".")) / "kline-training-startup.log"
        log_path.write_text(
            f"阶段：{stage}\n错误：{exc}\n\n{traceback.format_exc()}",
            encoding="utf-8",
        )
    except Exception:
        pass


def main() -> None:
    http_server = None
    stage = "开始启动"
    try:
        stage = "查找本地端口"
        port = find_free_port()
        os.environ["HOST"] = "127.0.0.1"
        os.environ["PORT"] = str(port)

        stage = "加载本地服务"
        from http.server import ThreadingHTTPServer
        from server import AppHandler

        stage = "创建本地服务"
        base_dir = runtime_base_dir()
        http_server = ThreadingHTTPServer(
            ("127.0.0.1", port),
            lambda *args, **kwargs: AppHandler(*args, directory=str(base_dir), **kwargs),
        )
        stage = "启动本地服务"
        server_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        server_thread.start()
        stage = "等待本地服务就绪"
        if not wait_until_ready(port):
            raise RuntimeError(f"本地服务未能在端口 {port} 启动，请检查防火墙或重试。")

        stage = "打开浏览器"
        url = f"http://127.0.0.1:{port}/"
        # Some Windows browser handlers may block; keep that call away from the server loop.
        threading.Thread(target=lambda: webbrowser.open_new(url), daemon=True).start()
        server_thread.join()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        write_startup_failure(stage, exc)
        show_startup_error(f"{exc}\n\n请重新双击程序；如果仍失败，请把此提示截图发回来。")
    finally:
        if http_server is not None:
            http_server.shutdown()
            http_server.server_close()


if __name__ == "__main__":
    main()
