"""HTTP entrypoint for the OCR + Random Forest pipeline on Vercel Services.

Runs as an internal FastAPI service (never publicly routed). The Next.js app
calls it over the ML_URL service binding; requests POST the pipeline payload
as JSON and receive the same NDJSON event stream pipeline.py writes to stdout.

    POST /pipeline   {mode, seed, n_trees, n_synth, applicants, ocr_results}
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

ML_DIR = Path(__file__).resolve().parent
NDJSON_MEDIA = "application/x-ndjson; charset=utf-8"
NDJSON_HEADERS = {
    "Content-Type": NDJSON_MEDIA,
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
}
_EOF = object()

app = FastAPI(title="scholar-capstone2 ML pipeline", version="1.0.0")


@app.get("/")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "service": "ml", "python": sys.version.split()[0]})


@app.post("/pipeline")
def pipeline(payload: dict) -> StreamingResponse:
    return StreamingResponse(_stream_pipeline(payload), media_type=NDJSON_MEDIA, headers=NDJSON_HEADERS)


def _stream_pipeline(payload: dict) -> Iterator[str]:
    proc = subprocess.Popen(
        [sys.executable, str(ML_DIR / "pipeline.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ML_DIR),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    events: "queue.Queue" = queue.Queue(maxsize=1024)

    def pump(stream, wrap=None) -> None:
        try:
            for line in stream:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                events.put(wrap(line) if wrap else json.dumps({"type": "log", "msg": line}) + "\n"
                           if not line.startswith("{") else line + "\n")
        except (ValueError, OSError):
            pass
        finally:
            events.put(_EOF)

    threading.Thread(target=pump, args=(proc.stdout,), daemon=True).start()
    threading.Thread(
        target=pump,
        args=(proc.stderr, lambda line: json.dumps({"type": "log", "msg": f"[python] {line}", "stream": "stderr"}) + "\n"),
        daemon=True,
    ).start()

    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(payload))
        proc.stdin.close()
    except (BrokenPipeError, ValueError, OSError):
        pass

    eof_count = 0
    while eof_count < 2:
        item = events.get()
        if item is _EOF:
            eof_count += 1
        else:
            yield item

    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
