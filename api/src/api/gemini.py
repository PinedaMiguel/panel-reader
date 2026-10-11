"""Gemini agents: panel analysis (script + narration) and voice casting."""

import json
import os
import time
from functools import cache
from pathlib import Path

import httpx
from google import genai
from google.genai import errors, types
from pydantic import BaseModel

# Newest first, then lighter models. Under hackathon load a model can be overloaded for minutes, so
# on 503/429 we move straight to the next one and remember whichever answered last. On the free tier
# each model has a small daily request cap; a model that hits it is skipped for the rest of the run.
MODELS = [
    "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
    "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
]
_exhausted: set[str] = set()
_preferred = 0


@cache
def client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def generate(**kwargs):
    """generate_content that fails over between MODELS on overload, rate limits, retired models or dropped connections."""
    global _preferred
    last: Exception | None = None
    for round_ in range(3):
        for i in range(len(MODELS)):
            idx = (_preferred + i) % len(MODELS)
            if MODELS[idx] in _exhausted:
                continue
            try:
                resp = client().models.generate_content(model=MODELS[idx], **kwargs)
                _preferred = idx
                return resp
            except errors.APIError as e:
                if e.code not in (404, 429, 500, 503):
                    raise
                if e.code == 404 or (e.code == 429 and "PerDay" in str(e)):
                    _exhausted.add(MODELS[idx])  # retired, or out of today's quota
                last = e
            except (httpx.TransportError, ConnectionError) as e:  # flaky venue Wi-Fi
                last = e
        if len(_exhausted) == len(MODELS):
            break
        time.sleep(3 * (round_ + 1))
    raise last or RuntimeError("Gemini: every model is out of today's free-tier quota")


class CharacterIn(BaseModel):
    character_id: str
    emotion: str
    appearance: str


class LineOut(BaseModel):
    speaker_id: str | None
    text: str
    tagged: str


class NewCharacter(BaseModel):
    id: str
    name: str | None
    description: str


class PanelAnalysis(BaseModel):
    scene: str
    narration: str
    characters: list[CharacterIn]
    lines: list[LineOut]
    sfx: list[str]
    emotion_labels: list[str]
    new_characters: list[NewCharacter]


ANALYZE_PROMPT = """You are the script writer for an accessible comic audiobook.
Look at this single comic panel and return JSON.

Known characters so far (reuse these ids when the same person appears):
{characters}

Hints already known for this panel (trust them, may be empty):
{hints}

Fields:
- scene: one or two plain sentences describing what is shown; used as alt text.
- narration: what an audiobook narrator says before the dialogue, in present tense, warm audiobook tone,
  1-3 short sentences (under 60 words). Describe the setting, what happens, and each character's visible
  emotion, facial expression and body language. Describe a character's looks only the first time they appear.
  It is read BEFORE the dialogue, so describe only what is visible, not reactions to what is said.
  Refer to characters by a name only if the comic has already shown it (in a caption or earlier dialogue);
  otherwise describe them ("the reporter", "the old scientist").
  Never repeat the dialogue. Include the gist of narration caption boxes, woven in naturally.
- characters: each visible character with a one-word-or-short-phrase emotion and their appearance in this panel.
- lines: every speech balloon in reading order. speaker_id is a known or new character id, or null
  if you cannot tell who speaks. text is the exact words, normal sentence case (not ALL CAPS).
  tagged is the same text with ElevenLabs v3 audio tags in square brackets for delivery, e.g.
  [whispers], [angry], [laughs], [sighs], [nervously], [shouting], [pause]. Use one or two tags, never change the words.
  Do not include caption/narration boxes or sound-effect lettering as lines.
- sfx: 0-2 short sound-effect prompts that fit the panel (lettered effects or ambience), e.g. "heavy rain on pavement".
- emotion_labels: short labels like "Name: worried" for readers who find emotions hard to read.
- new_characters: characters not in the known list, with a short snake_case id, a name if the comic gives one,
  and a visual description (age, build, hair, clothes) useful for voice casting.
"""


def analyze_panel(image: Path, known: list[dict], hints: dict) -> PanelAnalysis:
    known_txt = "\n".join(f"- {c['id']}: {c.get('name') or ''} {c['description']}" for c in known) or "(none)"
    resp = generate(
        contents=[
            types.Part.from_bytes(data=image.read_bytes(), mime_type=_mime(image)),
            ANALYZE_PROMPT.format(characters=known_txt, hints=hints or "(none)"),
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=PanelAnalysis
        ),
    )
    return resp.parsed


class PageCast(BaseModel):
    characters: list[NewCharacter]


CAST_LIST_PROMPT = """List every recurring character on this comic page so panels can be analysed separately
with consistent ids. Known characters from earlier pages (reuse their ids, do not repeat them):
{characters}

Return only characters not already known. For each: a short snake_case id, a name only if the page states it,
and a visual description (age, build, hair, clothes, colours) useful for recognising them and casting a voice."""


def page_cast(page: Path, known: list[dict]) -> list[NewCharacter]:
    known_txt = "\n".join(f"- {c['id']}: {c.get('name') or ''} {c['description']}" for c in known) or "(none)"
    resp = generate(
        contents=[
            types.Part.from_bytes(data=page.read_bytes(), mime_type=_mime(page)),
            CAST_LIST_PROMPT.format(characters=known_txt),
        ],
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=PageCast),
    )
    return resp.parsed.characters


class Casting(BaseModel):
    character_id: str
    voice_id: str


CAST_PROMPT = """Cast a voice for each comic character. Match apparent gender, age and personality.
Every character must get a different voice. Use only voice ids from the list.

Characters:
{characters}

Voices:
{voices}
"""


def cast_voices(characters: list[dict], pool: dict[str, str]) -> dict[str, str]:
    resp = generate(
        contents=CAST_PROMPT.format(
            characters="\n".join(f"- {c['id']}: {c.get('name') or ''} {c['description']}" for c in characters),
            voices="\n".join(f"- {vid}: {desc}" for vid, desc in pool.items()),
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=list[Casting]
        ),
    )
    return {c.character_id: c.voice_id for c in resp.parsed}


def _mime(path: Path) -> str:
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


class LineTr(BaseModel):
    text: str
    tagged: str


class PanelTr(BaseModel):
    id: str
    scene: str
    narration: str
    lines: list[LineTr]
    emotion_labels: list[str]


class PageTr(BaseModel):
    panels: list[PanelTr]


TRANSLATE_PROMPT = """Translate this comic script into {language} for an audiobook.
Keep the same panels (same ids, same order) and the same number of lines per panel.
- Translate scene, narration, each line's text, and each emotion label (keep "Name: " prefixes' names as they are).
- tagged is the line with ElevenLabs audio tags in square brackets, e.g. "[whispers] Hello". Keep every tag
  exactly as written, in English, and translate only the words around them.
- Keep character names unchanged. Natural, spoken {language}; keep the tone (pulpy, dramatic, funny…).

Script (JSON):
{script}
"""


def translate_page(panels: list[dict], language: str) -> list[PanelTr]:
    script = [
        {"id": p["id"], "scene": p.get("scene", ""), "narration": p.get("narration") or "",
         "lines": [{"text": l["text"], "tagged": l.get("tagged") or l["text"]} for l in p.get("lines", [])],
         "emotion_labels": p.get("emotionLabels", [])}
        for p in panels
    ]
    resp = generate(
        contents=TRANSLATE_PROMPT.format(language=language, script=json.dumps(script, ensure_ascii=False)),
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=PageTr),
    )
    return resp.parsed.panels



class TeaserLine(BaseModel):
    panel_id: str
    line_index: int


class Preview(BaseModel):
    synopsis: str
    genres: list[str]
    moods: list[str]
    main_characters: list[str]
    teaser_panels: list[str]
    teaser_line: TeaserLine | None


PREVIEW_PROMPT = """You are writing the "what to watch next" preview for a comic in a reading app, like a streaming
service's title page. From the script below:
- synopsis: 2-3 sentences, spoiler-free, written as an intriguing hook (setting, who, what's at stake). No ending.
- genres: 2-4 short genre tags (e.g. "superhero", "political thriller", "jungle adventure", "war drama").
- moods: 2-3 short mood tags (e.g. "pulpy", "tense", "witty", "eerie").
- main_characters: the 2-4 most important character ids, most important first.
- teaser_panels: 3-4 panel ids, in reading order, that make the most enticing teaser without spoiling the end. They
  flash by in a few seconds each, so pick panels that read at a glance: a clear subject or striking image, little text,
  not cramped. Prefer action, faces and big moments over panels that are mostly speech balloons or captions.
- teaser_line: the single most intriguing SHORT line of dialogue (at most about 15 words) spoken by a known character
  (panel id + its line index). Only null if the comic has no dialogue at all.

Script (JSON):
{script}
"""


def preview(comic: dict) -> Preview:
    script = {
        "title": comic["title"],
        "characters": [{"id": c["id"], "name": c.get("name"), "description": c.get("description", "")} for c in comic["characters"]],
        "panels": [
            {"id": p["id"], "scene": p.get("scene", ""), "narration": p.get("narration") or "",
             "lines": [{"i": i, "speaker": l.get("speaker"), "text": l["text"]} for i, l in enumerate(p.get("lines", []))]}
            for page in comic["pages"] for p in page["panels"]
        ],
    }
    resp = generate(
        contents=PREVIEW_PROMPT.format(script=json.dumps(script, ensure_ascii=False)),
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=Preview),
    )
    return resp.parsed
