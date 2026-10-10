import { useEffect, useState } from 'react'
import ColorFilters from './ColorFilters'
import Home, { type ProcessJob } from './Home'
import Processing from './Processing'
import GazeLayer from './face/GazeLayer'
import Reader from './Reader'
import { useSettings } from './settings'
import type { Comic } from './types'

// ?id=<id>       → comic processed by the API (translatable)
// ?comic=<name>  → static script in public/<name>/ (e.g. demo)
// neither        → home (upload, scan, shelf)
const parse = () => {
  const p = new URLSearchParams(location.search)
  return { id: p.get('id'), folder: p.get('comic') }
}

export default function App() {
  const [route, setRoute] = useState(parse)
  const { id, folder } = route
  const [settings] = useSettings()
  const lang = id ? settings.lang : 'original'
  const [comic, setComic] = useState<Comic | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [languages, setLanguages] = useState<Record<string, string> | null>(null)
  const [translating, setTranslating] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  // Set when the processing view hands a freshly loaded comic straight to the reader (no reload, no cut).
  const [handoff, setHandoff] = useState<{
    comic: Comic
    start: string
    sizes: Record<string, { w: number; h: number }>
    live?: string // job still finishing the comic in the background
  } | null>(null)

  // The processing visualization sits above everything. When it finishes, the reader mounts underneath
  // and the visualization fades only once the reader has painted its first frame: no black flash.
  const [processing, setProcessing] = useState<{ job: ProcessJob; leaving: boolean } | null>(null)
  const uncover = () => {
    setProcessing((p) => p && { ...p, leaving: true })
    setTimeout(() => setProcessing(null), 350)
  }
  useEffect(() => {
    if (!processing || !handoff) return
    const t = setTimeout(uncover, 3000) // safety net if the reader never reports ready
    return () => clearTimeout(t)
  }, [processing, handoff])

  useEffect(() => {
    const onPop = () => {
      setHandoff(null)
      setComic(null)
      setRoute(parse())
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const openComic = (c: Comic, start: string, sizes: Record<string, { w: number; h: number }>, live?: string) => {
    history.pushState(null, '', `?id=${c.id}`)
    setHandoff({ comic: c, start, sizes, live })
    setComic(c)
    setRoute({ id: c.id, folder: null })
  }

  useEffect(() => {
    if (id) fetch('/api/languages').then((r) => r.json()).then(setLanguages).catch(() => {})
  }, [id])

  useEffect(() => {
    if (!id && !folder) return
    if (handoff && handoff.comic.id === id && lang === 'original' && !reload) return // already loaded
    let cancelled = false
    let es: EventSource | null = null
    const url = id ? `/api/comics/${id}${lang !== 'original' ? `?lang=${lang}` : ''}` : `/${folder}/script.json`

    const translate = async () => {
      // Keep reading the current version while the translation is made.
      const name = languages?.[lang] ?? lang
      setTranslating(`Translating to ${name}…`)
      const body = new FormData()
      body.append('lang', lang)
      await fetch(`/api/comics/${id}/translations`, { method: 'POST', body })
      es = new EventSource(`/api/comics/${id}/events?lang=${lang}`)
      es.onmessage = (m) => {
        const p = JSON.parse(m.data)
        if (p.stage === 'done') {
          es?.close()
          setTranslating(null)
          if (!cancelled) setReload((n) => n + 1)
        } else if (p.stage === 'error') {
          es?.close()
          setTranslating(`Translation failed: ${p.error}`)
        } else {
          setTranslating(`Translating to ${name}: ${p.stage}${p.total ? ` (${p.done}/${p.total})` : '…'}`)
        }
      }
    }

    fetch(url)
      .then(async (r) => {
        if (r.status === 404 && id && lang !== 'original') {
          if (!comic) setComic(await (await fetch(`/api/comics/${id}`)).json())
          return translate()
        }
        if (!r.ok || !r.headers.get('content-type')?.includes('json')) throw new Error(`not found: ${url}`)
        const data = await r.json()
        if (!cancelled) {
          setComic(data)
          setTranslating(null)
        }
      })
      .catch((e) => setError(String(e)))

    return () => {
      cancelled = true
      es?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, folder, lang, reload])

  const overlay = processing && (
    <Processing
      job={processing.job.id}
      files={processing.job.files}
      title={processing.job.title}
      onFinish={openComic}
      onBack={() => setProcessing(null)}
      leaving={processing.leaving}
    />
  )

  let page
  if (!id && !folder) page = <Home onProcess={(job) => setProcessing({ job, leaving: false })} />
  else if (error) page = <p className="status">Could not load comic: {error}</p>
  else if (!comic) page = <p className="status">Loading…</p>
  else
    page = (
      <>
        <ColorFilters />
        <Reader
          comic={comic}
          languages={id ? languages : null}
          translating={translating}
          startAt={handoff?.comic.id === comic.id ? handoff.start : undefined}
          pageSizes={handoff?.comic.id === comic.id ? handoff.sizes : undefined}
          liveJob={handoff?.comic.id === comic.id ? handoff.live : undefined}
          onReady={processing ? uncover : undefined}
        />
      </>
    )
  return (
    <>
      {page}
      {overlay}
      {settings.gaze && <GazeLayer />}
    </>
  )
}
