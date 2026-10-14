"""Bounded real-PTY experiment. No terminal emulation or production transport; uses OS PTY only.
Called by native-tui-prototype.ts with an isolated, already-authorized synthetic HOME.
"""
import json
import os
import pty
import select
import subprocess
import sys
import time
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text())
root = Path(config["root"])
master, slave = pty.openpty()
process = subprocess.Popen(config["argv"], stdin=slave, stdout=slave, stderr=slave,
                           cwd=config["workspace"], env=config["environment"], start_new_session=True)
os.close(slave)
os.set_blocking(master, False)
output = bytearray()


def drain():
    try:
        output.extend(os.read(master, 65536))
    except (BlockingIOError, OSError):
        pass


def send(data):
    deadline = time.monotonic() + 5
    while data and time.monotonic() < deadline:
        readable, writable, _ = select.select([master], [master], [], 0.1)
        if readable:
            drain()
        if writable:
            try:
                data = data[os.write(master, data):]
            except BlockingIOError:
                pass
    if data:
        raise TimeoutError("native PTY input backpressure")


def wait_file(name, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if (root / name).exists():
            return
        if process.poll() is not None:
            raise RuntimeError(f"native TUI exited before {name}: {process.returncode}")
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            drain()
    raise TimeoutError(f"native TUI did not reach {name}")


try:
    wait_file("ready.json")
    # Startup completion is not a command-completion proof. The experiment supplies its own component markers.
    time.sleep(1)
    send(b"/future-tui exact native args\r")
    wait_file("custom-entered.json")
    send(b"x")
    wait_file("custom-completed.json")
    send(b"/future-tui-error actual side effect\r")
    wait_file("error-effect.json")
    time.sleep(0.5)
    # Standard TUI shutdown. Its exit status is not treated as command success.
    send(b"\x03\x03")
    deadline = time.monotonic() + 5
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            drain()
    if process.poll() is None:
        process.terminate()
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                drain()
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    (root / "terminal.raw").write_bytes(output)
    os.close(master)
