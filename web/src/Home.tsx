import { useEffect, useRef, useState } from 'react'
import Preview from './Preview'
import Scanner from './Scanner'
import { loadHearts } from './face/heart'
import { useSettings } from './settings'

type Listed = {
  id: string
  title: string
  panels: number
  voices?: number
  languages?: string[]
  cover?: string | null
  genres?: string[] | null
  moods?: string[] | null
}
type Progress = { stage: string; done: number; total: number; error: string | null }

const FEATURES: [string, string, string][] = [
  ['🎭', 'A voice for every character', 'Each character keeps one voice across every page.'],
  ['🎧', 'Audiobook narration', 'Scenes, expressions and body language, described.'],
  ['🔤', 'Dyslexia & low-vision fonts', 'OpenDyslexic or Atkinson Hyperlegible, any size.'],
  ['🎨', 'Colour-blind correction', 'Protan, deutan and tritan filters on the art itself.'],
  ['💬', 'Emotion labels', 'See how each character feels, written on the panel.'],
  ['🌍', '7 languages', 'Translated and re-voiced with the same cast.'],
  ['📷', 'Scan a real comic', 'Spoken framing hints and auto-capture.'],
  ['⌨️', 'Keyboard & screen reader', 'Every panel described; no mouse needed.'],
]

// Home: an app shell modelled on GlobalComix's layout (featured hero, titled shelves,
// floating-cover cards), with Panel Reader's own actions, colours and copy.
export type ProcessJob = { id: string; files: File[]; title: string }

// The processing visualization is owned by App, so it can stay on screen while the reader mounts under it.
export default function Home({ onProcess }: { onProcess: (job: ProcessJob) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [comics, setComics] = useState<Listed[]>([])
  const [scanning, setScanning] = useState(false)
  const [target, setTarget] = useState('') // '' = new comic, else id of a comic to continue
  const [query, setQuery] = useState('')
  const [previewing, setPreviewing] = useState<Listed | null>(null)
  const [settings, set] = useSettings()
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/comics')
      .then((r) => (r.ok ? r.json() : []))
      .then(setComics)
      .catch(() => setComics([]))
  }, [])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (files.length) upload(files, title || files[0].name.replace(/\.\w+$/, ''))
  }

  const upload = async (pages: File[], name: string, into = target) => {
    const body = new FormData()
    pages.forEach((f) => body.append('pages', f))
    body.append('title', name)
    setProgress({ stage: 'uploading', done: 0, total: 0, error: null })
    // Continuing a comic keeps its characters' voices (stored in Neon).
    const url = into ? `/api/comics/${into}/pages` : '/api/comics'
    const r = await fetch(url, { method: 'POST', body })
    if (!r.ok) {
      setProgress({ stage: 'error', done: 0, total: 0, error: await r.text() })
      return
    }
    const { job: id } = await r.json()
    setProgress(null)
    onProcess({ id, files: pages, title: name })
  }

  // Same bytes as a page processed before → the API replays it instead of calling the models.
  const trySample = async () => {
    const blob = await (await fetch('/samples/blue-bolt-5-p4.jpg')).blob()
    upload([new File([blob], 'blue-bolt-5-p4.jpg', { type: 'image/jpeg' })], 'Blue Bolt #5 (1940)', '')
  }

  // Free: plays a stored comic's processing from saved results.
  const replay = async (c: Listed) => {
    const r = await fetch(`/api/comics/${c.id}/replay`, { method: 'POST' })
    if (r.ok) onProcess({ id: (await r.json()).job, files: [], title: c.title })
  }

  const busy = !!progress && progress.stage !== 'error'

  // "Because you liked X": X is the comic your heart meter rated highest; the rest are ranked by how
  // many genre and mood tags they share with it.
  const hearts = loadHearts()
  const tags = (c: Listed) => new Set([...(c.genres ?? []), ...(c.moods ?? [])])
  const liked = comics
    .filter((c) => (hearts[c.id]?.score ?? 0) > 55 && c.genres)
    .sort((a, b) => hearts[b.id].score - hearts[a.id].score)[0]
  const because = liked
    ? comics
        .filter((c) => c.id !== liked.id)
        .map((c) => ({ c, shared: [...tags(c)].filter((t) => tags(liked).has(t)).length }))
        .filter((r) => r.shared > 0)
        .sort((a, b) => b.shared - a.shared)
        .map((r) => r.c)
    : []
  const card = (c: Listed) => (
    <li key={c.id} className="card">
      <a
        href={`?id=${c.id}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          setPreviewing(c)
        }}
      >
        {c.cover && <img src={c.cover} alt="" loading="lazy" />}
        <span className="card-body">
          <span className="card-title">{c.title}</span>
          <span className="card-meta">
            {c.panels} panels{c.voices ? ` · ${c.voices} voices` : ''}
          </span>
          <span className="card-status">
            ▶ Preview
            {c.languages?.map((l) => (
              <span key={l} className="lang">
                {l.toUpperCase()}
              </span>
            ))}
          </span>
        </span>
      </a>
      <button type="button" className="card-replay" onClick={() => replay(c)}>
        How it was read
      </button>
    </li>
  )
  const featured = comics[0]
  const shown = comics.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))

  if (scanning) {
    return (
      <Scanner
        onCancel={() => setScanning(false)}
        onDone={(pages) => {
          setScanning(false)
          upload(pages, title || `Scanned comic ${new Date().toLocaleDateString()}`)
        }}
      />
    )
  }

  const prefs: [string, boolean, () => void][] = [
    ['Dyslexia font', settings.font === 'opendyslexic', () => set({ font: settings.font === 'opendyslexic' ? 'default' : 'opendyslexic' })],
    ['Low-vision font', settings.font === 'atkinson', () => set({ font: settings.font === 'atkinson' ? 'default' : 'atkinson' })],
    ['Large captions', settings.textScale >= 1.4, () => set({ textScale: settings.textScale >= 1.4 ? 1 : 1.5 })],
    ['Colour-blind correction', settings.color === 'deuteranopia', () => set({ color: settings.color === 'deuteranopia' ? 'none' : 'deuteranopia' })],
    ['Emotion labels', settings.emotions, () => set({ emotions: !settings.emotions })],
    ['Hands-free (eyes & head)', settings.gaze, () => set({ gaze: !settings.gaze })],
    ['Heart meter', settings.heart, () => set({ heart: !settings.heart })],
  ]

  return (
    <div className="app">
      <header className="appbar">
        <a href="./" className="wordmark" aria-label="Panel Reader home">
          Panel Reader
        </a>
        <label className="search">
          <span className="sr-only">Search your comics</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Search your comics"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-accent" onClick={() => setScanning(true)} disabled={busy}>
          Scan a comic
        </button>
      </header>

      <main className="home">
        <ul className="chips" aria-label="Reading preferences">
          {prefs.map(([label, on, toggle]) => (
            <li key={label}>
              <button type="button" aria-pressed={on} onClick={toggle}>
                {label}
              </button>
            </li>
          ))}
        </ul>

        <section className="feature" aria-labelledby="hero-title">
          <div className="feature-text">
            <p className="eyebrow">Accessible comics</p>
            <h1 id="hero-title">Every comic, read aloud. One panel at a time.</h1>
            <p className="feature-sub">
              Snap or upload any page. Each panel gets a narrator, a voice per character, sound effects and
              captions, in a reader built for every kind of reader.
            </p>
            <div className="feature-actions">
              <button type="button" className="btn btn-accent btn-lg" onClick={() => setScanning(true)} disabled={busy}>
                Scan pages
              </button>
              <button type="button" className="btn btn-lg" onClick={() => fileInput.current?.click()} disabled={busy}>
                Upload pages
              </button>
              <button type="button" className="btn-link" onClick={trySample} disabled={busy}>
                or process a sample page →
              </button>
            </div>
          </div>
          {featured?.cover && (
            <a className="feature-art" href={`?id=${featured.id}`}>
              <img src={featured.cover} alt="" />
              <span className="feature-art-label">
                <small>Continue reading</small>
                <strong>{featured.title}</strong>
                <span className="play" aria-hidden="true">▶</span>
              </span>
            </a>
          )}
        </section>

        {progress?.error && (
          <div className="job" role="alert">
            <p>Something went wrong: {progress.error}</p>
          </div>
        )}

        {liked && because.length > 0 && (
          <section className="shelf" aria-labelledby="shelf-because">
            <div className="shelf-head">
              <h2 id="shelf-because">Because you liked {liked.title}</h2>
              <p>Picked from your heart meter. Measured on this device only.</p>
            </div>
            <ul className="rail">{because.map(card)}</ul>
          </section>
        )}

        {comics.length > 0 && (
          <section className="shelf" aria-labelledby="shelf-comics">
            <div className="shelf-head">
              <h2 id="shelf-comics">Your comics</h2>
              <p>Saved in Neon. Every page you add keeps the same voices.</p>
            </div>
            <ul className="rail">
              {shown.map(card)}
              {!shown.length && <li className="empty">No comics match “{query}”.</li>}
            </ul>
          </section>
        )}

        <section className="shelf" aria-labelledby="shelf-upload">
          <div className="shelf-head">
            <h2 id="shelf-upload">Upload pages</h2>
            <p>Whole pages, in reading order. Panels are found and read automatically.</p>
          </div>
          <form onSubmit={submit} className="upload">
            <label>
              Pages
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            {comics.length > 0 && (
              <label>
                Add to
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">A new comic</option>
                  {comics.map((c) => (
                    <option key={c.id} value={c.id}>
                      Continue “{c.title}”
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!target && (
              <label>
                Title
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
              </label>
            )}
            <button type="submit" className="btn btn-accent" disabled={!files.length || busy}>
              Make it readable
            </button>
          </form>
        </section>

        <section className="shelf" aria-labelledby="shelf-features">
          <div className="shelf-head">
            <h2 id="shelf-features">Built for every reader</h2>
            <p>Blind and low-vision, dyslexic, colour-blind, neurodivergent, or just listening.</p>
          </div>
          <ul className="features-grid">
            {FEATURES.map(([icon, name, text]) => (
              <li key={name}>
                <span className="feature-icon" aria-hidden="true">
                  {icon}
                </span>
                <strong>{name}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </section>

        <footer className="credits">
          Made at KnightHacks IX with Gemini, ElevenLabs, Hugging Face (Magi v2) and Neon.
        </footer>
      </main>
      {previewing && <Preview id={previewing.id} title={previewing.title} onClose={() => setPreviewing(null)} />}
    </div>
  )
}
