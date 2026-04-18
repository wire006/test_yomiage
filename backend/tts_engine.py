"""JVS コーパスで学習された ESPnet-TTS モデルで音声合成する。

ESPnet モデルズーには JVS コーパスで学習された日本語多話者 TTS モデル
(kan-bayashi/jvs_jvs010_vits_prosody など) が公開されているため、
それを利用する。初回呼び出し時にモデルをダウンロード・キャッシュする。

GPU が利用可能 (CUDA) なら自動で cuda を使う。環境変数 JVS_DEVICE=cpu
で強制的に CPU にできる。
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from text_utils import split_into_chunks

_DEFAULT_MODEL_TAG = os.environ.get(
    "JVS_MODEL_TAG", "kan-bayashi/jvs_jvs010_vits_prosody"
)
_CACHE_DIR = Path(os.environ.get("JVS_CACHE_DIR", "./.cache/espnet"))
_MAX_CHUNK_CHARS = int(os.environ.get("JVS_MAX_CHUNK_CHARS", "60"))
_CHUNK_SILENCE_SEC = float(os.environ.get("JVS_CHUNK_SILENCE_SEC", "0.25"))


def _resolve_device() -> str:
    forced = os.environ.get("JVS_DEVICE")
    if forced:
        return forced
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


class JVSTextToSpeech:
    """遅延初期化の TTS ラッパ。"""

    def __init__(self, model_tag: str = _DEFAULT_MODEL_TAG) -> None:
        self.model_tag = model_tag
        self._tts = None
        self._device = _resolve_device()
        self._lock = threading.Lock()

    @property
    def device(self) -> str:
        return self._device

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
                device=self._device,
                **model_files,
            )

    @property
    def sample_rate(self) -> int:
        self._ensure_loaded()
        return int(self._tts.fs)

    def synthesize(self, text: str) -> bytes:
        if not text.strip():
            raise ValueError("text is empty")
        self._ensure_loaded()

        chunks = split_into_chunks(text, _MAX_CHUNK_CHARS) or [text.strip()]
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
