"""iPhone 向けテキスト読み上げアプリのバックエンド。

- GET  /api/texts                      保存されているテキストファイル一覧
- GET  /api/texts/{name}               テキスト内容の取得
- GET  /api/engines                    利用可能な TTS エンジン一覧
- GET  /api/engines/voicevox/voices    VOICEVOX の話者一覧
- POST /api/synthesize                 テキストから合成音声 (WAV) を返す
- 静的ファイル (/)                     frontend ディレクトリを配信
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tts_engine import get_engine as get_jvs_engine
from voicevox_engine import VOICEVOX_URL, get_engine as get_voicevox_engine
import stream

BASE_DIR = Path(__file__).resolve().parent.parent
TEXTS_DIR = BASE_DIR / "texts"
FRONTEND_DIR = BASE_DIR / "frontend"
AUDIO_CACHE_DIR = BASE_DIR / ".cache" / "audio"
AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TEXTS_DIR.mkdir(parents=True, exist_ok=True)

_SAFE_NAME = re.compile(r"^[\w\-. ]+\.txt$")

app = FastAPI(title="JVS Yomiage")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=50000)
    engine: str = "jvs"
    speaker: int | None = None


@app.get("/api/texts")
def list_texts() -> dict:
    names = sorted(p.name for p in TEXTS_DIR.glob("*.txt"))
    return {"texts": names}


@app.get("/api/texts/{name}")
def read_text(name: str) -> dict:
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="invalid name")
    path = TEXTS_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return {"name": name, "content": path.read_text(encoding="utf-8")}


@app.get("/api/engines")
def list_engines() -> dict:
    jvs = get_jvs_engine()
    vv = get_voicevox_engine()
    return {
        "engines": [
            {
                "id": "jvs",
                "name": "JVS (ESPnet VITS)",
                "available": True,
                "device": jvs.device,
                "has_voices": False,
            },
            {
                "id": "voicevox",
                "name": "VOICEVOX",
                "available": vv.health(),
                "url": VOICEVOX_URL,
                "has_voices": True,
            },
        ]
    }


@app.get("/api/engines/voicevox/voices")
def voicevox_voices() -> dict:
    vv = get_voicevox_engine()
    if not vv.health():
        raise HTTPException(
            status_code=503,
            detail=f"VOICEVOX engine not reachable at {VOICEVOX_URL}",
        )
    try:
        return {"voices": vv.list_speakers()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"voicevox error: {exc}") from exc


@app.post("/api/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")

    engine = (req.engine or "jvs").lower()
    speaker = req.speaker

    key_src = f"{engine}|{speaker}|{text}".encode("utf-8")
    key = hashlib.sha256(key_src).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{key}.wav"
    if cache_path.exists():
        return FileResponse(cache_path, media_type="audio/wav")

    try:
        if engine == "voicevox":
            wav_bytes = get_voicevox_engine().synthesize(text, speaker or 1)
        elif engine == "jvs":
            wav_bytes = get_jvs_engine().synthesize(text)
        else:
            raise HTTPException(status_code=400, detail=f"unknown engine: {engine}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"tts failed: {exc}") from exc

    cache_path.write_bytes(wav_bytes)
    return Response(content=wav_bytes, media_type="audio/wav")


@app.post("/api/stream/start")
def stream_start(req: SynthesizeRequest) -> dict:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    try:
        session = stream.create_or_get(text, req.engine or "jvs", req.speaker)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "session_id": session.id,
        "total": session.total,
        "chunks": session.chunks,
        "ready": list(session.ready),
        "durations": list(session.durations),
        "done": session.done,
        "error": session.error,
    }


@app.get("/api/stream/{sid}/status")
def stream_status(sid: str) -> dict:
    session = stream.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "session_id": session.id,
        "total": session.total,
        "ready": list(session.ready),
        "durations": list(session.durations),
        "done": session.done,
        "error": session.error,
    }


@app.get("/api/stream/{sid}/chunk/{idx}")
def stream_chunk(sid: str, idx: int, wait: bool = False) -> Response:
    session = stream.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    if idx < 0 or idx >= session.total:
        raise HTTPException(status_code=400, detail="chunk index out of range")
    if wait and not session.ready[idx]:
        session.wait_for(idx, timeout=180.0)
    if session.error and not session.ready[idx]:
        raise HTTPException(status_code=500, detail=session.error)
    if not session.ready[idx]:
        raise HTTPException(status_code=425, detail="chunk not ready")
    return FileResponse(session.chunk_path(idx), media_type="audio/wav")


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
