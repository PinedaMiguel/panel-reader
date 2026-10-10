import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { onGesture } from './face/engine'
import { useHeart } from './face/heart'
import { useSettings } from './settings'
import Teaser, { teaserMs, type TeaserData } from './Teaser'

// The startup lineup, Netflix style: three random shows, each previewed in turn. Nod to watch the one
// on screen; leave it and the next preview starts. After all three, the one whose teaser your heart meter
// liked most plays next, after a short countdown. Turn = next/previous, shake = browse everything instead.

export type LineupShow = { id: string; title: string; cover?: string | null }
type Data = TeaserData & { synopsis: string; genres: string[]; moods: string[]; minutes: number }

const COUNTDOWN_S = 6
export const LINEUP_SEEN = 'panel-reader-lineup-seen'
const LINEUP_SKIP = 'panel-reader-lineup-skip'

// Back to the home page with a fresh lineup (new random shows, leaving out `skip`).
export function freshLineup(skip: string) {
  try {
    sessionStorage.removeItem(LINEUP_SEEN)
    sessionStorage.setItem(LINEUP_SKIP, skip)
  } catch {
    // storage blocked: home without the lineup
  }
  location.assign('./')
}

const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x)
export const play = (id: string) => {
  try {
    sessionStorage.setItem(LINEUP_SEEN, '1')
  } catch {
    // storage blocked: the lineup just shows again next time
  }
  location.assign(`?id=${id}`)
}

export default function Lineup({ comics, onDone }: { comics: LineupShow[]; onDone: () => void }) {
  const [settings] = useSettings()
  const picks = useMemo(() => {
    let skip: string | null = null
    try {
      skip = sessionStorage.getItem(LINEUP_SKIP)
    } catch {
      // no storage: nothing to skip
    }
    return shuffle(comics.filter((c) => c.cover && c.id !== skip)).slice(0, 3)
  }, [comics])
  const [data, setData] = useState<Record<string, Data>>({})
  const [i, setI] = useState(0)
  const [scores, setScores] = useState<Record<string, number>>({})
  const [left, setLeft] = useState(COUNTDOWN_S)
  const counting = i >= picks.length
  const show = picks[Math.min(i, picks.length - 1)]
  const d = data[show?.id ?? '']
  const heart = useHeart(show?.id ?? '', settings.heart && !counting && !!show)
  const score = useRef(heart.score)
  score.current = heart.score

  // Previews are written once and cached server-side; fetch all three up front.
  useEffect(() => {
    for (const p of picks)
      fetch(`/api/comics/${p.id}/preview`)
        .then((r) => (r.ok ? r.json() : null))
        .then((x) => x && setData((m) => ({ ...m, [p.id]: x })))
        .catch(() => {})
  }, [picks])

  const go = (to: number) => {
    if (!counting && show) setScores((s) => ({ ...s, [show.id]: Math.round(score.current) }))
    setI(Math.max(0, Math.min(picks.length, to)))
  }

  // Each preview runs for its teaser's length, then hands over to the next.
  useEffect(() => {
    if (counting || !d) return
    const t = setTimeout(() => go(i + 1), teaserMs(d))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, counting, d])

  // The pick: the teaser that lifted the heart meter most (ties go to the earlier one).
  const winner = counting ? picks.reduce((a, b) => ((scores[b.id] ?? 50) > (scores[a.id] ?? 50) ? b : a)) : null

  useEffect(() => {
    if (!winner) return
    if (left <= 0) return play(winner.id)
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [winner, left])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone()
      else if (e.key === 'ArrowRight' && !counting) go(i + 1)
      else if (e.key === 'ArrowLeft') go(counting ? picks.length - 1 : i - 1)
    }
    window.addEventListener('keydown', key)
    const off = onGesture((g) => {
      if (g === 'nod') play((winner ?? show).id)
      else if (g === 'shake') onDone()
      else if (g === 'right' && !counting) go(i + 1)
      else if (g === 'left') go(counting ? picks.length - 1 : i - 1)
    })
    return () => {
      off()
      window.removeEventListener('keydown', key)
    }
  })

  if (!show) return null

  if (winner) {
    return (
      <div className="lineup lineup-next" role="dialog" aria-modal="true" aria-labelledby="next-title" data-face-own>
        {winner.cover && <img className="lineup-backdrop" src={winner.cover} alt="" />}
        <div className="next-card">
          {winner.cover && <img className="next-cover" src={winner.cover} alt="" />}
          <div className="next-text">
            <p className="eyebrow">Your heart picked</p>
            <h1 id="next-title">
              {winner.title} <span>playing next…</span>
            </h1>
            <ol className="next-scores" aria-label="Heart meter for each preview">
              {picks.map((p) => (
                <li key={p.id} className={p.id === winner.id ? 'win' : ''}>
                  <span className="next-name">{p.title}</span>
                  <span className="heart-bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${(scores[p.id] ?? 50) / 100})` }} />
                  </span>
                  <b>♥ {scores[p.id] ?? 50}</b>
                </li>
              ))}
            </ol>
            <div className="next-actions">
              <span className="next-count" aria-live="polite" style={{ '--p': `${(left / COUNTDOWN_S) * 100}%` } as CSSProperties}>
                {left}
              </span>
              <button type="button" className="btn btn-accent btn-lg" autoFocus onClick={() => play(winner.id)}>
                ▶ Play now
              </button>
              <button type="button" className="btn btn-lg btn-ghost" onClick={onDone}>
                Browse instead
              </button>
            </div>
            <p className="lineup-hint">Nod to play now · Shake to browse</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="lineup" role="dialog" aria-modal="true" aria-labelledby="lineup-title" data-face-own>
      <Teaser data={d ?? null} waiting="Loading preview…" />
      <div className="lineup-shade" />
      <header className="lineup-top">
        <span className="lineup-kicker">Pick a show</span>
        <ol className="lineup-picks">
          {picks.map((p, k) => (
            <li key={p.id} className={k === i ? 'now' : k < i ? 'seen' : ''}>
              {p.cover && <img src={p.cover} alt="" />}
            </li>
          ))}
        </ol>
        <button type="button" className="welcome-fallback" onClick={onDone}>
          Browse all
        </button>
      </header>

      <div className="lineup-info" key={show.id}>
        <p className="eyebrow">
          {i + 1} of {picks.length}
          {d && ` · ${d.minutes} min`}
        </p>
        <h1 id="lineup-title">{show.title}</h1>
        {d && (
          <ul className="hero-tags" aria-label="Genre and mood">
            {[...d.genres, ...d.moods].slice(0, 4).map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        )}
        {d && <p className="lineup-synopsis">{d.synopsis}</p>}
        <div className="hero-actions">
          <button type="button" className="btn btn-accent btn-lg" autoFocus onClick={() => play(show.id)}>
            ▶ Watch
          </button>
          <button type="button" className="btn btn-lg btn-ghost" onClick={() => go(i + 1)}>
            Next preview
          </button>
        </div>
        <p className="lineup-hint">Nod to watch · Turn for the next one · Shake to browse</p>
      </div>

      <footer className="lineup-bottom">
        {settings.heart && (
          <span className="lineup-heart" aria-label={`Heart meter ${Math.round(heart.score)}`}>
            ♥
            <span className="heart-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${heart.score / 100})` }} />
            </span>
            <b>{Math.round(heart.score)}</b>
          </span>
        )}
        <span className="lineup-progress" aria-hidden="true">
          {d && <span key={show.id} style={{ animationDuration: `${teaserMs(d)}ms` }} />}
        </span>
      </footer>
    </div>
  )
}
