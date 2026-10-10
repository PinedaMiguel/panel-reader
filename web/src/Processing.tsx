import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { framePanel } from './camera'
import type { Comic } from './types'

// Full-screen visualization of the pipeline: the page, Magi's panel boxes in reading order, the crops
// lining up, Gemini's cast and script, the voices, and the audio being recorded. It plays the job's
// event stream (live for new pages, a ~20 s replay for pages processed before) and ends with a camera
// zoom into the first panel that lands exactly on the reader's first frame.

type Box = { id: string; bbox: [number, number, number, number] }
type PageState = { id: string; url: string; w: number; h: number; boxes: Box[]; shown: number; cached: boolean }
type CastMember = { id: string; name: string; description: string; voice?: string }
type Script = { panel: string; narration: string; lines: { speaker: string; text: string }[]; emotions: string[]; sfx: string[] }
type Ev = { type: string; [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any

const STEPS = ['Panels', 'Reading order', 'Cast', 'Script', 'Voices', 'Audio'] as const
type Step = (typeof STEPS)[number] | 'Ready'

const preload = (src: string) =>
  new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = img.onerror = () => resolve()
    img.src = src
    setTimeout(resolve, 1500)
  })

// The API crops panels with 4 px of padding (api/src/api/panels.py crop()); the zoom must land on
// exactly that rectangle so the reader's first frame matches pixel for pixel.
const CROP_PAD = 4
const padded = (b: Box['bbox'], p: { w: number; h: number }): Box['bbox'] => [
  Math.max(0, b[0] - CROP_PAD), Math.max(0, b[1] - CROP_PAD), Math.min(p.w, b[2] + CROP_PAD), Math.min(p.h, b[3] + CROP_PAD),
]

const PAD = 16
const MAX_PANEL_W = 900

// Minimum on-screen time per event (ms): [live, cached replay]. Live runs are paced by the models anyway.
const PACE: Record<string, [number, number]> = {
  page: [900, 700],
  box: [260, 160],
  order: [700, 500],
  member: [320, 220],
  script: [900, 750],
  voices: [1400, 1100],
  audio: [600, 900],
  clip: [60, 0],
}

type Props = {
  job: string
  files: File[] // the uploaded pages, if any (a replay gets page images from the events)
  title?: string
  onFinish: (comic: Comic, startPanel: string, pageSizes: Record<string, { w: number; h: number }>) => void
  onBack: () => void
  leaving?: boolean // the reader is painted underneath: fade out
}

export default function Processing({ job, files, title, onFinish, onBack, leaving }: Props) {
  const [pages, setPages] = useState<PageState[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [cast, setCast] = useState<CastMember[]>([])
  const [script, setScript] = useState<Script | null>(null)
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const [audioDone, setAudioDone] = useState<Set<string>>(new Set())
  const [recording, setRecording] = useState(false)
  const [step, setStep] = useState<Step>('Panels')
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<{ box: Box; page: PageState } | null>(null)
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  const skip = useRef(false)
  const currentRef = useRef<string | null>(null)
  currentRef.current = current
  // Blob links for the uploaded pages. Created and revoked by the same effect, so React's dev-mode
  // double mount can't hand the director links that were already revoked.
  const urls = useRef<string[]>([])
  useEffect(() => {
    const made = files.map((f) => URL.createObjectURL(f))
    urls.current = made
    return () => made.forEach(URL.revokeObjectURL)
  }, [files])
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // The director: events are queued as they arrive and applied one at a time with a minimum duration.
  useEffect(() => {
    const queue: Ev[] = []
    let wake: (() => void) | null = null
    let cancelled = false
    let isCached = false
    const es = new EventSource(`/api/jobs/${job}/events`)
    es.onmessage = (m) => {
      queue.push(JSON.parse(m.data))
      wake?.()
    }
    es.onerror = () => es.close() // the stream closes itself when the job ends

    const next = () =>
      new Promise<Ev>((resolve) => {
        const take = () => {
          if (!queue.length) return void (wake = take)
          wake = null // a stale waker must never consume the next event
          resolve(queue.shift()!)
        }
        take()
      })
    const wait = (kind: string) => {
      const ms = skip.current ? 0 : PACE[kind][isCached ? 1 : 0]
      return new Promise((r) => setTimeout(r, ms))
    }
    const loadSize = (url: string) =>
      new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve({ w: 1000, h: 1500 })
        img.src = url
      })

    const pagesById = new Map<string, PageState>()
    ;(async () => {
      for (;;) {
        const ev = await next()
        if (cancelled) return
        switch (ev.type) {
          case 'start':
            isCached = ev.cached === ev.pages
            setCached(isCached)
            break
          case 'page': {
            const url = ev.upload != null && urls.current[ev.upload] ? urls.current[ev.upload] : ev.image
            const size = await loadSize(url)
            const p: PageState = { id: ev.page, url, ...size, boxes: [], shown: 0, cached: ev.cached }
            pagesById.set(p.id, p)
            setPages([...pagesById.values()])
            setCurrent(p.id)
            setStep('Panels')
            await wait('page')
            break
          }
          case 'panels': {
            const p = pagesById.get(ev.page)!
            p.boxes = ev.panels
            for (let i = 1; i <= p.boxes.length; i++) {
              p.shown = i
              setPages([...pagesById.values()])
              await wait('box')
            }
            setStep('Reading order')
            await wait('order')
            break
          }
          case 'cast':
            setStep('Cast')
            for (const c of ev.characters as CastMember[]) {
              setCast((all) => (all.some((x) => x.id === c.id) ? all : [...all, c]))
              await wait('member')
            }
            break
          case 'script': {
            setStep('Script')
            const owner = [...pagesById.values()].find((p) => p.boxes.some((b) => b.id === ev.panel))
            if (owner) setCurrent(owner.id)
            setActivePanel(ev.panel)
            setScript(ev as unknown as Script)
            await wait('script')
            break
          }
          case 'voices':
            setStep('Voices')
            setScript(null)
            setActivePanel(null)
            setCast(ev.characters)
            await wait('voices')
            break
          case 'audio':
            setStep('Audio')
            setRecording(ev.total > 0)
            setAudioDone(new Set(ev.cached))
            await wait('audio')
            break
          case 'clip':
            setActivePanel(ev.panel)
            if (ev.done === ev.total) setRecording(false)
            setAudioDone((s) => new Set(s).add(ev.panel))
            await wait('clip')
            break
          case 'done': {
            setStep('Ready')
            setRecording(false)
            es.close()
            await handOff(ev.comic, ev.start, pagesById)
            return
          }
          case 'error':
            setError(ev.message)
            es.close()
            return
        }
      }
    })()

    // Load the finished comic, then zoom the camera into the first panel and give the reader the stage.
    async function handOff(comicId: string, start: string, byId: Map<string, PageState>) {
      const comic: Comic = await (await fetch(`/api/comics/${comicId}`)).json()
      const startPanel = comic.pages.flatMap((p) => p.panels).find((p) => p.id === start)
      const page = [...byId.values()].find((p) => p.boxes.some((b) => b.id === start))
      // Warm everything the reader's first frame draws (fresh signed links), so nothing pops in after the cut.
      const startPage = comic.pages.find((p) => p.panels.some((x) => x.id === start))
      await Promise.all([startPanel && preload(startPanel.image), startPage?.image && preload(startPage.image)])
      const box = page?.boxes.find((b) => b.id === start)
      if (page && box && !cancelled) {
        if (currentRef.current !== page.id) {
          // Multi-page comics: glide back to the page the reader starts on, pause, then zoom.
          setActivePanel(null)
          setCurrent(page.id)
          await new Promise((r) => setTimeout(r, skip.current ? 600 : 1300))
        }
        setActivePanel(box.id)
        await new Promise((r) => setTimeout(r, skip.current ? 0 : 350))
        setZoom({ box, page })
        await new Promise((r) => setTimeout(r, skip.current ? 900 : 1900)) // 1.6 s camera move + a beat
      }
      const sizes = Object.fromEntries([...byId.values()].map((p) => [p.id, { w: p.w, h: p.h }]))
      if (!cancelled) onFinish(comic, start, sizes)
    }

    return () => {
      cancelled = true
      es.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job])

  const page = pages.find((p) => p.id === current)
  const strip = pages.flatMap((p) => p.boxes.slice(0, p.shown).map((b) => ({ ...b, page: p })))
  const number = new Map(strip.map((s, i) => [s.id, i + 1]))
  const stepIndex = step === 'Ready' ? STEPS.length : STEPS.indexOf(step as (typeof STEPS)[number])

  // Page placement: fitted into the stage area, or (during the hand-off) the reader's camera position.
  const area = { x: 24, y: 88, w: vp.w - (vp.w > 900 ? 420 : 48), h: vp.h - (vp.w > 900 ? 88 + 150 : 88 + 330) }
  const currentIndex = Math.max(0, pages.findIndex((p) => p.id === current))
  // During the zoom every page takes its place in the reader's page strip, so the cut is invisible.
  const pageStrip = zoom
    ? framePanel(
        pages.map((p) => ({ id: p.id, panels: [] })),
        Object.fromEntries(pages.map((p) => [p.id, { w: p.w, h: p.h }])),
        { pageId: zoom.page.id, bbox: zoom.box.bbox },
        Math.min(vp.w - 2 * PAD, MAX_PANEL_W),
        vp.h - 2 * PAD,
        { x: vp.w / 2, y: vp.h / 2 },
      )
    : null
  const place = (p: PageState, k: number): CSSProperties => {
    const at = pageStrip?.get(p.id)
    if (at) {
      return { transform: `translate(${at.x}px, ${at.y}px) scale(${at.s})`, '--blur': `${7 / at.s}px` } as CSSProperties
    }
    // Pages sit side by side; the current one is centred and its neighbours wait just off-stage.
    const s = Math.min(area.w / p.w, area.h / p.h)
    const shift = (k - currentIndex) * (area.w + 160)
    return {
      transform: `translate(${area.x + (area.w - p.w * s) / 2 + shift}px, ${area.y + (area.h - p.h * s) / 2}px) scale(${s})`,
      opacity: k === currentIndex && !(zoom && zoom.page.id !== p.id) ? 1 : 0,
    }
  }

  const crop = (b: Box, p: PageState, height: number): CSSProperties => {
    const [x1, y1, x2, y2] = b.bbox
    const s = height / (y2 - y1)
    return {
      width: (x2 - x1) * s,
      height,
      backgroundImage: `url("${p.url}")`,
      backgroundSize: `${p.w * s}px ${p.h * s}px`,
      backgroundPosition: `${-x1 * s}px ${-y1 * s}px`,
    }
  }

  return (
    <div
      className={`processing${zoom ? ' zooming' : ''}${leaving ? ' leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Making the comic readable"
    >
      <header className="proc-top">
        <h1>{cached ? 'How this comic was read' : 'Making it readable'}{title ? `: ${title}` : ''}</h1>
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
              {s}
            </li>
          ))}
        </ol>
        {cached && <span className="proc-badge">Replay · no AI calls</span>}
        <button type="button" className="btn" onClick={() => (skip.current = true)} disabled={!!zoom || !!error}>
          Skip
        </button>
      </header>

      {pages.map((page, k) => (
        <div
          key={page.id}
          className="proc-page"
          style={{ width: page.w, height: page.h, ...place(page, k) }}
          aria-hidden={page.id !== current}
        >
          <img src={page.url} alt="" />
          {page.boxes.slice(0, page.shown).map((b) => {
            const isZoom = zoom?.box.id === b.id
            const [x1, y1, x2, y2] = isZoom ? padded(b.bbox, page) : b.bbox
            return (
              <div
                key={b.id}
                className={`proc-box${activePanel === b.id ? ' active' : ''}${audioDone.has(b.id) ? ' voiced' : ''}${isZoom ? ' zoom-target' : ''}`}
                style={{
                  left: x1, top: y1, width: x2 - x1, height: y2 - y1,
                  ...(isZoom ? { backgroundImage: `url("${page.url}")`, backgroundPosition: `${-x1}px ${-y1}px`, backgroundSize: `${page.w}px ${page.h}px` } : {}),
                }}
              >
                <span className="proc-num" style={{ transform: `scale(${Math.max(1, page.w / 900)})` }}>
                  {number.get(b.id)}
                </span>
              </div>
            )
          })}
        </div>
      ))}

      <aside className="proc-side" aria-live="polite">
        {error ? (
          <section>
            <h2>Something went wrong</h2>
            <p>{error}</p>
            <button type="button" className="btn btn-accent" onClick={onBack}>
              Back
            </button>
          </section>
        ) : (
          <>
            {script && (
              <section key={script.panel} className="proc-script">
                <h2>Panel {number.get(script.panel)}</h2>
                {script.narration && <p className="narr">{script.narration}</p>}
                {script.lines.map((l, i) => (
                  <p key={i} className="line">
                    <strong>{l.speaker}</strong> {l.text}
                  </p>
                ))}
                {(script.emotions.length > 0 || script.sfx.length > 0) && (
                  <p className="tags">
                    {script.emotions.map((e) => <span key={e}>{e}</span>)}
                    {script.sfx.map((e) => <span key={e} className="sfx">🔊 {e}</span>)}
                  </p>
                )}
              </section>
            )}
            <section>
              <h2>Cast {cast.length > 0 && <small>{cast.length}</small>}</h2>
              {!cast.length && <p className="hint">{page ? 'Gemini is looking for characters…' : 'Opening the page…'}</p>}
              <ul className="proc-cast">
                {cast.map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong>
                    {c.voice ? <span className="voice">🎙 {c.voice}</span> : <span className="desc">{c.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
            {step === 'Audio' && (
              <section>
                <h2>Audio</h2>
                <p className={`wave${recording ? ' live' : ''}`} aria-hidden="true">
                  {Array.from({ length: 18 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 60}ms` }} />)}
                </p>
                <p className="hint">
                  {audioDone.size} of {strip.length} panels voiced{recording ? ': recording voices (ElevenLabs) and narrator (edge-tts)…' : ''}
                </p>
              </section>
            )}
            {step === 'Script' && !script && <p className="hint">Gemini is writing the script…</p>}
          </>
        )}
      </aside>

      <ol className="proc-strip" aria-label="Panels in reading order">
        {strip.map((s) => (
          <li key={s.id} className={`${activePanel === s.id ? 'active' : ''}${audioDone.has(s.id) ? ' voiced' : ''}`}>
            <span className="thumb" style={crop(s, s.page, 64)} />
            <span className="n">{number.get(s.id)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
