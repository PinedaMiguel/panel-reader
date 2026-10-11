# Nod & Read

**Every comic, read aloud. One panel at a time.**

Nod & Read turns comic pages into an accessible reading experience you can control with your face. It finds every panel, puts them in reading order, and plays them back one per screen with a voice for each character, sound effects, and an optional audiobook narrator that describes each scene, the characters' expressions and their body language. It's built for blind and low-vision readers, dyslexic and colour-blind readers, neurodivergent readers, and anyone who wants to listen to a comic.

Built at **KnightHacks IX** by Miguel Pineda, Royce Moriyasu, and Anna Qin (UCF, October 2026).

## What it does

### Watching
- **A lineup, Netflix style.** The start page deals three random shows and plays a short teaser for each: key panels crossfading, one voiced line, and a mood-matched music bed. Turn right to watch the one on screen, or let it move on; after all three, the one your heart meter liked most starts after a short countdown. "Other picks" deals three new shows.
- **Playing next.** At the end of a comic, the camera pulls back to the whole last page with the other pages beside it, then the next show is picked from how you took this one: more of what you liked, the opposite mood of what you didn't, with the reason in one line.
- **The gallery** at `/gallery` lists every show, with a "Because you liked…" row. It's reached only by typing the address.

### Reading
- **One panel per screen.** Scroll, swipe or use the keyboard; every panel snaps into place.
- **A camera that moves across the page.** The full page sits blurred behind each panel and glides to the next panel's position, so moving along a row slides sideways and moving to the next row slides down, like your eye would.
- **Motion-comic feel.** Comics open on the first page, panels drift slowly while they're read, and a progress bar tracks the page.

### Listening
- **Play / Pause** reads the comic and turns the pages by itself. Pause stops mid-sentence; Play continues from that exact spot.
- **A voice per character.** Each character is cast a distinct ElevenLabs voice that stays the same on every page, even across separate uploads of the same comic.
- **Expressive delivery.** Lines carry emotion tags (`[whispers]`, `[urgently]`, `[nervous laugh]`) that the ElevenLabs v3 model performs.
- **Sound effects** recorded with ElevenLabs play under each panel.
- **Audiobook mode** adds a narrator (a neural edge-tts voice in the reading language) who describes the setting, what happens, and each character's emotion and body language. It can be switched on or off at any moment: turning it off skips straight to the dialogue, and turning it on picks up from the next narration.

### Hands-free (face control)
A guided setup teaches each gesture with an animated 3D guide and calibrates it: you hold each turn and the look-up until a bar fills, and how far you hold sets your own thresholds, so small movements count for people who can't turn far. Then the whole site works without touching anything. Face tracking runs on-device (MediaPipe Face Landmarker); no video leaves the browser.
- **Turn right** = yes: press what's highlighted (Play, Watch). While a comic plays, the next panel.
- **Turn left** = no: close or go back. While a comic plays, the previous panel.
- **Close your eyes** for about a second: audiobook narrator on/off while a comic plays.
- **Look up** at the sky for a moment: pause the comic while it plays, or hold the lineup's preview (look up again to resume).
- **Just enjoy it:** smiles and nods fill a heart meter (shakes drain it) that picks what to read next.
- Control pauses by itself when you look away or someone else comes into view; **H** pauses it by hand.

### Accessibility (all opt-in)
- **Fonts:** OpenDyslexic for dyslexia, Atkinson Hyperlegible for low vision, and adjustable caption size (80–200%).
- **Colour-blind correction** for protanopia, deuteranopia and tritanopia, applied to the artwork itself (daltonization), plus high-contrast and grayscale modes.
- **Emotion labels** written on each panel ("Bertoff: grave and urgent") for readers who find facial expressions hard to read.
- **Captions** with the speaker's name, colour-coded with a colour-blind-safe palette.
- **Screen reader and keyboard support:** every panel has a scene description, panel changes are announced, and the whole reader works without a mouse.
- **Translation** into Spanish, French, Brazilian Portuguese, German, Japanese, Hindi and Mandarin, re-voiced with the same character cast.
- **Reduced motion:** animations switch off when the system asks for less motion.

### Adding comics (team only)
The library is curated: only the team adds comics, from public-domain or permissively licensed sources, and viewers can't upload. Adding runs paid models, so the upload endpoints require the `ADMIN_TOKEN` (sent as the `X-Admin-Token` header).
- **Upload** one or more pages (`POST /api/comics`), or **continue** an existing comic (`POST /api/comics/<id>/pages`) so new pages keep the same character voices.
- **Watch it being read.** A full-screen visualization shows the pipeline at work: panels detected and numbered in reading order, crops lined up, the cast found, the script written panel by panel, voices assigned and audio recorded. It ends with a camera zoom into the first panel that becomes the reader without a cut.
- **Replays are free.** A page that was already processed (same file hash) replays its stored results with no AI calls, and every comic's preview has a "How it was read" button that replays its visualization.

## How it works

```
page image ──► Magi v2 (Hugging Face) ──► panels + reading order
           ──► Gemini ──► cast list for the page, then per panel: scene, narration,
                          dialogue with speakers and emotion tags, sound-effect prompts, emotion labels
           ──► Gemini ──► voice casting (one ElevenLabs voice per character)
           ──► ElevenLabs ──► dialogue clips (eleven_v3) + sound effects
           ──► edge-tts ──► audiobook narrator, in the comic's language
           ──► Neon ──► Postgres rows (comics, pages, panels, lines, characters, translations)
                        + object storage bucket (page images, panel crops, audio)
```

- **Panel detection:** [Magi v2](https://huggingface.co/ragavsachdeva/magiv2) finds the panels. Its manga (right-to-left) ordering is re-sorted into Western rows read left to right.
- **Script:** Gemini makes one whole-page call to build the cast list, so every panel uses the same character ids, then analyses the panels in parallel. Requests fail over across several Gemini Flash models when one is overloaded or rate-limited.
- **Audio:** ElevenLabs records dialogue and sound effects; edge-tts (Microsoft neural voices) records the audiobook narrator in each language, and narrator recordings that already exist are kept. Clips are cached by content hash, so nothing is recorded twice.
- **Storage:** Neon Postgres is queried over Neon's HTTPS SQL endpoint, and files live in a private Neon bucket served through signed links. Each page's SHA-256 hash is stored so repeat uploads reuse their results.
- **Progress:** the API streams structured pipeline events (Server-Sent Events) that drive the visualization, live for new pages and as a replay for cached ones.

## Tech stack

| Part | Built with |
|---|---|
| Web app | React 19, TypeScript, Vite |
| API | Python 3.12, FastAPI, uv |
| Panel detection | Magi v2 via Hugging Face `transformers` + PyTorch |
| Script, casting, translation | Google Gemini API (`google-genai`) |
| Voices and sound effects | ElevenLabs (`eleven_v3`, Sound Effects) |
| Audiobook narrator | edge-tts (Microsoft neural voices) |
| Face tracking | MediaPipe Face Landmarker (on-device, in the browser) |
| 3D setup guide | three.js |
| Database and files | Neon Postgres + Neon Object Storage |
| Hosting | Vultr VM with Caddy (automatic HTTPS), via `deploy/`, or Render via `render.yaml` |

## Running it locally

**Requirements:** Node 20.19+, [uv](https://docs.astral.sh/uv/), a Neon project with a bucket named `uploads`, and Gemini, ElevenLabs and Hugging Face API keys.

1. **Environment.** Create `.env` in the repo root:
   ```
   GEMINI_API_KEY=...
   ELEVENLABS_API_KEY=...
   HF_TOKEN=...
   ADMIN_TOKEN=...      # any secret: required to add comics
   ```
   Then link Neon, which adds `DATABASE_URL` and the `AWS_*` bucket credentials to `.env`:
   ```
   npm i -g neon && neon login
   neon link --project-id <your-project-id> -y
   neon deploy          # creates the uploads bucket declared in neon.ts
   ```

2. **API** (port 8000). It creates the database tables on startup; the first run downloads the Magi model (about 2 GB).
   ```
   cd api
   uv run --env-file ../.env uvicorn api.main:app --port 8000
   ```

3. **Web app** (port 5173, proxies `/api` to the API):
   ```
   cd web
   npm install
   npm run dev
   ```
   `npm run dev:phone` serves the app over HTTPS on your local network (port 5174), which phones need for camera access (hands-free control).

4. **Hand-written scripts.** `uv run --env-file ../.env python -m api.narrate ../web/public/<folder>` fills in a hand-written `script.json` with Gemini narration, voice casting and audio.

## Deploying

`deploy/` holds a one-time server setup script and a one-command deploy for an Ubuntu 24.04 VM (built for Vultr):

```
ssh root@<server-ip> 'bash -s' < deploy/setup.sh   # Caddy, uv, swap, firewall, systemd service
deploy/deploy.sh <server-ip> [domain]              # build, upload, install, restart
```

**Render:** `render.yaml` is a Blueprint for one Docker web service (the root `Dockerfile` builds the web app and runs the API reading-only). Set the Neon variables (`DATABASE_URL` and `AWS_*`) when Render asks for them.

Without a domain, the site is served at `https://<ip-with-dashes>.sslip.io`, with HTTPS from Let's Encrypt via Caddy.

The server also runs **without any model API keys**: `deploy.sh` sends it only the Neon credentials (`DATABASE_URL` and the `AWS_*` storage keys). It serves everything already stored (scripts, voices, sound effects, previews and translations); with no Gemini or ElevenLabs key it offers only translations a comic already has, and with no `ADMIN_TOKEN` it refuses uploads.

The server runs **without Magi v2** (`MAGI=off`, installed with `uv sync --no-group magi`), so it needs no PyTorch and about 1–2 GB of RAM. Everything viewers do (browsing, previews, reading, translations) works without it. New comics are added on a machine that has Magi installed (the default for `uv sync` locally); a never-seen page sent to a server without Magi fails before any paid model call, while re-uploading already-processed pages still replays them from cache. To host anywhere else, run the API the same way:

```
uv sync --frozen --no-group magi
MAGI=off uv run --frozen --no-group magi uvicorn api.main:app --port 8000
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| ↓ → Space PageDown | Next panel |
| ↑ ← Shift+Space PageUp | Previous panel |
| Home / End | Title card / last panel |
| P | Play / Pause |
| A | Audiobook narration on/off |
| S | Reading settings |
| Esc | Back to the lineup |
| H | Pause / resume hands-free control |
| D | Face-tracking debug readout |

In the lineup, ← → move between previews and Esc deals other picks.

## Repository layout

```
api/src/api/   FastAPI app, pipeline, Magi, Gemini, ElevenLabs, Neon (db + storage)
web/src/       React app: guided setup, lineup, home, processing visualization, reader, settings
web/src/face/  Face tracking, gestures, heart meter, guided setup
deploy/        Server setup, deploy script, Caddyfile
Dockerfile     Reading-only image (web app + API, no Magi)
render.yaml    Render Blueprint
samples/       Source pages of the comics in the library (public domain or CC BY; see samples/SOURCES.md)
neon.ts        Neon infrastructure config (the uploads bucket)
```

## Credits and disclosures

- **AI models and APIs:**
  - **Google Gemini** for scripts, casting and translation.
  - **ElevenLabs** for character voices and sound effects.
  - **edge-tts** (Microsoft neural voices) for the audiobook narrator.
  - **Magi v2** by Ragav Sachdeva et al. for panel detection, used under its research / non-commercial license.
- **Face tracking:** Google MediaPipe Face Landmarker, run in the browser.
- **Setup voice:** short instructions recorded with ElevenLabs (Matilda voice).
- **Infrastructure:** Neon (Postgres and Object Storage), Vultr and Render (hosting), Caddy.
- **AI-assisted development:** much of this code was written with **Claude Code** (Anthropic) as a pair-programming assistant, directed and reviewed by the team.
- **Starter code:** the web app began from the Vite React TypeScript template, and the API from `uv init`.
- **Fonts:** OpenDyslexic, Atkinson Hyperlegible, Bangers and Bricolage Grotesque, all self-hosted through Fontsource under the SIL Open Font License.
- **Design reference:** the reader's motion-comic feel follows the Sapporo Breweries 150th-anniversary story site, and the home page layout follows GlobalComix.
- **Comics:**
  - *Little Nemo in Slumberland* (Winsor McCay, 1905) and "Artist of Evil" (*Adventures Into the Unknown* #36, 1952) are public domain, from Wikimedia Commons.
  - "Bernie the Fox" (*Coo Coo Comics* #3, 1943), "Superfox Versus Needle-Noggin" (*Daffy Tunes* #12, 1947), "A Rootin' Tootin' Story of Pecos Bill" (*Western Fighters* #6, 1949), "The Weird Wager" (*Out of the Night* #9, 1953) and "Killer at Large" (*Shocking Mystery Cases* #58, 1954) are public domain, from Wikimedia Commons.
  - *Pepper&Carrot* episode 6, "The Potion Contest", is by David Revoy ([peppercarrot.com](https://www.peppercarrot.com)), licensed CC BY 4.0.
  - Sources for every page are listed in `samples/SOURCES.md`.
