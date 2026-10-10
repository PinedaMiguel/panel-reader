"""Upload pipeline: whole pages → panels (Magi) → script (Gemini) → voices + audio (ElevenLabs) → Neon.

Work happens in media/<comic id>/ on local disk; at the end new files go to the Neon bucket and the
script goes to Neon Postgres. File fields in the script hold bucket keys ("<comic id>/panels/1-1.jpg").
"""

import json
import threading
import traceback
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from . import db, edge, eleven, gemini, narrate, panels, storage
from .voices import NEUTRAL, POOL

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
    # Live state while a comic is still being made: the reader starts before the job finishes.
    comic: dict | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    uploaded: set[str] = field(default_factory=set)  # bucket keys that exist (safe to sign)
    ready: list[str] = field(default_factory=list)  # panels whose dialogue + effects are recorded

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

    # Otherwise build (or extend) a comic, streaming: cached pages are copied; for new pages, panel
    # detection and the cast list run together, each panel's script starts as soon as it's cropped, and
    # its audio starts as soon as its script is written. Three lanes run in parallel, in reading order:
    # Gemini (scripts), ElevenLabs (dialogue + sound effects) and edge-tts (narrator). Every file is
    # uploaded the moment it exists, so the reader can start once the first panels are voiced.
    comic = target or {"id": job.id, "title": title, "characters": [], "pages": []}
    cid = comic["id"]
    root = comic_dir(cid)
    (root / "panels").mkdir(parents=True, exist_ok=True)
    (root / "audio").mkdir(parents=True, exist_ok=True)
    lock = job.lock
    job.comic = comic
    job.uploaded |= keys(comic)  # an existing comic's files are already in the bucket
    job.emit("start", cached=sum(1 for h in hits.values() if h), pages=len(uploads))

    gem = ThreadPoolExecutor(max_workers=4, thread_name_prefix="gemini")
    voice = ThreadPoolExecutor(max_workers=3, thread_name_prefix="elevenlabs")
    narr = ThreadPoolExecutor(max_workers=4, thread_name_prefix="edge")
    io = ThreadPoolExecutor(max_workers=4, thread_name_prefix="upload")
    tasks: list = []
    order: list[str] = []  # every new panel, reading order
    outstanding: dict[str, int] = {}  # panel -> dialogue/effect clips still recording
    state = {"detected": False, "playable": False, "first": None}

    def upload(key: str) -> None:
        storage.upload(MEDIA / key, key)
        with lock:
            job.uploaded.add(key)

    def mark_ready(pid: str) -> None:  # call with lock held
        if pid not in job.ready:
            job.ready.append(pid)
            job.emit("panel_ready", panel=pid)
        maybe_playable()

    def maybe_playable() -> None:  # call with lock held
        # Play once every panel is detected and the first two (in reading order) are voiced.
        if state["playable"] or not state["detected"]:
            return
        if all(p in job.ready for p in order[:2]):
            state["playable"] = True
            job.emit("playable", comic=cid, start=state["first"])

    def record(pid: str, kind: str, target: dict, field_: str, make) -> None:
        try:
            path = make()
            key = f"{cid}/audio/{path.name}"
            upload(key)
            with lock:
                target[field_] = key
        except Exception as e:  # keep going: a missing clip is skipped by the reader
            print(f"[{job.id}] {kind} clip for {pid} failed: {e}")
        with lock:
            job.emit("clip", panel=pid, kind=kind)
            if kind != "narration":
                outstanding[pid] -= 1
                if outstanding[pid] == 0:
                    job.emit("lane", lane="voices", panel=pid, state="done")
                    mark_ready(pid)
            else:
                job.emit("lane", lane="narrator", panel=pid, state="done")

    def queue_audio(panel: dict) -> None:
        """Send a scripted panel's missing clips to their lanes (call with lock held)."""
        pid = panel["id"]
        voices = {c["id"]: c.get("voiceId") or NEUTRAL for c in comic["characters"]}
        lines = [l for l in panel.get("lines", []) if not l.get("audio")] if audio else []
        effects = [f for f in panel.get("sfx", []) if not f.get("audio")] if audio else []
        outstanding[pid] = len(lines) + len(effects)
        if outstanding[pid]:
            job.emit("lane", lane="voices", panel=pid, state="start")
        else:
            job.emit("lane", lane="voices", panel=pid, state="done")
            mark_ready(pid)
        for line in lines:
            v, text = voices.get(line.get("speaker"), NEUTRAL), line.get("tagged") or line["text"]
            tasks.append(voice.submit(record, pid, "line", line, "audio",
                                      lambda t=text, v=v: narrate._tts_or_neutral(t, v, root / "audio")))
        for fx in effects:
            tasks.append(voice.submit(record, pid, "sfx", fx, "audio",
                                      lambda p=fx["prompt"]: eleven.sfx(p, root / "audio")))
        if audio and panel.get("narration") and not panel.get("narrationAudio"):
            job.emit("lane", lane="narrator", panel=pid, state="start")
            tasks.append(narr.submit(record, pid, "narration", panel, "narrationAudio",
                                     lambda t=panel["narration"]: edge.narrate(t, comic.get("lang"), root / "audio")))
        else:
            job.emit("lane", lane="narrator", panel=pid, state="done")

    def script(panel: dict, path: Path) -> None:
        with lock:
            job.emit("lane", lane="script", panel=panel["id"], state="start")
            known = list(comic["characters"])
        try:
            analysis = gemini.analyze_panel(path, known, {})
        except Exception as e:  # one bad panel shouldn't sink the page; it stays image-only
            print(f"[{job.id}] panel {panel['id']} failed: {e}")
            analysis = None
        with lock:
            if analysis:
                narrate.merge(comic, panel, analysis)
                spare_voices(comic)  # characters first met in this panel get a free voice, no extra call
            job.emit("script", **_script(panel, comic))
            job.emit("lane", lane="script", panel=panel["id"], state="done")
            queue_audio(panel)

    try:
        for i, u in enumerate(uploads):
            pi = len(comic["pages"]) + 1
            hit = hits[u.sha]
            if hit:
                with lock:
                    page_entry = copy_page(source(hit[0]), source(hit[0])["pages"][hit[1] - 1], comic, pi, u.sha)
                    job.uploaded |= _page_keys(page_entry)
                _emit_page(job, i, page_entry, comic, cached=True)
                state["first"] = state["first"] or page_entry["panels"][0]["id"]
                with lock:
                    order.extend(p["id"] for p in page_entry["panels"])
                    spare_voices(comic)
                    for p in page_entry["panels"]:
                        queue_audio(p)
                continue

            # Cast list (Gemini) and panel detection (Magi) at the same time.
            job.update("detecting panels", i, len(uploads))
            job.emit("page", page=page_entry_id(pi), upload=i, cached=False)
            with lock:
                known = list(comic["characters"])
            cast_future = gem.submit(gemini.page_cast, u.path, known)
            tasks.append(io.submit(upload, f"{cid}/{u.path.name}"))
            page = Image.open(u.path).convert("RGB")
            found = panels.detect(page, rtl=rtl) or [{"bbox": [0, 0, page.width, page.height], "characters": []}]
            page_entry = {"id": page_entry_id(pi), "image": f"{cid}/{u.path.name}", "hash": u.sha, "panels": []}
            crops = []
            for n, p in enumerate(found, 1):
                out = root / "panels" / f"{pi}-{n}.jpg"
                panels.crop(page, p["bbox"]).save(out, quality=90)
                tasks.append(io.submit(upload, f"{cid}/panels/{out.name}"))
                page_entry["panels"].append({
                    "id": f"p{pi}-{n}", "image": f"{cid}/panels/{out.name}", "order": n, "bbox": p["bbox"],
                    "scene": "", "characters": [], "lines": [], "emotionLabels": [],
                })
                crops.append(out)
            with lock:
                comic["pages"].append(page_entry)
                order.extend(p["id"] for p in page_entry["panels"])
                state["first"] = state["first"] or page_entry["panels"][0]["id"]
            job.emit("panels", page=page_entry["id"], panels=[{"id": p["id"], "bbox": p["bbox"]} for p in page_entry["panels"]])

            # Characters first (consistent ids across panels), then voices, then every panel's script.
            job.update("finding characters", i, len(uploads))
            new_chars = [c.model_dump() for c in cast_future.result()]
            with lock:
                known_ids = {c["id"] for c in comic["characters"]}
                comic["characters"] += [c for c in new_chars if c["id"] not in known_ids]
            job.emit("cast", page=page_entry["id"], characters=[_char(c) for c in new_chars])
            narrate.cast(comic)  # one Gemini call per page; later newcomers get spare voices
            job.emit("voices", characters=_voice_list(comic))
            for panel, path in zip(page_entry["panels"], crops):
                tasks.append(gem.submit(script, panel, path))

        with lock:
            state["detected"] = True
            maybe_playable()
        job.update("writing script and recording audio")
        # Wait for every lane (tasks may add more tasks, so drain until stable).
        while True:
            pending = [t for t in tasks if not t.done()]
            if not pending:
                break
            for t in pending:
                t.result()
        _save_local(root, comic)
        db.save_comic(comic)
        with lock:
            state["detected"] = True
            if not state["playable"]:
                state["playable"] = True
                job.emit("playable", comic=cid, start=state["first"])
        job.emit("done", comic=cid, start=state["first"])
    finally:
        for pool in (gem, voice, narr, io):
            pool.shutdown(wait=False, cancel_futures=True)


def spare_voices(comic: dict) -> None:
    """Give characters without a voice a free one from the pool, in order (no model call)."""
    taken = {c.get("voiceId") for c in comic["characters"]}
    spare = [v for v in POOL if v not in taken]
    for c in comic["characters"]:
        if not c.get("voiceId"):
            c["voiceId"] = spare.pop(0) if spare else NEUTRAL


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
        for lane in ("script", "voices", "narrator"):
            job.emit("lane", lane=lane, panel=p["id"], state="done")
        job.emit("panel_ready", panel=p["id"])


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
