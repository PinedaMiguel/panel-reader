"""Upload pipeline: whole pages → panels (Magi) → script (Gemini) → voices + audio (ElevenLabs) → Neon.

Work happens in media/<comic id>/ on local disk; at the end new files go to the Neon bucket and the
script goes to Neon Postgres. File fields in the script hold bucket keys ("<comic id>/panels/1-1.jpg").
"""

import json
import traceback
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from . import db, gemini, narrate, panels, storage
from .voices import POOL

MEDIA = Path(__file__).parents[3] / "media"


@dataclass
class Job:
    id: str
    stage: str = "queued"
    done: int = 0
    total: int = 0
    error: str | None = None
    log: list[str] = field(default_factory=list)
    # Structured events for the processing visualization, in order (see emit()).
    events: list[dict] = field(default_factory=list)

    def update(self, stage: str, done: int = 0, total: int = 0) -> None:
        self.stage, self.done, self.total = stage, done, total
        self.log.append(f"{stage} {done}/{total}" if total else stage)
        print(f"[{self.id}] {self.log[-1]}")

    def emit(self, type: str, **data) -> None:
        self.events.append({"type": type, **data})


@dataclass
class Upload:
    path: Path
    sha: str  # SHA-256 of the file: identical pages are never processed twice


def comic_dir(comic_id: str) -> Path:
    return MEDIA / comic_id


def run(job: Job, uploads: list[Upload], title: str, rtl: bool, audio: bool, target: dict | None = None) -> None:
    try:
        _run(job, uploads, title, rtl, audio, target)
        job.update("done")
    except Exception as e:
        traceback.print_exc()
        job.error = str(e)
        job.emit("error", message=str(e))
        job.update("error")


def _run(job: Job, uploads: list[Upload], title: str, rtl: bool, audio: bool, target: dict | None) -> None:
    hits = {u.sha: db.find_page(u.sha) for u in uploads}
    sources: dict[str, dict] = {}

    def source(cid: str) -> dict:
        if cid not in sources:
            sources[cid] = db.load_comic(cid, sign=False)
        return sources[cid]

    # Every page seen before, all from one comic: replay its stored results and open it. No API calls.
    if not target and all(hits.values()) and len({h[0] for h in hits.values()}) == 1:
        cid = next(iter(hits.values()))[0]
        src = source(cid)
        _replay(job, src, [src["pages"][hits[u.sha][1] - 1] for u in uploads], uploaded=True)
        return

    # Otherwise build (or extend) a comic: cached pages are copied, new pages go through the models.
    comic = target or {"id": job.id, "title": title, "characters": [], "pages": []}
    cid = comic["id"]
    root = comic_dir(cid)
    (root / "panels").mkdir(parents=True, exist_ok=True)
    before = keys(comic)
    reused: set[str] = set()  # bucket keys owned by other comics; never re-uploaded
    job.emit("start", cached=sum(1 for h in hits.values() if h), pages=len(uploads))

    work: list[tuple[dict, Path]] = []
    first_panel = None
    for i, u in enumerate(uploads):
        pi = len(comic["pages"]) + 1
        hit = hits[u.sha]
        if hit:
            page_entry = copy_page(source(hit[0]), source(hit[0])["pages"][hit[1] - 1], comic, pi, u.sha)
            reused |= _page_keys(page_entry)
            _emit_page(job, i, page_entry, comic, cached=True)
        else:
            # 1. Panel detection (Hugging Face Magi v2) and cropping.
            job.update("detecting panels", i, len(uploads))
            job.emit("page", page=page_entry_id(pi), upload=i, cached=False)
            page = Image.open(u.path).convert("RGB")
            found = panels.detect(page, rtl=rtl) or [{"bbox": [0, 0, page.width, page.height], "characters": []}]
            page_entry = {"id": page_entry_id(pi), "image": f"{cid}/{u.path.name}", "hash": u.sha, "panels": []}
            for n, p in enumerate(found, 1):
                out = root / "panels" / f"{pi}-{n}.jpg"
                panels.crop(page, p["bbox"]).save(out, quality=90)
                panel = {
                    "id": f"p{pi}-{n}", "image": f"{cid}/panels/{out.name}", "order": n, "bbox": p["bbox"],
                    "scene": "", "characters": [], "lines": [], "emotionLabels": [],
                }
                page_entry["panels"].append(panel)
                work.append((panel, out))
            comic["pages"].append(page_entry)
            job.emit("panels", page=page_entry["id"], panels=[{"id": p["id"], "bbox": p["bbox"]} for p in page_entry["panels"]])

            # 2a. One whole-page call so every panel shares the same character ids.
            job.update("finding characters", i, len(uploads))
            new_chars = [c.model_dump() for c in gemini.page_cast(u.path, comic["characters"])]
            comic["characters"] += new_chars
            job.emit("cast", page=page_entry["id"], characters=[_char(c) for c in new_chars])
        first_panel = first_panel or page_entry["panels"][0]["id"]
    _save_local(root, comic)

    # 2b. Per-panel script for the new pages, in parallel.
    job.update("writing script", 0, len(work))
    done = 0

    def analyze(item):
        panel, path = item
        try:
            return panel, gemini.analyze_panel(path, comic["characters"], {})
        except Exception as e:  # one bad panel shouldn't sink the page; it stays image-only
            print(f"[{job.id}] panel {panel['id']} failed: {e}")
            return panel, None

    with ThreadPoolExecutor(max_workers=6) as pool:
        for panel, analysis in pool.map(analyze, work):
            if analysis:
                narrate.merge(comic, panel, analysis)
            done += 1
            job.update("writing script", done, len(work))
            job.emit("script", **_script(panel, comic))
    _save_local(root, comic)

    # 3. Voices and audio (ElevenLabs). Only characters without a voice get cast; only missing clips render.
    job.update("casting voices")
    narrate.cast(comic)
    job.emit("voices", characters=_voice_list(comic))
    pending = _pending_panels(comic) if audio else set()
    job.emit("audio", total=len(pending), cached=[
        p["id"] for page in comic["pages"] for p in page["panels"] if p["id"] not in pending
    ])
    if audio:
        job.update("recording audio")

        def progress(d, t, pid, kind):
            job.update("recording audio", d, t)
            job.emit("clip", panel=pid, kind=kind, done=d, total=t)

        # Dialogue + sound effects with ElevenLabs; the narrator with edge-tts.
        narrate.render(comic, root, cid, progress=progress)
    _save_local(root, comic)

    # 4. Publish: new files → Neon bucket, script → Neon Postgres.
    new = sorted(keys(comic) - before - reused)
    for n, key in enumerate(new, 1):
        job.update("saving to Neon", n, len(new))
        storage.upload(MEDIA / key, key)
    db.save_comic(comic)
    job.emit("done", comic=cid, start=first_panel)


def replay(job: Job, cid: str) -> None:
    """Play a stored comic's processing as events (the "see how it was made" button). No API calls."""
    try:
        src = db.load_comic(cid, sign=False)
        _replay(job, src, src["pages"], uploaded=False)
        job.update("done")
    except Exception as e:
        traceback.print_exc()
        job.error = str(e)
        job.emit("error", message=str(e))
        job.update("error")


def _replay(job: Job, comic: dict, pages: list[dict], uploaded: bool) -> None:
    job.emit("start", cached=len(pages), pages=len(pages))
    for i, page in enumerate(pages):
        # Uploads already have the page in the browser; a replay needs a link to it.
        _emit_page(job, i if uploaded else None, page, comic, cached=True)
    job.emit("voices", characters=_voice_list(comic))
    job.emit("audio", total=0, cached=[p["id"] for page in pages for p in page["panels"]])
    job.emit("done", comic=comic["id"], start=pages[0]["panels"][0]["id"])


def page_entry_id(pi: int) -> str:
    return f"page{pi}"


def copy_page(src: dict, spage: dict, dst: dict, pi: int, sha: str) -> dict:
    """Copy an already-processed page into dst. Characters are matched to dst's cast by id or name so
    voices stay consistent; only lines whose speaker now has a different voice lose their audio."""
    by_id = {c["id"]: c for c in dst["characters"]}
    by_name = {c["name"].lower(): c for c in dst["characters"] if c.get("name")}
    taken = {c.get("voiceId") for c in dst["characters"]}
    src_chars = {c["id"]: c for c in src["characters"]}
    used = {l.get("speaker") for p in spage["panels"] for l in p["lines"]}
    used |= {c["characterId"] for p in spage["panels"] for c in p.get("characters", [])}
    remap, revoice = {}, set()
    for sid in filter(None, used):
        sc = src_chars.get(sid)
        if not sc:
            continue
        d = by_id.get(sid) or by_name.get((sc.get("name") or "").lower())
        if d is None:
            d = deepcopy(sc)
            if d.get("voiceId") in taken:
                d["voiceId"] = None  # cast() picks a free one
            dst["characters"].append(d)
            by_id[d["id"]] = d
            taken.add(d.get("voiceId"))
        remap[sid] = d["id"]
        if d.get("voiceId") != sc.get("voiceId"):
            revoice.add(sid)

    page = deepcopy(spage)
    page.update(id=page_entry_id(pi), hash=sha)
    for n, p in enumerate(page["panels"], 1):
        p["id"] = f"p{pi}-{n}"
        for c in p.get("characters", []):
            c["characterId"] = remap.get(c["characterId"], c["characterId"])
        for line in p["lines"]:
            if line.get("speaker") in revoice:
                line["audio"] = None
            line["speaker"] = remap.get(line.get("speaker"), line.get("speaker"))
    dst["pages"].append(page)
    return page


# --- events -----------------------------------------------------------------------------------


def _char(c: dict) -> dict:
    return {"id": c["id"], "name": c.get("name") or c["id"].replace("_", " ").title(), "description": c.get("description", "")}


def _voice_list(comic: dict) -> list[dict]:
    return [{**_char(c), "voice": POOL.get(c.get("voiceId"), "Neutral").split(":")[0]} for c in comic["characters"]]


def _script(panel: dict, comic: dict) -> dict:
    names = {c["id"]: _char(c)["name"] for c in comic["characters"]}
    return {
        "panel": panel["id"],
        "narration": panel.get("narration") or "",
        "lines": [{"speaker": names.get(l.get("speaker"), "Unknown"), "text": l["text"]} for l in panel.get("lines", [])],
        "emotions": panel.get("emotionLabels", []),
        "sfx": [s["prompt"] for s in panel.get("sfx", [])],
    }


def _emit_page(job: Job, upload_index: int | None, page: dict, comic: dict, cached: bool) -> None:
    """Replay a finished page as the same events a live run produces."""
    job.emit("page", page=page["id"], upload=upload_index, cached=cached, image=storage.presign(page["image"]))
    job.emit("panels", page=page["id"], panels=[{"id": p["id"], "bbox": p["bbox"]} for p in page["panels"]])
    ids = {l.get("speaker") for p in page["panels"] for l in p["lines"]}
    ids |= {c["characterId"] for p in page["panels"] for c in p.get("characters", [])}
    job.emit("cast", page=page["id"], characters=[_char(c) for c in comic["characters"] if c["id"] in ids])
    for p in page["panels"]:
        job.emit("script", **_script(p, comic))


def _pending_panels(comic: dict, narration: bool = True) -> set[str]:
    out = set()
    for page in comic["pages"]:
        for p in page["panels"]:
            if (narration and p.get("narration") and not p.get("narrationAudio")) \
                    or any(not l.get("audio") for l in p["lines"]) or any(not s.get("audio") for s in p.get("sfx", [])):
                out.add(p["id"])
    return out


def _page_keys(page: dict) -> set[str]:
    return keys({"pages": [page]})


def keys(comic: dict) -> set[str]:
    """Every bucket key the script references."""
    out = set()
    for page in comic["pages"]:
        out.add(page["image"])
        for p in page["panels"]:
            out.add(p["image"])
            out.update(k for k in [p.get("narrationAudio")] if k)
            out.update(l["audio"] for l in p.get("lines", []) if l.get("audio"))
            out.update(s["audio"] for s in p.get("sfx", []) if s.get("audio"))
    return out


def _save_local(root: Path, comic: dict) -> None:
    (root / "script.json").write_text(json.dumps(comic, indent=2, ensure_ascii=False))


def translate(job: Job, cid: str, lang: str, language: str, audio: bool = True) -> None:
    try:
        _translate(job, cid, lang, language, audio)
        job.update("done")
    except Exception as e:
        traceback.print_exc()
        job.error = str(e)
        job.update("error")


def _translate(job: Job, cid: str, lang: str, language: str, audio: bool) -> None:
    """Translate a comic's script (Gemini) and re-voice it with the same characters (ElevenLabs)."""
    comic = db.load_comic(cid, sign=False)
    root = comic_dir(cid)
    root.mkdir(parents=True, exist_ok=True)
    before = keys(comic)

    for i, page in enumerate(comic["pages"]):
        job.update("translating", i, len(comic["pages"]))
        by_id = {t.id: t for t in gemini.translate_page(page["panels"], language)}
        for p in page["panels"]:
            t = by_id.get(p["id"])
            if not t or len(t.lines) != len(p["lines"]):
                print(f"[{job.id}] {p['id']}: translation shape mismatch, keeping original")
                continue
            p.update(scene=t.scene, narration=t.narration, emotionLabels=t.emotion_labels, narrationAudio=None)
            for line, tl in zip(p["lines"], t.lines):
                line.update(text=tl.text, tagged=tl.tagged, audio=None)
    # Sound effects keep their audio: they're the same in every language.

    if audio:
        job.update("recording audio")
        narrate.render(comic, root, cid, progress=lambda d, t, *_: job.update("recording audio", d, t), lang=lang)

    new = sorted(keys(comic) - before)
    for n, key in enumerate(new, 1):
        job.update("saving to Neon", n, len(new))
        storage.upload(MEDIA / key, key)
    db.save_translation(cid, lang, [p for page in comic["pages"] for p in page["panels"]])
