"""Narrator voice: edge-tts (Microsoft's neural voices, free). Cached on disk by content hash.

ElevenLabs is never used for narration; existing ElevenLabs narration recordings are kept and preferred
(render() only fills panels that have no narration audio yet).
"""

import asyncio
import hashlib
from pathlib import Path

import edge_tts

# One calm narrator per language ('original' = English).
NARRATORS = {
    None: "en-US-AndrewNeural",
    "original": "en-US-AndrewNeural",
    "es": "es-ES-AlvaroNeural",
    "fr": "fr-FR-HenriNeural",
    "pt": "pt-BR-AntonioNeural",
    "de": "de-DE-ConradNeural",
    "ja": "ja-JP-KeitaNeural",
    "hi": "hi-IN-MadhurNeural",
    "zh": "zh-CN-YunxiNeural",
}


def narrate(text: str, lang: str | None, out_dir: Path) -> Path:
    voice = NARRATORS.get(lang, NARRATORS[None])
    digest = hashlib.sha1("\x1f".join(["edge", voice, text]).encode()).hexdigest()[:16]
    path = out_dir / f"{digest}.mp3"
    if not path.exists():
        tmp = path.with_suffix(".part")
        asyncio.run(edge_tts.Communicate(text, voice).save(str(tmp)))
        tmp.rename(path)
    return path
