"""HTTP API. Run: uv run --env-file ../.env uvicorn api.main:app --port 8000"""

import asyncio
import copy
import hashlib
import json
import os
import secrets
import shutil
import re
import threading
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, gemini, pipeline, storage

app = FastAPI(title="Panel Reader API")
pipeline.MEDIA.mkdir(exist_ok=True)
jobs: dict[str, pipeline.Job] = {}

ALLOWED = {".jpg", ".jpeg", ".png", ".webp"}
LANGUAGES = {
    "es": "Spanish", "fr": "French", "pt": "Brazilian Portuguese", "de": "German",
    "ja": "Japanese", "hi": "Hindi", "zh": "Mandarin Chinese",
}
COMIC_ID = re.compile(r"[0-9a-f]{10}")
# A reading-only server can run on the database alone (no model keys): it serves what is already stored
# (scripts, audio, previews, translations) and offers nothing that would need a model call.
CAN_GENERATE = bool(os.environ.get("GEMINI_API_KEY") and os.environ.get("ELEVENLABS_API_KEY"))


def admin(x_admin_token: str = Header("")) -> None:
    """Adding comics runs paid models, and only the team curates the library: require ADMIN_TOKEN.
    With no token configured, uploads are refused (fail closed)."""
    expected = os.environ.get("ADMIN_TOKEN", "")
    if not expected or not secrets.compare_digest(x_admin_token.encode(), expected.encode()):
        raise HTTPException(401, "admin token required")


@app.on_event("startup")
def startup() -> None:
    db.migrate()
    # Loading Magi takes a while; do it in the background so the first upload is faster. A reading-only
    # server (MAGI=off, or Magi not installed) skips it and never needs the model.
    try:
        threading.Thread(target=pipeline.magi().model, daemon=True).start()
    except RuntimeError as e:
        print(f"Magi not loaded: {e}")


async def _save_pages(folder: str, pages: list[UploadFile], first_idx: int) -> list[pipeline.Upload]:
    root = pipeline.comic_dir(folder)
    root.mkdir(parents=True, exist_ok=True)
    out = []
    for i, f in enumerate(pages, first_idx):
        ext = Path(f.filename or "").suffix.lower()
        if ext not in ALLOWED:
            raise HTTPException(400, f"unsupported file type: {f.filename}")
        data = await f.read()
        path = root / f"page{i}{'.jpg' if ext == '.jpeg' else ext}"
        path.write_bytes(data)
        out.append(pipeline.Upload(path, hashlib.sha256(data).hexdigest()))
    return out


def _start(job_id: str, target_fn) -> dict:
    job = jobs[job_id] = pipeline.Job(job_id)
    threading.Thread(target=target_fn, args=(job,), daemon=True).start()
    return {"id": job_id, "job": job_id}


@app.post("/api/comics", dependencies=[Depends(admin)])
async def create_comic(
    pages: list[UploadFile] = File(...),
    title: str = Form("Untitled comic"),
    rtl: bool = Form(False),
    audio: bool = Form(True),
):
    job_id = uuid.uuid4().hex[:10]  # also the new comic's id, unless every page is already known
    uploads = await _save_pages(job_id, pages, 1)

    def work(job):
        pipeline.run(job, uploads, title, rtl, audio, None)
        done = next((e for e in job.events if e["type"] == "done"), None)
        if done and done["comic"] != job_id:  # pure replay of an existing comic: drop the unused upload
            shutil.rmtree(pipeline.comic_dir(job_id), ignore_errors=True)

    return _start(job_id, work)


@app.post("/api/comics/{comic_id}/pages", dependencies=[Depends(admin)])
async def add_pages(
    comic_id: str,
    pages: list[UploadFile] = File(...),
    rtl: bool = Form(False),
    audio: bool = Form(True),
):
    """Continue a comic: new pages reuse its characters and voices from Neon."""
    existing = db.load_comic(comic_id, sign=False) if COMIC_ID.fullmatch(comic_id) else None
    if not existing:
        raise HTTPException(404)
    uploads = await _save_pages(comic_id, pages, len(existing["pages"]) + 1)
    db.query("update comics set preview = null where id = $1", comic_id)  # new pages: rewrite the synopsis
    return _start(uuid.uuid4().hex[:10], lambda job: pipeline.run(job, uploads, existing["title"], rtl, audio, existing))


@app.post("/api/comics/{comic_id}/replay")
def replay(comic_id: str):
    """Show how a stored comic was processed, from saved results. Free: no model calls."""
    if not COMIC_ID.fullmatch(comic_id) or not db.query("select 1 from comics where id = $1", comic_id):
        raise HTTPException(404)
    return _start(uuid.uuid4().hex[:10], lambda job: pipeline.replay(job, comic_id))


@app.get("/api/jobs/{job_id}/comic")
def job_comic(job_id: str):
    """The comic as it is right now, while it's still being made: the reader starts playing before the
    job finishes and refreshes this to fill in scripts and audio. Only files already uploaded are signed."""
    job = jobs.get(job_id)
    if not job or job.comic is None:
        raise HTTPException(404)
    with job.lock:
        comic = copy.deepcopy(job.comic)
        uploaded, ready = set(job.uploaded), list(job.ready)
    sign = lambda k: storage.presign(k) if k and k in uploaded else None  # noqa: E731
    for page in comic["pages"]:
        page["image"] = sign(page["image"])
        for p in page["panels"]:
            p["image"] = sign(p["image"])
            p["narrationAudio"] = sign(p.get("narrationAudio"))
            for line in p.get("lines", []):
                line["audio"] = sign(line.get("audio"))
            for fx in p.get("sfx", []):
                fx["audio"] = sign(fx.get("audio"))
    total = sum(len(pg["panels"]) for pg in comic["pages"])
    return {"comic": comic, "ready": ready, "total": total, "done": job.stage in ("done", "error")}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    """The processing visualization's event stream: one SSE message per pipeline event."""
    if job_id not in jobs:
        raise HTTPException(404)
    job = jobs[job_id]

    async def stream():
        sent = 0
        while True:
            while sent < len(job.events):
                yield f"data: {json.dumps(job.events[sent])}\n\n"
                sent += 1
            if job.stage in ("done", "error") and sent == len(job.events):
                return
            await asyncio.sleep(0.25)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/comics/{comic_id}/translations")
def create_translation(comic_id: str, lang: str = Form(...), audio: bool = Form(True)):
    if not CAN_GENERATE:
        raise HTTPException(503, "translations can't be made on this server")
    if lang not in LANGUAGES or not COMIC_ID.fullmatch(comic_id) or not db.query(
        "select 1 from comics where id = $1", comic_id
    ):
        raise HTTPException(404)
    key = f"{comic_id}:{lang}"
    if key in jobs and jobs[key].stage not in ("done", "error"):
        return {"id": comic_id, "lang": lang}
    job = jobs[key] = pipeline.Job(key)
    threading.Thread(
        target=pipeline.translate, args=(job, comic_id, lang, LANGUAGES[lang], audio), daemon=True
    ).start()
    return {"id": comic_id, "lang": lang}


@app.get("/api/languages")
def languages(comic: str | None = None):
    """Languages a comic can be read in. Without model keys, only the translations it already has."""
    if CAN_GENERATE:
        return LANGUAGES
    have = db.languages(comic) if comic and COMIC_ID.fullmatch(comic) else []
    return {code: name for code, name in LANGUAGES.items() if code in have}


@app.get("/api/comics/{comic_id}/events")
async def events(comic_id: str, lang: str | None = None):
    key = f"{comic_id}:{lang}" if lang else comic_id
    if key not in jobs:
        raise HTTPException(404)
    job = jobs[key]

    async def stream():
        last = None
        while True:
            state = {"stage": job.stage, "done": job.done, "total": job.total, "error": job.error}
            if state != last:
                yield f"data: {json.dumps(state)}\n\n"
                last = state
            if job.stage in ("done", "error"):
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/comics/{comic_id}/preview")
def comic_preview(comic_id: str):
    """Title page for "what to watch next": synopsis, tags, cast, length and a teaser. The text is written
    once by Gemini from the comic's script and kept in Neon; media links are signed fresh each time."""
    comic = db.load_comic(comic_id) if COMIC_ID.fullmatch(comic_id) else None
    if not comic:
        raise HTTPException(404)
    pv = db.get_preview(comic_id)
    if not pv:
        if not CAN_GENERATE:
            raise HTTPException(503, "preview not made yet")
        pv = gemini.preview(comic).model_dump()
        db.save_preview(comic_id, pv)
    panels_by_id = {p["id"]: p for page in comic["pages"] for p in page["panels"]}
    chars = {c["id"]: c for c in comic["characters"]}
    words = sum(len((p.get("narration") or "").split()) + sum(len(l["text"].split()) for l in p["lines"]) for p in panels_by_id.values())
    teaser = [panels_by_id[i] for i in pv["teaser_panels"] if i in panels_by_id] or list(panels_by_id.values())[:3]
    line = None
    tl = pv.get("teaser_line")
    if tl and tl["panel_id"] in panels_by_id and tl["line_index"] < len(panels_by_id[tl["panel_id"]]["lines"]):
        l = panels_by_id[tl["panel_id"]]["lines"][tl["line_index"]]
        line = {"text": l["text"], "audio": l.get("audio"), "speaker": chars.get(l.get("speaker"), {}).get("name")}
    return {
        "id": comic_id,
        "title": comic["title"],
        "synopsis": pv["synopsis"],
        "genres": pv["genres"],
        "moods": pv["moods"],
        "characters": [
            {"name": chars[i].get("name") or i.replace("_", " ").title(), "description": chars[i].get("description", "")}
            for i in pv["main_characters"] if i in chars
        ],
        "pages": len(comic["pages"]),
        "panels": len(panels_by_id),
        "minutes": max(1, round(words / 150 + len(panels_by_id) * 3 / 60)),  # ~150 wpm + page turns
        "teaser": [{"image": p["image"]} for p in teaser],
        "teaserLine": line,
        "cover": comic["pages"][0]["panels"][0]["image"] if comic["pages"] else None,
        "trailer": _signed_trailer(db.get_trailer(comic_id), panels_by_id),
    }


def _signed_trailer(tr: dict | None, panels_by_id: dict) -> dict | None:
    """The stored trailer (see trailer.py) with fresh links for its panels, voice, music and hits."""
    if not tr:
        return None
    sign = lambda k: storage.presign(k) if k else None  # noqa: E731
    shots = [
        {**s, "image": panels_by_id[s["panel"]]["image"], "voice": sign(s["voice"]), "hit": sign(s["hit"]),
         "line": s["line"] and {**s["line"], "audio": sign(s["line"]["audio"])}}
        for s in tr["shots"] if s["panel"] in panels_by_id
    ]
    return {**tr, "music": sign(tr["music"]), "shots": shots}


@app.get("/api/comics/{comic_id}")
def get_comic(comic_id: str, lang: str | None = None):
    comic = db.load_comic(comic_id) if COMIC_ID.fullmatch(comic_id) else None
    if not comic:
        raise HTTPException(404)
    if lang and lang != "original" and not db.apply_translation(comic, lang):
        raise HTTPException(404, "translation_missing")
    comic["languages"] = db.languages(comic_id)
    return comic


@app.get("/api/comics")
def list_comics():
    return db.list_comics()


# In production the API also serves the built web app: one service, one origin (live streams need no
# proxy). Registered last, so every /api route above wins. In development Vite serves the app instead.
WEB_DIST = Path(os.environ.get("WEB_DIST", Path(__file__).parents[3] / "web" / "dist"))
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
