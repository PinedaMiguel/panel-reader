"""Fill a comic's script.json with narration, voice casting and audio.

    uv run --env-file ../.env python -m api.narrate ../web/public/vignettes

Gemini only fills what is missing, so hand-written dialogue is kept. Audio is cached by
content hash, so re-running only pays for text that changed.
"""

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import eleven, gemini
from .voices import NARRATOR, NEUTRAL, POOL


def enrich(comic: dict, public: Path, force: bool) -> None:
    for panel in (p for page in comic["pages"] for p in page["panels"]):
        if panel.get("narration") and not force:
            continue
        hints = {k: panel[k] for k in ("scene", "characters", "lines") if panel.get(k)}
        print(f"  gemini: {panel['id']}")
        merge(comic, panel, gemini.analyze_panel(public / panel["image"].lstrip("/"), comic["characters"], hints))


def merge(comic: dict, panel: dict, a: gemini.PanelAnalysis) -> None:
    """Copy Gemini's analysis into the panel, keeping any hand-written dialogue."""
    panel["narration"] = a.narration
    if not panel.get("lines"):
        known = {c["id"] for c in comic["characters"]}
        comic["characters"] += [c.model_dump() for c in a.new_characters if c.id not in known]
        panel["scene"] = a.scene
        panel["characters"] = [
            {"characterId": c.character_id, "emotion": c.emotion, "appearance": c.appearance}
            for c in a.characters
        ]
        panel["lines"] = [{"speaker": l.speaker_id, "text": l.text, "tagged": l.tagged} for l in a.lines]
        panel["emotionLabels"] = a.emotion_labels
    if not panel.get("sfx"):
        panel["sfx"] = [{"prompt": s} for s in a.sfx]


def cast(comic: dict) -> None:
    todo = [c for c in comic["characters"] if not c.get("voiceId")]
    if not todo:
        return
    taken = {c["voiceId"] for c in comic["characters"] if c.get("voiceId")}
    picks = gemini.cast_voices(todo, {k: v for k, v in POOL.items() if k not in taken})
    spare = [v for v in POOL if v not in taken and v not in picks.values()]
    for c in todo:
        voice = picks.get(c["id"])
        if voice not in POOL or voice in taken:
            voice = spare.pop(0) if spare else NEUTRAL
        c["voiceId"] = voice
        taken.add(voice)
        print(f"  cast: {c['id']} -> {POOL.get(voice, voice)}")


def render(comic: dict, comic_dir: Path, url_prefix: str, progress=None,
           narration: bool = True, lines: bool = True, sfx: bool = True) -> None:
    """Record missing clips. progress(done, total, panel_id, kind) is called after each clip
    (kind: narration/line/sfx). Uploads record lines + sfx only; the reader voices narration itself."""
    out = comic_dir / "audio"
    out.mkdir(exist_ok=True)
    voices = {c["id"]: c["voiceId"] for c in comic["characters"]}
    url = lambda p: f"{url_prefix}/audio/{p.name}"  # noqa: E731
    # Skip clips that already exist so adding pages to a comic never re-pays for old audio.

    jobs = []  # (panel id, kind, target dict, key, callable)
    for panel in (p for page in comic["pages"] for p in page["panels"]):
        pid = panel["id"]
        if narration and panel.get("narration") and not panel.get("narrationAudio"):
            jobs.append((pid, "narration", panel, "narrationAudio",
                         lambda t=panel["narration"]: eleven.tts(t, NARRATOR, out)))
        for line in (l for l in panel.get("lines", []) if lines and not l.get("audio")):
            voice = voices.get(line.get("speaker"), NEUTRAL)
            text = line.get("tagged") or line["text"]
            jobs.append((pid, "line", line, "audio", lambda t=text, v=voice: _tts_or_neutral(t, v, out)))
        for fx in (f for f in panel.get("sfx", []) if sfx and not f.get("audio")):
            jobs.append((pid, "sfx", fx, "audio", lambda p=fx["prompt"]: eleven.sfx(p, out)))

    done = 0

    def run(job):
        nonlocal done
        pid, kind, target, key, fn = job
        try:
            target[key] = url(fn())
        except Exception as e:  # keep going; the reader falls back to browser speech
            print(f"  audio failed ({key}): {e}")
        done += 1
        if progress:
            progress(done, len(jobs), pid, kind)

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(run, jobs))
    print(f"  audio: {len(jobs)} clips in {out}")


def _tts_or_neutral(text: str, voice: str, out: Path) -> Path:
    try:
        return eleven.tts(text, voice, out)
    except Exception as e:
        if voice == NEUTRAL:
            raise
        print(f"  voice {voice} failed ({e}); using neutral voice")
        return eleven.tts(text, NEUTRAL, out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("comic_dir", type=Path, help="folder under web/public with script.json")
    ap.add_argument("--public", type=Path, default=Path(__file__).parents[3] / "web" / "public")
    ap.add_argument("--force", action="store_true", help="re-run Gemini even if narration exists")
    ap.add_argument("--no-audio", action="store_true")
    args = ap.parse_args()

    comic_dir = args.comic_dir.resolve()
    script = comic_dir / "script.json"
    comic = json.loads(script.read_text())
    url_prefix = "/" + comic_dir.relative_to(args.public.resolve()).as_posix()

    print("enrich"); enrich(comic, args.public, args.force)
    script.write_text(json.dumps(comic, indent=2, ensure_ascii=False))
    print("cast"); cast(comic)
    script.write_text(json.dumps(comic, indent=2, ensure_ascii=False))
    if not args.no_audio:
        print("render"); render(comic, comic_dir, url_prefix)
        script.write_text(json.dumps(comic, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
