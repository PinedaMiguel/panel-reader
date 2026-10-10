import { useEffect, useRef, useState } from 'react'

// "What to watch next": a comic's title page. A trailer-style teaser (a few key panels and one voiced
// line) above a spoiler-free synopsis, tags, cast and length, so you know the story before committing.

type PreviewData = {
  id: string
  title: string
  synopsis: string
  genres: string[]
  moods: string[]
  characters: { name: string; description: string }[]
  pages: number
  panels: number
  minutes: number
  teaser: { image: string }[]
  teaserLine: { text: string; audio: string | null; speaker: string | null } | null
}

const SHOT_MS = 2800

export default function Preview({ id, title, onClose, onReplay }: { id: string; title: string; onClose: () => void; onReplay: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const [data, setData] = useState<PreviewData | null>(null)
  const [failed, setFailed] = useState(false)
  const [shot, setShot] = useState(0)
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    let alive = true
    fetch(`/api/comics/${id}/preview`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [id])

  // The teaser: cycle the key panels; the voiced line lands on the second shot, like a trailer beat.
  useEffect(() => {
    if (!data?.teaser.length) return
    const t = setInterval(() => setShot((s) => (s + 1) % data.teaser.length), SHOT_MS)
    const line = data.teaserLine?.audio
    let a: HTMLAudioElement | null = null
    const cue = line
      ? setTimeout(() => {
          a = new Audio(line)
          audio.current = a
          a.onplay = () => setSpeaking(true)
          a.onended = () => setSpeaking(false)
          a.play().catch(() => setSpeaking(false))
        }, SHOT_MS * 0.6)
      : undefined
    return () => {
      clearInterval(t)
      clearTimeout(cue)
      a?.pause()
      audio.current = null
    }
  }, [data])

  useEffect(() => {
    if (audio.current) audio.current.muted = muted
  }, [muted])

  const meta = data && `${data.minutes} min · ${data.pages} page${data.pages === 1 ? '' : 's'} · ${data.panels} panels`

  return (
    <dialog ref={ref} className="preview" onClose={onClose} aria-labelledby="preview-title">
      <div className="teaser" aria-hidden={!data}>
        {data?.teaser.map((p, i) => (
          <img key={p.image} src={p.image} alt="" className={i === shot ? 'on' : ''} />
        ))}
        {!data && !failed && <p className="teaser-wait">Writing a spoiler-free synopsis…</p>}
        {data?.teaserLine && (
          <p className={`teaser-line${speaking ? ' on' : ''}`}>
            {data.teaserLine.speaker && <b>{data.teaserLine.speaker}</b>}“{data.teaserLine.text}”
          </p>
        )}
        {data?.teaserLine?.audio && (
          <button type="button" className="teaser-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
            {muted ? '🔇 Unmute' : '🔊 Mute'}
          </button>
        )}
      </div>

      <div className="preview-body">
        <h2 id="preview-title">{data?.title ?? title}</h2>
        {failed && <p role="alert">Couldn’t load this preview. You can still start reading.</p>}
        {data && (
          <>
            <p className="preview-meta">{meta}</p>
            <ul className="preview-tags" aria-label="Genre and mood">
              {data.genres.map((g) => (
                <li key={g}>{g}</li>
              ))}
              {data.moods.map((m) => (
                <li key={m} className="mood">{m}</li>
              ))}
            </ul>
            <p className="preview-synopsis">{data.synopsis}</p>
            {data.characters.length > 0 && (
              <p className="preview-cast">
                <span>Starring</span> {data.characters.map((c) => c.name).join(', ')}
              </p>
            )}
          </>
        )}
        <div className="preview-actions">
          <a className="btn btn-accent" href={`?id=${id}`}>▶ Play</a>
          <form method="dialog">
            <button type="submit" className="btn" onClick={onReplay}>How it was read</button>
            <button type="submit" className="btn">Close</button>
          </form>
        </div>
      </div>
    </dialog>
  )
}
