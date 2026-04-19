"""VOICEVOX Engine (HTTP API) を呼び出すラッパ。

VOICEVOX Engine を同一ホストで起動しておき、そこに合成をディスパッチする。
CPU でもリアルタイム以上で合成可能で、長文でもクラッシュしない。

参考: https://voicevox.hiroshiba.jp/ (GPU/CPU 版バイナリ、Docker も可)
"""

from __future__ import annotations

import io
import os

import numpy as np
import requests
import soundfile as sf

from text_utils import split_into_chunks

VOICEVOX_URL = os.environ.get("VOICEVOX_URL", "http://127.0.0.1:50021")
_MAX_CHUNK_CHARS = int(os.environ.get("VOICEVOX_MAX_CHUNK_CHARS", "120"))
_CHUNK_SILENCE_SEC = float(os.environ.get("VOICEVOX_CHUNK_SILENCE_SEC", "0.2"))
_TIMEOUT = float(os.environ.get("VOICEVOX_TIMEOUT", "120"))


class VoicevoxEngine:
    def __init__(self, url: str = VOICEVOX_URL) -> None:
        self.url = url.rstrip("/")

    def health(self) -> bool:
        try:
            r = requests.get(f"{self.url}/version", timeout=3)
            return r.ok
        except requests.RequestException:
            return False

    def list_speakers(self) -> list[dict]:
        r = requests.get(f"{self.url}/speakers", timeout=10)
        r.raise_for_status()
        voices: list[dict] = []
        for s in r.json():
            name = s.get("name", "")
            for style in s.get("styles", []):
                voices.append(
                    {
                        "id": int(style["id"]),
                        "name": f"{name} / {style.get('name', '')}".strip(" /"),
                    }
                )
        return voices

    def _synth_one(self, text: str, speaker: int, speed: float = 1.0) -> tuple[np.ndarray, int]:
        q = requests.post(
            f"{self.url}/audio_query",
            params={"text": text, "speaker": speaker},
            timeout=_TIMEOUT,
        )
        q.raise_for_status()
        query = q.json()
        query["speedScale"] = float(speed)
        syn = requests.post(
            f"{self.url}/synthesis",
            params={"speaker": speaker},
            json=query,
            headers={"Accept": "audio/wav"},
            timeout=_TIMEOUT,
        )
        syn.raise_for_status()
        wav, sr = sf.read(io.BytesIO(syn.content), dtype="float32")
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        return wav.astype(np.float32), int(sr)

    def synthesize(self, text: str, speaker: int = 1, speed: float = 1.0) -> bytes:
        if not text.strip():
            raise ValueError("text is empty")

        chunks = split_into_chunks(text, _MAX_CHUNK_CHARS) or [text.strip()]
        wavs: list[np.ndarray] = []
        sr_ref: int | None = None
        for i, chunk in enumerate(chunks):
            wav, sr = self._synth_one(chunk, speaker, speed)
            if sr_ref is None:
                sr_ref = sr
            wavs.append(wav)
            if i != len(chunks) - 1 and sr_ref is not None:
                wavs.append(np.zeros(int(sr_ref * _CHUNK_SILENCE_SEC), dtype=np.float32))

        sr_out = sr_ref or 24000
        full = np.concatenate(wavs) if wavs else np.zeros(0, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, full, sr_out, format="WAV", subtype="PCM_16")
        return buf.getvalue()


_engine: VoicevoxEngine | None = None


def get_engine() -> VoicevoxEngine:
    global _engine
    if _engine is None:
        _engine = VoicevoxEngine()
    return _engine
