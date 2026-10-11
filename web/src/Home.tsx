import { useEffect, useState, type CSSProperties } from 'react'
import Preview from './Preview'
import { loadHearts } from './face/heart'
import { tone, type Listed } from './recommend'

export type ProcessJob = { id: string; files: File[]; title: string }

// The gallery (/gallery): every show, like a TV app's library. Only reachable by typing the address; the
// start page is the lineup. Nothing to search, scroll or aim at: turn your head to move between
// covers, nod to open one. The processing visualization ("How it was read") is owned by App, so it can
// stay on screen while the reader mounts under it.
export default function Home({ onProcess }: { onProcess: (job: ProcessJob) => void }) {
  const [comics, setComics] = useState<Listed[] | null>(null)
  const [previewing, setPreviewing] = useState<Listed | null>(null)
  const [blurb, setBlurb] = useState<{ id: string; synopsis: string; minutes: number } | null>(null)

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

  // "Something different": when the heart meter says you didn't enjoy a show, offer the opposite tone
  // (horror → comedy and wholesome, and the other way round).
  const disliked = list
    .filter((c) => (hearts[c.id]?.score ?? 50) < 40 && c.genres)
    .sort((a, b) => hearts[a.id].score - hearts[b.id].score)[0]
  const different = disliked
    ? list
        .filter((c) => c.id !== disliked.id && c.genres && Math.sign(tone(c)) !== Math.sign(tone(disliked)))
        .sort((a, b) => (tone(disliked) > 0 ? tone(a) - tone(b) : tone(b) - tone(a)))
    : []

  // Featured: the heart meter's favourite, else the newest. Its synopsis comes from the (cached) preview.
  const featured = liked ?? list[0]
  useEffect(() => {
    if (!featured) return
    fetch(`/api/comics/${featured.id}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setBlurb({ id: featured.id, synopsis: d.synopsis, minutes: d.minutes }))
      .catch(() => {})
  }, [featured?.id])

  const card = (c: Listed, k: number) => (
    <li key={c.id} className="card" style={{ '--i': k } as CSSProperties}>
      <a
        href={`?id=${c.id}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          setPreviewing(c)
        }}
      >
        <span className="card-art">
          {c.cover && <img src={c.cover} alt="" loading="lazy" />}
          <span className="card-title">{c.title}</span>
        </span>
        <span className="card-meta">
          {c.panels} panels{c.voices ? ` · ${c.voices} voices` : ''}
          {c.genres?.[0] && ` · ${c.genres[0]}`}
        </span>
      </a>
    </li>
  )

  return (
    <div className="app">
      <header className="appbar">
        <span className="wordmark">Panel Reader</span>
      </header>

      {featured && (
        <section className="hero" aria-labelledby="hero-title">
          {featured.cover && <img className="hero-backdrop" src={featured.cover} alt="" />}
          <div className="hero-text">
            <p className="eyebrow">{liked ? 'Your heart meter’s pick' : 'Featured'}</p>
            <h1 id="hero-title">{featured.title}</h1>
            <p className="hero-meta">
              {blurb?.id === featured.id && `${blurb.minutes} min · `}
              {featured.panels} panels{featured.voices ? ` · ${featured.voices} voices` : ''}
            </p>
            {!!featured.genres?.length && (
              <ul className="hero-tags" aria-label="Genres">
                {[...featured.genres, ...(featured.moods ?? [])].slice(0, 4).map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            )}
            {blurb?.id === featured.id && <p className="hero-synopsis">{blurb.synopsis}</p>}
            <div className="hero-actions">
              <a className="btn btn-accent btn-lg" href={`?id=${featured.id}`}>
                ▶ Play
              </a>
              <button type="button" className="btn btn-lg btn-ghost" onClick={() => setPreviewing(featured)}>
                Preview
              </button>
            </div>
          </div>
          {featured.cover && (
            <span className="hero-cover" aria-hidden="true">
              <img src={featured.cover} alt="" />
            </span>
          )}
        </section>
      )}

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

        {disliked && different.length > 0 && (
          <section className="shelf" aria-labelledby="shelf-different">
            <div className="shelf-head">
              <h2 id="shelf-different">
                Not feeling {disliked.title}? Try something {tone(disliked) > 0 ? 'lighter' : 'with more bite'}
              </h2>
              <p>Your heart meter dipped, so here's the opposite mood.</p>
            </div>
            <ul className="shows">{different.map(card)}</ul>
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
          <br />
          <i>Pepper&amp;Carrot</i> by David Revoy, <a href="https://www.peppercarrot.com">peppercarrot.com</a>, CC BY 4.0.
          Other classic comics are public domain.
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
