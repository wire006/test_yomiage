"""ストリーミング合成のセッション管理 (VOICEVOX 専用)。

クライアントは /api/stream/start でセッションを開始し、裏で 1 チャンクずつ
合成が進む。/api/stream/{sid}/chunk/{idx} で各 WAV を取得する (まだ合成が
済んでいない場合は wait=true で完了を待てる)。/api/stream/{sid}/status で
進捗をポーリングする。

セッションは (text, speaker) のハッシュで決まるので、同じ入力を再投入
してもキャッシュが効く。
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import soundfile as sf

from text_utils import split_into_chunks

_STREAM_DIR = Path(".cache/stream")
_STREAM_DIR.mkdir(parents=True, exist_ok=True)

_MAX_CHARS = 120


@dataclass
class StreamSession:
    id: str
    speaker: int | None
    speed: float
    chunks: list[str]
    dir: Path
    ready: list[bool] = field(default_factory=list)
    durations: list[float | None] = field(default_factory=list)
    error: str | None = None
    done: bool = False
    _thread: threading.Thread | None = None
    _cond: threading.Condition = field(default_factory=threading.Condition)

    def __post_init__(self) -> None:
        n = len(self.chunks)
        if not self.ready:
            self.ready = [False] * n
        if not self.durations:
            self.durations = [None] * n
        for i in range(n):
            path = self.dir / f"{i:05d}.wav"
            if path.exists():
                try:
                    self.durations[i] = float(sf.info(path).duration)
                    self.ready[i] = True
                except Exception:  # noqa: BLE001
                    path.unlink(missing_ok=True)

    @property
    def total(self) -> int:
        return len(self.chunks)

    def chunk_path(self, idx: int) -> Path:
        return self.dir / f"{idx:05d}.wav"

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if all(self.ready):
            self.done = True
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _synth_chunk(self, text: str) -> bytes:
        from voicevox_engine import get_engine

        return get_engine().synthesize(text, self.speaker or 1, self.speed)

    def _run(self) -> None:
        try:
            for i, text in enumerate(self.chunks):
                if self.ready[i]:
                    continue
                wav = self._synth_chunk(text)
                path = self.chunk_path(i)
                path.write_bytes(wav)
                try:
                    self.durations[i] = float(sf.info(path).duration)
                except Exception:  # noqa: BLE001
                    self.durations[i] = None
                with self._cond:
                    self.ready[i] = True
                    self._cond.notify_all()
            with self._cond:
                self.done = True
                self._cond.notify_all()
        except Exception as exc:  # noqa: BLE001
            with self._cond:
                self.error = str(exc)
                self.done = True
                self._cond.notify_all()

    def wait_for(self, idx: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self._cond:
            while not self.ready[idx] and not self.error:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
        return self.ready[idx]


_sessions: dict[str, StreamSession] = {}
_registry_lock = threading.Lock()


def create_or_get(text: str, speaker: int | None, speed: float = 1.0) -> StreamSession:
    text = text.strip()
    if not text:
        raise ValueError("empty text")
    speed = round(float(speed), 1)
    key_src = f"voicevox|{speaker}|{speed:.1f}|{text}".encode("utf-8")
    sid = hashlib.sha256(key_src).hexdigest()[:24]

    with _registry_lock:
        existing = _sessions.get(sid)
        if existing is not None:
            existing.start()
            return existing

        chunks = split_into_chunks(text, _MAX_CHARS) or [text]
        sdir = _STREAM_DIR / sid
        sdir.mkdir(parents=True, exist_ok=True)
        session = StreamSession(
            id=sid,
            speaker=speaker,
            speed=speed,
            chunks=chunks,
            dir=sdir,
        )
        _sessions[sid] = session
        session.start()
        return session


def get(sid: str) -> StreamSession | None:
    with _registry_lock:
        return _sessions.get(sid)
