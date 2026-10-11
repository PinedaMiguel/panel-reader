import { useEffect, useState, type CSSProperties } from 'react'
import { onGesture, pauseGestures } from './face/engine'
import { loadHearts } from './face/heart'
import { freshLineup, play } from './Lineup'
import { upNext, type Listed } from './recommend'

// End of an episode: "playing next", chosen from how the heart meter says you took the one you just
// finished (more of what you liked, the opposite of what you didn't), with the reason in one line.
// Turn right (yes) plays it now; left (no) or "Other picks" brings a fresh lineup; Esc stays on this comic.

const COUNTDOWN_S = 8

export default function UpNext({ comicId, onStay }: { comicId: string; onStay: () => void }) {
  const [pick, setPick] = useState<ReturnType<typeof upNext>>(null)
  const [done, setDone] = useState<Listed | null>(null)
  const [left, setLeft] = useState(COUNTDOWN_S)

  useEffect(() => pauseGestures(), [])

  useEffect(() => {
    fetch('/api/comics')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Listed[]) => {
        const me = list.find((c) => c.id === comicId)
        if (!me) return
        setDone(me)
        setPick(upNext(me, list, loadHearts()))
      })
      .catch(() => {})
  }, [comicId])

  useEffect(() => {
    if (!pick) return
    if (left <= 0) return play(pick.show.id)
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [pick, left])

  useEffect(() => {
    if (!pick) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onStay())
    window.addEventListener('keydown', key, true) // ahead of the finale's own Esc
    const off = onGesture((g) => {
      if (g === 'right') play(pick.show.id) // yes
      else if (g === 'left') freshLineup(comicId) // no: three other shows
    })
    return () => {
      off()
      window.removeEventListener('keydown', key, true)
    }
  }, [pick, comicId, onStay])

  if (!pick || !done) return null
  const { show, reason, score } = pick
  return (
    <div className="lineup lineup-next up-next" role="dialog" aria-modal="true" aria-labelledby="up-next-title" data-face-own>
      {show.cover && <img className="lineup-backdrop" src={show.cover} alt="" />}
      <div className="next-card">
        {show.cover && <img className="next-cover" src={show.cover} alt="" />}
        <div className="next-text">
          <p className="eyebrow">Up next</p>
          <h1 id="up-next-title">
            {show.title} <span>playing next…</span>
          </h1>
          <p className="next-reason">{reason}</p>
          <ol className="next-scores" aria-label="Your heart meter">
            <li className="win">
              <span className="next-name">{done.title}</span>
              <span className="heart-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${score / 100})` }} />
              </span>
              <b>♥ {score}</b>
            </li>
          </ol>
          <div className="next-actions">
            <span className="next-count" aria-live="polite" style={{ '--p': `${(left / COUNTDOWN_S) * 100}%` } as CSSProperties}>
              {left}
            </span>
            <button type="button" className="btn btn-accent btn-lg" autoFocus onClick={() => play(show.id)}>
              ▶ Play now
            </button>
            <button type="button" className="btn btn-lg btn-ghost" onClick={() => freshLineup(comicId)}>
              Other picks
            </button>
            <button type="button" className="btn-link" onClick={onStay}>
              Stay here
            </button>
          </div>
          <p className="lineup-hint">Turn right to play · Turn left for other picks</p>
        </div>
      </div>
    </div>
  )
}
