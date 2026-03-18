from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any


class Rpc:
    def __init__(self, path: Path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(path))
        self.f = self.sock.makefile("rwb")

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = {"method": method, "params": params or {}}
        self.f.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.f.flush()
        line = self.f.readline()
        if not line:
            raise RuntimeError("socket closed")
        out = json.loads(line.decode("utf-8"))
        if isinstance(out, dict) and out.get("error"):
            raise RuntimeError(str(out["error"]))
        return out

    def close(self) -> None:
        try:
            self.f.close()
        finally:
            self.sock.close()
