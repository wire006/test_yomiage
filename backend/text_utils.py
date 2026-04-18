"""テキスト分割ユーティリティ。

長文 TTS はモデルや C 拡張 (pyopenjtalk 等) がクラッシュしやすいので、
文末記号で区切り、長すぎる文は読点でさらに分割する。
"""

from __future__ import annotations

import re

_SENT_BOUNDARY = re.compile(r"(?<=[。！？!?\n])")
_SUB_BOUNDARY = re.compile(r"(?<=[、,])")


def split_into_chunks(text: str, max_chars: int = 60) -> list[str]:
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
