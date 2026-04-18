"""iPhone 向けテキスト読み上げアプリのバックエンド。

- GET  /api/texts                保存されているテキストファイル一覧
- GET  /api/texts/{name}         テキスト内容の取得
- POST /api/synthesize           テキストから合成音声 (WAV) を返す
- 静的ファイル (/)               frontend ディレクトリを配信
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

from tts_engine import get_engine

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
    text: str = Field(..., min_length=1, max_length=5000)


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


@app.post("/api/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")

    key = hashlib.sha256(text.encode("utf-8")).hexdigest()
    cache_path = AUDIO_CACHE_DIR / f"{key}.wav"
    if cache_path.exists():
        return FileResponse(cache_path, media_type="audio/wav")

    try:
        wav_bytes = get_engine().synthesize(text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"tts failed: {exc}") from exc

    cache_path.write_bytes(wav_bytes)
    return Response(content=wav_bytes, media_type="audio/wav")


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
