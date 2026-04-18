"""JVS コーパスで学習された ESPnet-TTS モデルで音声合成する。

ESPnet モデルズーには JVS コーパスで学習された日本語多話者 TTS モデル
(kan-bayashi/jvs_jvs010_vits_prosody など) が公開されているため、
それを利用する。初回呼び出し時にモデルをダウンロード・キャッシュする。

長文は文単位で分割して合成し、結果を連結する。VITS は短文向けの学習で
長文を一度に渡すと C 拡張 (pyopenjtalk 等) でクラッシュすることがある。
"""

from __future__ import annotations

import io
import os
import re
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

_DEFAULT_MODEL_TAG = os.environ.get(
    "JVS_MODEL_TAG", "kan-bayashi/jvs_jvs010_vits_prosody"
)
_CACHE_DIR = Path(os.environ.get("JVS_CACHE_DIR", "./.cache/espnet"))
_MAX_CHUNK_CHARS = int(os.environ.get("JVS_MAX_CHUNK_CHARS", "60"))
_CHUNK_SILENCE_SEC = float(os.environ.get("JVS_CHUNK_SILENCE_SEC", "0.25"))

_SENT_BOUNDARY = re.compile(r"(?<=[。！？!?\n])")
_SUB_BOUNDARY = re.compile(r"(?<=[、,])")


def _split_into_chunks(text: str, max_chars: int = _MAX_CHUNK_CHARS) -> list[str]:
    """文末記号 (。！？改行) で区切り、長すぎる文は読点でさらに分割する。"""
    pieces = [p.strip() for p in _SENT_BOUNDARY.split(text) if p.strip()]
    chunks: list[str] = []
    for piece in pieces:
        if len(piece) <= max_chars:
            chunks.append(piece)
            continue
        for sub in _SUB_BOUNDARY.split(piece):
            sub = sub.strip()
            if not sub:
                continue
            while len(sub) > max_chars:
                chunks.append(sub[:max_chars])
                sub = sub[max_chars:]
            if sub:
                chunks.append(sub)
    return chunks


class JVSTextToSpeech:
    """遅延初期化の TTS ラッパ。

    ESPnet のロードは重いのでプロセスあたり 1 回だけ行う。
    """

    def __init__(self, model_tag: str = _DEFAULT_MODEL_TAG) -> None:
        self.model_tag = model_tag
        self._tts = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._tts is not None:
            return
        with self._lock:
            if self._tts is not None:
                return
            from espnet2.bin.tts_inference import Text2Speech
            from espnet_model_zoo.downloader import ModelDownloader

            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            downloader = ModelDownloader(cachedir=str(_CACHE_DIR))
            model_files = downloader.download_and_unpack(self.model_tag)
            self._tts = Text2Speech.from_pretrained(
                model_tag=self.model_tag,
                **model_files,
            )

    @property
    def sample_rate(self) -> int:
        self._ensure_loaded()
        return int(self._tts.fs)

    def synthesize(self, text: str) -> bytes:
        """テキストから WAV バイト列を生成する。"""
        if not text.strip():
            raise ValueError("text is empty")
        self._ensure_loaded()

        chunks = _split_into_chunks(text) or [text.strip()]
        sr = self.sample_rate
        silence = np.zeros(int(sr * _CHUNK_SILENCE_SEC), dtype=np.float32)

        wavs: list[np.ndarray] = []
        for i, chunk in enumerate(chunks):
            result = self._tts(chunk)
            wav = result["wav"].view(-1).cpu().numpy().astype(np.float32)
            wavs.append(wav)
            if i != len(chunks) - 1:
                wavs.append(silence)

        full = np.concatenate(wavs) if wavs else np.zeros(0, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, full, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()


_engine: JVSTextToSpeech | None = None


def get_engine() -> JVSTextToSpeech:
    global _engine
    if _engine is None:
        _engine = JVSTextToSpeech()
    return _engine
