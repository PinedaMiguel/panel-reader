import { useEffect, useState } from 'react'
import Preview from './Preview'
import { loadHearts } from './face/heart'

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

export type ProcessJob = { id: string; files: File[]; title: string }

// Home: just the shows, like a TV app. Nothing to search, scroll or aim at: turn your head to move between
// covers, nod to open one. The processing visualization ("How it was read") is owned by App, so it can
// stay on screen while the reader mounts under it.
export default function Home({ onProcess }: { onProcess: (job: ProcessJob) => void }) {
  const [comics, setComics] = useState<Listed[] | null>(null)
  const [previewing, setPreviewing] = useState<Listed | null>(null)

  useEffect(() => {
    fetch('/api/comics')
      .then((r) => (r.ok ? r.json() : []))
      .then(setComics)
      .catch(() => setComics([]))
  }, [])

  // Free: plays a stored comic's processing from saved results.
  const replay = async (c: Listed) => {
    const r = await fetch(`/api/comics/${c.id}/replay`, { method: 'POST' })
    if (r.ok) onProcess({ id: (await r.json()).job, files: [], title: c.title })
  }

  // "Because you liked X": X is the comic your heart meter rated highest; the rest are ranked by how
  // many genre and mood tags they share with it.
  const list = comics ?? []
  const hearts = loadHearts()
  const tags = (c: Listed) => new Set([...(c.genres ?? []), ...(c.moods ?? [])])
  const liked = list
    .filter((c) => (hearts[c.id]?.score ?? 0) > 55 && c.genres)
    .sort((a, b) => hearts[b.id].score - hearts[a.id].score)[0]
  const because = liked
    ? list
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
        </span>
      </a>
    </li>
  )

  return (
    <div className="app">
      <header className="appbar">
        <span className="wordmark">Panel Reader</span>
      </header>

      <main className="home">
        {liked && because.length > 0 && (
          <section className="shelf" aria-labelledby="shelf-because">
            <div className="shelf-head">
              <h2 id="shelf-because">Because you liked {liked.title}</h2>
              <p>Picked from your heart meter. Measured on this device only.</p>
            </div>
            <ul className="shows">{because.map(card)}</ul>
          </section>
        )}

        <section className="shelf" aria-labelledby="shelf-comics">
          <div className="shelf-head">
            <h2 id="shelf-comics">Shows</h2>
            <p>Pick one to see a preview. Every panel is read aloud, with a voice for each character.</p>
          </div>
          {comics === null ? <p className="status">Loading…</p> : <ul className="shows">{list.map(card)}</ul>}
        </section>

        <footer className="credits">
          Made at KnightHacks IX with Gemini, ElevenLabs, Hugging Face (Magi v2) and Neon.
        </footer>
      </main>
      {previewing && (
        <Preview
          id={previewing.id}
          title={previewing.title}
          onClose={() => setPreviewing(null)}
          onReplay={() => replay(previewing)}
        />
      )}
    </div>
  )
}
