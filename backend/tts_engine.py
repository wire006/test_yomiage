"""JVS コーパスで学習された ESPnet-TTS モデルで音声合成する。

ESPnet モデルズーには JVS コーパスで学習された日本語多話者 TTS モデル
(kan-bayashi/jvs_jvs010_vits_prosody など) が公開されているため、
それを利用する。初回呼び出し時にモデルをダウンロード・キャッシュする。
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

_DEFAULT_MODEL_TAG = os.environ.get(
    "JVS_MODEL_TAG", "kan-bayashi/jvs_jvs010_vits_prosody"
)
_CACHE_DIR = Path(os.environ.get("JVS_CACHE_DIR", "./.cache/espnet"))


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
        result = self._tts(text)
        wav = result["wav"].view(-1).cpu().numpy().astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, wav, self.sample_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()


_engine: JVSTextToSpeech | None = None


def get_engine() -> JVSTextToSpeech:
    global _engine
    if _engine is None:
        _engine = JVSTextToSpeech()
    return _engine
