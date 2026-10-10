import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Finale from './Finale'
import HeartMeter from './face/HeartMeter'
import PageView from './PageView'
import SettingsPanel from './SettingsPanel'
import { MAX_PANEL_W, PAD, framePanel } from './camera'
import { useSettings } from './settings'
import type { Comic, Page, Panel } from './types'
import { usePanelAudio } from './usePanelAudio'

type Props = {
  comic: Comic
  languages: Record<string, string> | null
  translating: string | null
  startAt?: string // panel id to open on, with no entrance animation (hand-off from the processing view)
  pageSizes?: Record<string, { w: number; h: number }> // known page sizes, so the camera draws on frame one
  onReady?: () => void // first frame painted (the processing view waits for this before fading)
  liveJob?: string // the comic is still being made: refresh it and wait on panels that aren't voiced yet
}

// Okabe-Ito: distinguishable with every common colour-vision deficiency. Names are always shown too.
const SPEAKER_COLORS = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#CC79A7', '#D55E00', '#0072B2']

const CAPTION_SPACE = 150
const OVERVIEW_HOLD_MS = 2500 // when playing, how long the whole page shows before zooming in
const BLEED = 40 // .camera extends this far past the viewport so its blur has no hard edge

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return vp
}

// Natural sizes of the full page images, so the background "camera" can line up with each panel.
function usePageSizes(pages: Page[], known: Record<string, { w: number; h: number }> = {}) {
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>(known)
  useEffect(() => {
    pages.forEach((page) => {
      if (!page.image || sizes[page.id]) return
      const img = new Image()
      img.onload = () => setSizes((s) => ({ ...s, [page.id]: { w: img.naturalWidth, h: img.naturalHeight } }))
      img.src = page.image
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages])
  return sizes
}

// One panel per screen. Scroll snapping does the paging; an IntersectionObserver tracks the active
// panel (-1 = the title card). Behind the panels, the whole page glides like a camera to the active one.
export default function Reader({ comic, languages, translating, startAt, pageSizes: knownSizes, onReady, liveJob }: Props) {
  const entries = useMemo(
    () => comic.pages.flatMap((page) => page.panels.map((panel) => ({ panel, page }))),
    [comic],
  )
  const panels = entries.map((e) => e.panel)
  const startIndex = startAt ? entries.findIndex((e) => e.panel.id === startAt) : -1
  // Whole-page stops: one before the first panel of each page (that has a page image), numbered
  // "first panel index − 0.5". The reader holds on them while playing, then zooms into the panel.
  const pageStops = useMemo(
    () => entries.flatMap((e, i) => (e.page.image && (i === 0 || entries[i - 1].page.id !== e.page.id) ? [i - 0.5] : [])),
    [entries],
  )
  const isPageStop = (a: number) => a % 1 !== 0
  const pageOf = (stop: number) => entries[stop + 0.5].page.id
  // Arriving from the processing view lands on the whole start page, which then zooms into its panel.
  const startStop = startIndex >= 0 && pageStops.includes(startIndex - 0.5) ? startIndex - 0.5 : startIndex
  const [active, setActive] = useState(startStop)
  // Arriving from the processing view: the first frame must match its last one exactly, so no fade-ins.
  const [arrived, setArrived] = useState(startIndex >= 0)
  const pageRefs = useRef(new Map<number, HTMLElement | null>())
  const endRef = useRef<HTMLElement | null>(null)
  const refs = useRef<(HTMLElement | null)[]>([])
  const cover = useRef<HTMLElement | null>(null)
  const [playing, setPlaying] = useState(false)
  // Opt-in like every accessibility feature. Narration plays the recorded narrator: an existing
  // ElevenLabs recording where there is one, edge-tts otherwise.
  const [audiobook, setAudiobook] = useState(false)
  const toggleAudiobook = () => setAudiobook((on) => !on)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings] = useSettings()
  const vp = useViewport()
  const pageSizes = usePageSizes(comic.pages, knownSizes)

  // The visible "shot": incoming panel plus the outgoing one, moving the way the panels sit on the page.
  const [shot, setShot] = useState<Shot>({ cur: isPageStop(startStop) ? -1 : startStop, prev: null, dx: 0, dy: 0 })
  useLayoutEffect(() => {
    if (startIndex >= 0) {
      const el = isPageStop(startStop) ? pageRefs.current.get(startStop) : refs.current[startIndex]
      el?.scrollIntoView({ behavior: 'instant' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (active === shot.cur || isPageStop(active) || active >= panels.length) return
    setArrived(false)
    const d = Math.min(vp.w, vp.h) * 0.6
    const [vx, vy] = direction(entries[shot.cur], entries[active], shot.cur, active)
    setShot({ cur: active, prev: shot.cur >= 0 ? shot.cur : null, dx: vx * d, dy: vy * d })
    const t = setTimeout(() => setShot((s) => (s.cur === active ? { ...s, prev: null } : s)), 750)
    // Warm the next panels so they never pop in.
    entries.slice(active + 1, active + 3).forEach((e) => (new Image().src = e.panel.image))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const speakerColor = useMemo(() => {
    const m = new Map<string, string>()
    comic.characters.forEach((c, i) => m.set(c.id, SPEAKER_COLORS[i % SPEAKER_COLORS.length]))
    return m
  }, [comic.characters])

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index))
        }
      },
      { threshold: 0.6 },
    )
    if (cover.current) io.observe(cover.current)
    pageRefs.current.forEach((el) => el && io.observe(el))
    if (endRef.current) io.observe(endRef.current)
    refs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [panels.length, pageStops])

  // The end screen is the last stop, one past the last panel: reachable by scrolling as well as by playing.
  const END = panels.length
  const order = [-1, ...entries.flatMap((_, i) => (pageStops.includes(i - 0.5) ? [i - 0.5, i] : [i])), END]
  const goTo = (i: number) => {
    const el =
      isPageStop(i) ? pageRefs.current.get(i)
      : i < 0 ? cover.current
      : i >= panels.length ? endRef.current
      : refs.current[i]
    // Long jumps (Read again, Home, End) go straight there instead of scrolling past every panel,
    // which would briefly start each one's audio on the way.
    const far = Math.abs(order.indexOf(i) - order.indexOf(active)) > 2
    el?.scrollIntoView({ behavior: far ? 'instant' : 'smooth' })
  }
  // Reading order of the stops: title card, then for each page its whole-page stop and its panels.
  const step = (dir: number) => {
    const k = order.indexOf(active)
    goTo(order[Math.max(0, Math.min(order.length - 1, k + dir))])
  }

  const togglePlay = () => {
    if (!playing && active === -1) goTo(order[1]) // start from the first page, not the title card
    setPlaying((v) => !v)
  }

  // Playing on a whole-page stop: let the page be seen for a moment, then zoom into its first panel.
  useEffect(() => {
    if (!playing || !isPageStop(active)) return
    const t = setTimeout(() => goTo(active + 0.5), OVERVIEW_HOLD_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active])

  // The whole-page view and its camera moves: zoom in from a page to its panel, out from a panel to a page.
  const [pv, setPv] = useState<{ zoomed: boolean; centerId: string; focusIndex: number } | null>(
    isPageStop(active) ? { zoomed: false, centerId: pageOf(active), focusIndex: active + 0.5 } : null,
  )
  const prevActive = useRef(active)
  useEffect(() => {
    const prev = prevActive.current
    prevActive.current = active
    if (prev === active) return
    if (isPageStop(active)) {
      const target = { centerId: pageOf(active), focusIndex: active + 0.5 }
      if (prev < 0 || isPageStop(prev)) return setPv({ zoomed: false, ...target })
      // From a panel (the end of the previous page, or going back): start framed on it, then pull out
      // to the whole page, sliding along the strip of pages if it's a different one.
      setPv({ zoomed: true, centerId: target.centerId, focusIndex: prev })
      const r = requestAnimationFrame(() =>
        requestAnimationFrame(() => setPv((p) => p && { ...p, zoomed: false, focusIndex: target.focusIndex })),
      )
      return () => cancelAnimationFrame(r)
    }
    if (isPageStop(prev) && active >= 0) {
      setPv((p) => ({ centerId: p?.centerId ?? entries[active].page.id, focusIndex: active, zoomed: true }))
      const t = setTimeout(() => setPv(null), 1700) // the reader underneath now shows exactly this frame
      return () => clearTimeout(t)
    }
    setPv(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Still being made: refresh the comic in place (same objects, so nothing that's playing restarts) and
  // know which panels are fully voiced. Playback waits on a panel that isn't, then carries on by itself.
  const [live, setLive] = useState<{ ready: Set<string>; total: number; done: boolean } | null>(
    liveJob ? { ready: new Set(), total: panels.length, done: false } : null,
  )
  const [, setLiveTick] = useState(0)
  useEffect(() => {
    if (!liveJob) return
    let stop = false
    ;(async () => {
      while (!stop) {
        try {
          const r = await fetch(`/api/jobs/${liveJob}/comic`)
          if (r.ok) {
            const d = await r.json()
            mergeLive(comic, d.comic)
            setLive({ ready: new Set(d.ready), total: d.total, done: d.done })
            setLiveTick((t) => t + 1)
            if (d.done) return
          }
        } catch {
          // network hiccup: try again on the next tick
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
    })()
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveJob])
  const voiced = (p: Panel | undefined) => !p || !live || live.done || live.ready.has(p.id) || (live.ready.size === 0 && !!p.scene)
  const waiting = playing && active >= 0 && active < panels.length && !voiced(panels[active])

  // Playing always turns the pages; audiobook mode only decides whether the narrator speaks.
  const caption = usePanelAudio(
    panels[active],
    comic.characters,
    playing && !waiting,
    audiobook,
    () => {
      // Next stop: the next panel, or the next page's whole-page view first.
      if (active + 1 < panels.length) setTimeout(() => step(1), 600)
      else {
        // End of the comic: a beat on the last panel, then pull back to the full page(s).
        setPlaying(false)
        setTimeout(() => goTo(END), 600)
      }
    },
    () => setPlaying(false),
  )

  // Arriving on the whole-page view: tell the processing view once the page is painted, so it can fade.
  useEffect(() => {
    if (startIndex < 0 || !isPageStop(startStop) || !onReady) return
    const center = comic.pages.find((p) => p.id === pageOf(startStop))
    if (!center?.image) return onReady()
    const img = new Image()
    img.onload = img.onerror = () => requestAnimationFrame(() => requestAnimationFrame(() => onReady()))
    img.src = center.image
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Arriving from the processing view: start playing as the curtain lifts. The click that started
  // the upload/replay was in this same page session, so the browser allows the audio.
  useEffect(() => {
    if (startIndex < 0) return
    const t = setTimeout(() => setPlaying(true), 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 's' || e.key === 'S') {
        setSettingsOpen(true)
        return
      }
      if (e.key === 'p' || e.key === 'P' || e.key === 'l' || e.key === 'L') {
        togglePlay()
        return
      }
      if (e.key === 'a' || e.key === 'A') {
        toggleAudiobook()
        return
      }
      // Space activates focused buttons; don't also page.
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) return
      const keys: Record<string, number> = {
        ArrowDown: 1, ArrowRight: 1, PageDown: 1, ' ': 1,
        ArrowUp: -1, ArrowLeft: -1, PageUp: -1,
      }
      if (e.key in keys) {
        e.preventDefault()
        step(e.shiftKey && e.key === ' ' ? -1 : keys[e.key])
      } else if (e.key === 'Home') {
        e.preventDefault()
        goTo(-1)
      } else if (e.key === 'End') {
        e.preventDefault()
        goTo(END)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Panel display box (matches .frame) and the camera that lines the page up behind it.
  // While captions show, the panel shrinks into the space above them instead of being covered.
  const reserved = caption && settings.captions ? CAPTION_SPACE : 0
  const boxW = Math.min(vp.w - 2 * PAD, MAX_PANEL_W)
  const boxH = vp.h - 2 * PAD - reserved
  const center = { x: vp.w / 2, y: PAD + boxH / 2 }
  const current = entries[Math.min(Math.max(active, 0), panels.length - 1)]
  // The backdrop: every page side by side, framed so the active panel's page sits behind the panel.
  const placements = current?.panel.bbox
    ? framePanel(comic.pages, pageSizes, { pageId: current.page.id, bbox: current.panel.bbox }, boxW, boxH, center)
    : new Map()
  const lastEntry = entries[entries.length - 1]
  const pvFocus = pv && entries[pv.focusIndex]?.panel.bbox
    ? { pageId: entries[pv.focusIndex].page.id, bbox: entries[pv.focusIndex].panel.bbox! }
    : null

  const first = entries[0]
  const coverImage = first?.page.image || first?.panel.image

  return (
    <main
      className={`reader${arrived ? ' arrived' : ''}`}
      aria-label={comic.title}
      lang={comic.lang && comic.lang !== 'original' ? comic.lang : undefined}
    >
      {placements.size > 0 && (
        <div className="camera" aria-hidden="true">
          {comic.pages.map((p) => {
            const at = placements.get(p.id)
            const size = pageSizes[p.id]
            if (!at || !size || !p.image) return null
            return (
              <div
                key={p.id}
                className="camera-page"
                style={{
                  width: size.w,
                  height: size.h,
                  backgroundImage: `url("${p.image}")`,
                  transform: `translate(${at.x + BLEED}px, ${at.y + BLEED}px) scale(${at.s})`,
                }}
              />
            )
          })}
        </div>
      )}
      {active === END && lastEntry?.panel.bbox && (
        <Finale
          pages={comic.pages}
          sizes={pageSizes}
          last={{ pageId: lastEntry.page.id, bbox: lastEntry.panel.bbox }}
          onClose={() => goTo(panels.length - 1)}
          onRestart={() => {
            goTo(order[1]) // the first page, whole, then on into panel 1
            setPlaying(true)
          }}
        />
      )}

      <div className="topbar" aria-hidden="true">
        <span style={{ width: `${(Math.min(panels.length, Math.max(0, active + 1)) / panels.length) * 100}%` }} />
      </div>

      <section ref={cover} data-index={-1} className="cover" aria-label="Title">
        {coverImage && <img className="cover-art" src={coverImage} alt="" />}
        <div className="cover-text">
          <h1>{comic.title}</h1>
          <p>
            {panels.length} panels · {comic.characters.length} voices
          </p>
          <button type="button" className="cover-listen" onClick={togglePlay}>
            ▶ Play from the start
          </button>
          <p className="scroll-cue" aria-hidden="true">
            Scroll <span />
          </p>
        </div>
      </section>

      {/* Scroll track: one snap point per panel. What you see is drawn on the stage below. */}
      {entries.map(({ panel }, i) => (
        <Fragment key={panel.id}>
          {pageStops.includes(i - 0.5) && (
            <section
              ref={(el) => { pageRefs.current.set(i - 0.5, el) }}
              data-index={i - 0.5}
              className="panel"
              aria-label={`Page ${comic.pages.findIndex((p) => p.id === entries[i].page.id) + 1}, whole page`}
            >
              <p className="sr-only">The whole page.</p>
            </section>
          )}
          <section
            ref={(el) => { refs.current[i] = el }}
            data-index={i}
            className="panel"
            aria-label={`Panel ${i + 1} of ${panels.length}`}
          >
            <p className="sr-only">{panel.scene}</p>
          </section>
        </Fragment>
      ))}
      <section ref={endRef} data-index={panels.length} className="panel" aria-label="The end">
        <p className="sr-only">The end. All pages.</p>
      </section>

      <div className="stage" aria-hidden="true" style={{ paddingBottom: PAD + reserved }}>
        {[shot.prev, shot.cur].map((i, n) =>
          i === null || i < 0 ? null : (
            <div
              key={`${n ? 'in' : 'out'}-${i}`}
              className={`shot ${n ? 'in' : 'out'}`}
              style={{ '--dx': `${shot.dx}px`, '--dy': `${shot.dy}px` } as CSSProperties}
            >
              <div className="frame" style={{ width: boxW, height: boxH }}>
                <img
                  src={entries[i].panel.image}
                  onLoad={i === startIndex ? () => requestAnimationFrame(() => requestAnimationFrame(() => onReady?.())) : undefined}
                  alt=""
                  style={{ transformOrigin: DRIFT_ORIGINS[i % DRIFT_ORIGINS.length] }}
                />
              </div>
              {n === 1 && settings.emotions && entries[i].panel.emotionLabels.length > 0 && (
                <ul className="emotions">
                  {entries[i].panel.emotionLabels.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
      </div>

      {pv && (
        <PageView
          pages={comic.pages}
          sizes={pageSizes}
          centerId={pv.centerId}
          focus={pvFocus}
          zoomed={pv.zoomed}
          boxW={boxW}
          boxH={boxH}
          center={center}
          vp={vp}
        />
      )}

      {settings.heart && <HeartMeter comicId={comic.id} />}

      {waiting && (
        <p className="waiting-badge" role="status">
          <span aria-hidden="true" /> Preparing voices…
        </p>
      )}
      {live && !live.done && (
        <p className="live-chip" role="status">
          Preparing {live.ready.size}/{live.total}
        </p>
      )}

      <div className="controls" role="toolbar" aria-label="Reader controls">
        <button type="button" aria-pressed={playing} onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'} <kbd>P</kbd>
        </button>
        <button
          type="button"
          aria-pressed={audiobook}
          onClick={toggleAudiobook}
          title={audiobook ? 'Narrator describes each scene' : 'Dialogue and sound effects only'}
        >
          Audiobook {audiobook ? 'on' : 'off'} <kbd>A</kbd>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
          Settings <kbd>S</kbd>
        </button>
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        languages={languages}
        translating={translating}
      />
      {translating && !settingsOpen && (
        <p className="toast" role="status">
          {translating}
        </p>
      )}

      {caption && settings.captions && (
        <p
          key={caption.text}
          className={`caption${caption.speakerId ? '' : ' narrator'}`}
          style={{ '--speaker': speakerColor.get(caption.speakerId ?? '') ?? 'var(--fg)' } as CSSProperties}
          aria-hidden="true"
        >
          <strong>{caption.speaker}</strong> {caption.text}
        </p>
      )}

      <div className="progress" aria-hidden="true">
        {active >= panels.length
          ? 'The end'
          : isPageStop(active)
          ? `Page ${comic.pages.findIndex((p) => p.id === pageOf(active)) + 1}`
          : active < 0 ? 'Cover' : `${active + 1} / ${panels.length}`}
      </div>
      <div className="sr-only" aria-live="polite">
        {active >= 0 && (
          <>
            Panel {active + 1} of {panels.length}. {panels[active]?.scene}
            {settings.emotions && panels[active]?.emotionLabels.length
              ? ` Emotions: ${panels[active].emotionLabels.join(', ')}.`
              : ''}
          </>
        )}
      </div>
    </main>
  )
}

// Fill a still-being-made comic in place from a fresh copy. Objects keep their identity so playing audio
// doesn't restart, and links already held are kept (fresh ones are re-signed and would reload images).
function mergeLive(target: Comic, fresh: Comic) {
  target.characters.splice(0, target.characters.length, ...fresh.characters)
  const panelsById = new Map(target.pages.flatMap((p) => p.panels).map((p) => [p.id, p]))
  for (const fp of fresh.pages) {
    const tp = target.pages.find((p) => p.id === fp.id)
    if (!tp) {
      target.pages.push(fp)
      continue
    }
    tp.image ||= fp.image
    for (const f of fp.panels) {
      const t = panelsById.get(f.id)
      if (!t) {
        tp.panels.push(f)
        continue
      }
      t.image ||= f.image
      if (!t.scene && f.scene) {
        t.scene = f.scene
        t.characters = f.characters
        t.emotionLabels = f.emotionLabels
      }
      t.narration ||= f.narration
      t.narrationAudio ||= f.narrationAudio
      if (t.lines.length !== f.lines.length) t.lines = f.lines
      else t.lines.forEach((l, i) => (l.audio ||= f.lines[i].audio))
      const fs = f.sfx ?? []
      if ((t.sfx ?? []).length !== fs.length) t.sfx = fs
      else t.sfx?.forEach((x, i) => (x.audio ||= fs[i].audio))
    }
  }
}

const DRIFT_ORIGINS = ['30% 40%', '70% 35%', '50% 65%', '35% 60%', '65% 55%']

type Shot = { cur: number; prev: number | null; dx: number; dy: number }
type Entry = { panel: Panel; page: Page }

// Unit vector from the old panel to the new one, using their positions on the page, so the
// transition moves the way your eye does: sideways along a row, down to the next row.
// Across pages, or without a layout, it falls back to plain down/up.
function direction(from: Entry | undefined, to: Entry | undefined, a: number, b: number): [number, number] {
  const fallback: [number, number] = [0, b >= a ? 1 : -1]
  if (!from || !to || from.page.id !== to.page.id || !from.panel.bbox || !to.panel.bbox) return fallback
  const c = (bb: number[]) => [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]
  const [x1, y1] = c(from.panel.bbox)
  const [x2, y2] = c(to.panel.bbox)
  const len = Math.hypot(x2 - x1, y2 - y1)
  return len ? [(x2 - x1) / len, (y2 - y1) / len] : fallback
}
