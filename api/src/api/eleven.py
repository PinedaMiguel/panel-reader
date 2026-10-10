"""ElevenLabs text-to-speech and sound effects, cached on disk by content hash."""

import hashlib
import os
from pathlib import Path

import httpx

BASE = "https://api.elevenlabs.io/v1"
TTS_MODEL = "eleven_v3"  # understands audio tags like [whispers], [angry]


def _headers() -> dict[str, str]:
    return {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}


def _cached(out_dir: Path, *key: str) -> Path:
    digest = hashlib.sha1("\x1f".join(key).encode()).hexdigest()[:16]
    return out_dir / f"{digest}.mp3"


def tts(text: str, voice_id: str, out_dir: Path) -> Path:
    path = _cached(out_dir, "tts", TTS_MODEL, voice_id, text)
    if not path.exists():
        r = httpx.post(
            f"{BASE}/text-to-speech/{voice_id}?output_format=mp3_44100_128",
            headers=_headers(),
            json={"text": text, "model_id": TTS_MODEL},
            timeout=120,
        )
        r.raise_for_status()
        path.write_bytes(r.content)
    return path


def sfx(prompt: str, out_dir: Path, seconds: float = 6) -> Path:
    path = _cached(out_dir, "sfx", prompt, str(seconds))
    if not path.exists():
        r = httpx.post(
            f"{BASE}/sound-generation",
            headers=_headers(),
            json={"text": prompt, "duration_seconds": seconds, "prompt_influence": 0.5},
            timeout=120,
        )
        r.raise_for_status()
        path.write_bytes(r.content)
    return path
