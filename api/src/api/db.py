"""Neon Postgres over HTTPS (Neon's /sql endpoint).

The venue network blocks port 5432, so we use Neon's HTTP query endpoint on 443. It works the
same from the Vultr server. Files live in the Neon `uploads` bucket; rows store their keys.
"""

import json
import os
from functools import cache
from urllib.parse import urlparse

import httpx

from . import storage

SCHEMA = [
    """create table if not exists comics (
        id text primary key,
        title text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
    )""",
    """create table if not exists characters (
        comic_id text not null references comics(id) on delete cascade,
        id text not null,
        name text,
        description text not null default '',
        voice_id text,
        primary key (comic_id, id)
    )""",
    """create table if not exists pages (
        comic_id text not null references comics(id) on delete cascade,
        idx int not null,
        id text not null,
        image_key text not null,
        primary key (comic_id, idx)
    )""",
    # SHA-256 of the uploaded page file: an identical upload reuses this page instead of reprocessing.
    "alter table pages add column if not exists hash text",
    "create index if not exists pages_hash on pages (hash)",
    # "What to watch next": spoiler-free synopsis, tags, teaser panels (written once by Gemini).
    "alter table comics add column if not exists preview jsonb",
    "alter table comics add column if not exists trailer jsonb",
    """create table if not exists panels (
        comic_id text not null references comics(id) on delete cascade,
        id text not null,
        page_idx int not null,
        ord int not null,
        image_key text not null,
        bbox jsonb,
        scene text not null default '',
        narration text,
        narration_audio_key text,
        characters jsonb not null default '[]',
        emotion_labels jsonb not null default '[]',
        sfx jsonb not null default '[]',
        primary key (comic_id, id)
    )""",
    """create table if not exists lines (
        comic_id text not null,
        panel_id text not null,
        ord int not null,
        speaker text,
        text text not null,
        tagged text,
        audio_key text,
        primary key (comic_id, panel_id, ord),
        foreign key (comic_id, panel_id) references panels(comic_id, id) on delete cascade
    )""",
    # One row per panel per language: translated text plus its audio keys (same character voices).
    """create table if not exists translations (
        comic_id text not null,
        lang text not null,
        panel_id text not null,
        data jsonb not null,
        primary key (comic_id, lang, panel_id),
        foreign key (comic_id, panel_id) references panels(comic_id, id) on delete cascade
    )""",
]


@cache
def _endpoint() -> tuple[str, dict[str, str]]:
    url = os.environ["DATABASE_URL"]
    return f"https://{urlparse(url).hostname}/sql", {"Neon-Connection-String": url}


def query(sql: str, *params) -> list[dict]:
    ep, headers = _endpoint()
    r = httpx.post(ep, headers=headers, json={"query": sql, "params": list(params)}, timeout=30)
    if r.is_error:
        raise RuntimeError(f"neon: {r.status_code} {r.text[:300]}")
    return r.json()["rows"]


def transaction(statements: list[tuple[str, list]]) -> None:
    ep, headers = _endpoint()
    r = httpx.post(
        ep,
        headers={**headers, "Neon-Batch-Isolation-Level": "ReadCommitted"},
        json={"queries": [{"query": q, "params": p} for q, p in statements]},
        timeout=60,
    )
    if r.is_error:
        raise RuntimeError(f"neon: {r.status_code} {r.text[:300]}")


def migrate() -> None:
    transaction([(s, []) for s in SCHEMA])


# --- comic <-> rows -------------------------------------------------------------------------
# In memory a comic is the reader's script.json shape, with file fields holding bucket keys.


def save_comic(comic: dict) -> None:
    """Replace a comic's rows with the given script (one transaction)."""
    cid = comic["id"]
    stmts: list[tuple[str, list]] = [
        (
            """insert into comics (id, title) values ($1, $2)
               on conflict (id) do update set title = excluded.title, updated_at = now()""",
            [cid, comic["title"]],
        ),
        # Translations hang off panels (on delete cascade): park them for the rewrite, restore after.
        ("create temp table keep_translations on commit drop as select * from translations where comic_id = $1", [cid]),
        ("delete from characters where comic_id = $1", [cid]),
        ("delete from pages where comic_id = $1", [cid]),  # panels/lines go via their own deletes
        ("delete from panels where comic_id = $1", [cid]),
    ]
    for c in comic["characters"]:
        stmts.append((
            "insert into characters (comic_id, id, name, description, voice_id) values ($1, $2, $3, $4, $5)",
            [cid, c["id"], c.get("name"), c.get("description", ""), c.get("voiceId")],
        ))
    for idx, page in enumerate(comic["pages"], 1):
        stmts.append((
            "insert into pages (comic_id, idx, id, image_key, hash) values ($1, $2, $3, $4, $5)",
            [cid, idx, page["id"], page["image"], page.get("hash")],
        ))
        for p in page["panels"]:
            stmts.append((
                """insert into panels (comic_id, id, page_idx, ord, image_key, bbox, scene, narration,
                       narration_audio_key, characters, emotion_labels, sfx)
                   values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)""",
                [cid, p["id"], idx, p["order"], p["image"], json.dumps(p.get("bbox")), p.get("scene", ""),
                 p.get("narration"), p.get("narrationAudio"), json.dumps(p.get("characters", [])),
                 json.dumps(p.get("emotionLabels", [])), json.dumps(p.get("sfx", []))],
            ))
            for n, line in enumerate(p.get("lines", [])):
                stmts.append((
                    """insert into lines (comic_id, panel_id, ord, speaker, text, tagged, audio_key)
                       values ($1, $2, $3, $4, $5, $6, $7)""",
                    [cid, p["id"], n, line.get("speaker"), line["text"], line.get("tagged"), line.get("audio")],
                ))
    stmts.append((
        """insert into translations select k.* from keep_translations k
           where exists (select 1 from panels p where p.comic_id = k.comic_id and p.id = k.panel_id)""",
        [],
    ))
    transaction(stmts)


def load_comic(cid: str, sign: bool = True) -> dict | None:
    """Rebuild the script. With sign=True, file keys become presigned bucket URLs for the browser."""
    rows = query("select id, title from comics where id = $1", cid)
    if not rows:
        return None
    url = storage.presign if sign else (lambda k: k)
    opt = lambda k: url(k) if k else None  # noqa: E731

    characters = [
        {"id": r["id"], "name": r["name"], "description": r["description"], "voiceId": r["voice_id"]}
        for r in query("select * from characters where comic_id = $1 order by id", cid)
    ]
    lines: dict[str, list] = {}
    for r in query("select * from lines where comic_id = $1 order by panel_id, ord", cid):
        lines.setdefault(r["panel_id"], []).append(
            {"speaker": r["speaker"], "text": r["text"], "tagged": r["tagged"], "audio": opt(r["audio_key"])}
        )
    panels: dict[int, list] = {}
    for r in query("select * from panels where comic_id = $1 order by page_idx, ord", cid):
        panels.setdefault(r["page_idx"], []).append({
            "id": r["id"], "image": url(r["image_key"]), "order": r["ord"], "bbox": r["bbox"],
            "scene": r["scene"], "narration": r["narration"], "narrationAudio": opt(r["narration_audio_key"]),
            "characters": r["characters"], "emotionLabels": r["emotion_labels"],
            "sfx": [{**s, "audio": opt(s.get("audio"))} for s in r["sfx"]],
            "lines": lines.get(r["id"], []),
        })
    pages = [
        {"id": r["id"], "image": url(r["image_key"]), "hash": r["hash"], "panels": panels.get(r["idx"], [])}
        for r in query("select * from pages where comic_id = $1 order by idx", cid)
    ]
    return {"id": rows[0]["id"], "title": rows[0]["title"], "characters": characters, "pages": pages}


def find_page(sha: str) -> tuple[str, int] | None:
    """(comic id, page index) of an already-processed page with this file hash, if any."""
    rows = query(
        """select p.comic_id, p.idx from pages p join comics c on c.id = p.comic_id
           where p.hash = $1 order by c.created_at, p.idx limit 1""",  # the original, not later copies
        sha,
    )
    return (rows[0]["comic_id"], rows[0]["idx"]) if rows else None


def save_translation(cid: str, lang: str, panels: list[dict]) -> None:
    stmts = [("delete from translations where comic_id = $1 and lang = $2", [cid, lang])]
    for p in panels:
        data = {k: p.get(k) for k in ("scene", "narration", "narrationAudio", "lines", "emotionLabels")}
        stmts.append((
            "insert into translations (comic_id, lang, panel_id, data) values ($1, $2, $3, $4::jsonb)",
            [cid, lang, p["id"], json.dumps(data, ensure_ascii=False)],
        ))
    transaction(stmts)


def languages(cid: str) -> list[str]:
    return [r["lang"] for r in query("select distinct lang from translations where comic_id = $1 order by 1", cid)]


def apply_translation(comic: dict, lang: str, sign: bool = True) -> bool:
    """Overlay a stored translation onto a loaded comic. False if this language doesn't exist yet."""
    rows = query("select panel_id, data from translations where comic_id = $1 and lang = $2", comic["id"], lang)
    if not rows:
        return False
    url = storage.presign if sign else (lambda k: k)
    opt = lambda k: url(k) if k else None  # noqa: E731
    by_panel = {r["panel_id"]: r["data"] for r in rows}
    for page in comic["pages"]:
        for p in page["panels"]:
            t = by_panel.get(p["id"])
            if not t:
                continue
            p["scene"], p["narration"] = t["scene"], t["narration"]
            p["narrationAudio"] = opt(t.get("narrationAudio"))
            p["emotionLabels"] = t["emotionLabels"]
            for line, tl in zip(p["lines"], t["lines"]):
                line.update(text=tl["text"], tagged=tl["tagged"], audio=opt(tl.get("audio")))
    comic["lang"] = lang
    return True


def get_preview(cid: str) -> dict | None:
    rows = query("select preview from comics where id = $1", cid)
    return rows[0]["preview"] if rows else None


def save_preview(cid: str, preview: dict) -> None:
    query("update comics set preview = $2::jsonb where id = $1", cid, json.dumps(preview, ensure_ascii=False))


def get_trailer(cid: str) -> dict | None:
    rows = query("select trailer from comics where id = $1", cid)
    return rows[0]["trailer"] if rows else None


def save_trailer(cid: str, trailer: dict) -> None:
    query("update comics set trailer = $2::jsonb where id = $1", cid, json.dumps(trailer, ensure_ascii=False))


def list_comics() -> list[dict]:
    rows = query(
        """select c.id, c.title, count(p.id)::int as panels,
                  (select image_key from panels f where f.comic_id = c.id order by page_idx, ord limit 1) as cover,
                  (select count(*)::int from characters ch where ch.comic_id = c.id) as voices,
                  coalesce((select json_agg(distinct t.lang) from translations t where t.comic_id = c.id), '[]') as languages,
                  c.preview -> 'genres' as genres, c.preview -> 'moods' as moods
           from comics c left join panels p on p.comic_id = c.id
           group by c.id order by c.updated_at desc"""
    )
    for r in rows:
        r["cover"] = storage.presign(r["cover"]) if r["cover"] else None
    return rows


if __name__ == "__main__":
    migrate()
    print("schema ok:", [r["table_name"] for r in query(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1")])
