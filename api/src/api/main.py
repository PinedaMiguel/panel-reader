"""HTTP API. Run: uv run --env-file ../.env uvicorn api.main:app --port 8000"""

import asyncio
import hashlib
import json
import shutil
import re
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from . import db, panels, pipeline

app = FastAPI(title="Panel Reader API")
pipeline.MEDIA.mkdir(exist_ok=True)
jobs: dict[str, pipeline.Job] = {}

ALLOWED = {".jpg", ".jpeg", ".png", ".webp"}
LANGUAGES = {
    "es": "Spanish", "fr": "French", "pt": "Brazilian Portuguese", "de": "German",
    "ja": "Japanese", "hi": "Hindi", "zh": "Mandarin Chinese",
}
COMIC_ID = re.compile(r"[0-9a-f]{10}")


@app.on_event("startup")
def startup() -> None:
    db.migrate()
    # Loading Magi takes a while; do it in the background so the first upload is faster.
    threading.Thread(target=panels.model, daemon=True).start()


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


@app.post("/api/comics")
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


@app.post("/api/comics/{comic_id}/pages")
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
    return _start(uuid.uuid4().hex[:10], lambda job: pipeline.run(job, uploads, existing["title"], rtl, audio, existing))


@app.post("/api/comics/{comic_id}/replay")
def replay(comic_id: str):
    """Show how a stored comic was processed, from saved results. Free: no model calls."""
    if not COMIC_ID.fullmatch(comic_id) or not db.query("select 1 from comics where id = $1", comic_id):
        raise HTTPException(404)
    return _start(uuid.uuid4().hex[:10], lambda job: pipeline.replay(job, comic_id))


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


@app.post("/api/comics/{comic_id}/narration")
def create_narration(comic_id: str, lang: str | None = Form(None)):
    """Record the audiobook narrator with ElevenLabs, only when a reader asks for it (costs credits)."""
    if not COMIC_ID.fullmatch(comic_id) or not db.query("select 1 from comics where id = $1", comic_id):
        raise HTTPException(404)
    if lang in (None, "", "original"):
        lang = None
    elif lang not in LANGUAGES:
        raise HTTPException(404)
    key = f"{comic_id}:narration:{lang or 'original'}"
    if key not in jobs or jobs[key].stage in ("done", "error"):
        jobs[key] = pipeline.Job(key)
        threading.Thread(target=pipeline.narrate_comic, args=(jobs[key], comic_id, lang), daemon=True).start()
    return {"job": key}


@app.get("/api/languages")
def languages():
    return LANGUAGES


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
