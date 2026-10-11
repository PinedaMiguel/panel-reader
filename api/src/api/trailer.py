"""Trailers: Gemini cuts a comic like a film trailer (its most exciting panels in a dramatic order, with
narration, character lines, title cards and impact hits); ElevenLabs voices the narration and scores it with
a music bed. Made once per comic, where the model keys are, and stored in Neon; a reading-only server just
plays them.

    uv run --env-file ../.env python -m api.trailer            # every comic without a trailer
    uv run --env-file ../.env python -m api.trailer <id> ...   # (re)make these
"""

import sys

from . import db, eleven, gemini, pipeline, storage

VOICE = "nPczCjzI2devNBz1zQrb"  # Brian: deep, resonant; the classic trailer voice
MUSIC_S = 22  # longest sound generation ElevenLabs makes
FINAL_MS = 2800  # the closing title card
LINE_MAX_MS = 6000  # longer character lines are skipped


def _ms(nbytes: int) -> int:
    return nbytes // 16  # ElevenLabs mp3 is constant 128 kbps: 16 bytes per millisecond


def build(cid: str) -> dict:
    comic = db.load_comic(cid, sign=False)
    preview = db.get_preview(cid) or {}
    cut = gemini.trailer(comic, (preview.get("genres") or []) + (preview.get("moods") or []))
    panels = {p["id"]: p for page in comic["pages"] for p in page["panels"]}
    names = {c["id"]: c.get("name") or c["id"].replace("_", " ").title() for c in comic["characters"]}
    out = pipeline.comic_dir(cid) / "trailer"
    out.mkdir(parents=True, exist_ok=True)
    s3 = storage.client()

    def put(path) -> str:
        key = f"{cid}/trailer/{path.name}"
        storage.upload(path, key)
        return key

    shots = []
    for s in cut.shots:
        panel = panels.get(s.panel_id)
        if not panel:
            continue  # the model named a panel that doesn't exist
        shot = {"panel": s.panel_id, "card": s.card, "voice": None, "voiceText": None, "line": None, "hit": None}
        talk = 0
        if s.voiceover:
            clip = eleven.tts(s.voiceover, VOICE, out)
            shot["voice"], shot["voiceText"] = put(clip), s.voiceover.split("]", 1)[-1].strip() if s.voiceover.startswith("[") else s.voiceover
            talk = _ms(clip.stat().st_size)
        elif s.line and s.line.line_index < len(panel["lines"]) and panel["lines"][s.line.line_index].get("audio"):
            line = panel["lines"][s.line.line_index]
            size = s3.head_object(Bucket=storage.BUCKET, Key=line["audio"])["ContentLength"]
            if _ms(size) <= LINE_MAX_MS:  # a trailer moment, not a monologue
                shot["line"] = {"text": line["text"], "speaker": names.get(line.get("speaker")), "audio": line["audio"]}
                talk = _ms(size)
        if s.hit and panel.get("sfx") and panel["sfx"][0].get("audio"):
            shot["hit"] = panel["sfx"][0]["audio"]
        shot["ms"] = max(2000 if not s.card else 2400, talk + 450)
        shots.append(shot)
    if len(shots) < 3:
        raise RuntimeError(f"{cid}: the cut had too few usable shots")

    music = eleven.sfx(cut.music, out, seconds=MUSIC_S)
    trailer = {
        "shots": shots,
        "tagline": cut.tagline,
        "music": put(music),
        "finalMs": FINAL_MS,
        "totalMs": sum(s["ms"] for s in shots) + FINAL_MS,
    }
    db.save_trailer(cid, trailer)
    return trailer


if __name__ == "__main__":
    db.migrate()  # adds the trailer column on first use
    ids = sys.argv[1:] or [c["id"] for c in db.list_comics() if not db.get_trailer(c["id"])]
    for cid in ids:
        t = build(cid)
        print(cid, f"{len(t['shots'])} shots, {t['totalMs'] / 1000:.1f}s:", " | ".join(s.get("voiceText") or (s["line"] or {}).get("text") or s.get("card") or "·" for s in t["shots"]), "—", t["tagline"])
