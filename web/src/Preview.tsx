import { useEffect, useRef, useState } from 'react'
import Teaser, { type TeaserData } from './Teaser'
import { pauseGestures } from './face/engine'

// "What to watch next": a comic's title page. A trailer-style teaser (a few key panels and one voiced
// line) above a spoiler-free synopsis, tags, cast and length, so you know the story before committing.

type PreviewData = TeaserData & {
  id: string
  title: string
  synopsis: string
  genres: string[]
  moods: string[]
  characters: { name: string; description: string }[]
  pages: number
  panels: number
  minutes: number
}

export default function Preview({ id, title, onClose, onReplay }: { id: string; title: string; onClose: () => void; onReplay: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [data, setData] = useState<PreviewData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    pauseGestures() // the nod that opened it mustn't press Play
    let alive = true
    fetch(`/api/comics/${id}/preview`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [id])

  const meta = data && `${data.minutes} min · ${data.pages} page${data.pages === 1 ? '' : 's'} · ${data.panels} panels`

  return (
    <dialog ref={ref} className="preview" onClose={() => (pauseGestures(), onClose())} aria-labelledby="preview-title">
      <Teaser data={data} waiting={failed ? undefined : 'Writing a spoiler-free synopsis…'} />

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
