import { useEffect, useState, type CSSProperties } from 'react'
import { MAX_PANEL_W, PAD, framePanel, paddedBox } from './camera'
import type { Page } from './types'

// End of the comic: starting from exactly what the reader shows (sharp last panel over the dimmed,
// blurred page), the camera pulls back to the whole last page, and the other pages slide in beside
// it as a carousel.

type Size = { w: number; h: number }
type Props = {
  pages: Page[]
  sizes: Record<string, Size>
  last: { pageId: string; bbox: [number, number, number, number] }
  onRestart: () => void
  onClose: () => void
}

const GAP = 56
const MARGIN_Y = 96 // room for the title above and the buttons below

export default function Finale({ pages, sizes, last, onRestart, onClose }: Props) {
  const shown = pages.filter((p) => p.image && sizes[p.id])
  const lastIndex = Math.max(0, shown.findIndex((p) => p.id === last.pageId))
  const [current, setCurrent] = useState(lastIndex)
  const [open, setOpen] = useState(false) // false: framed like the reader; true: the full carousel
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })

  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    // Two frames in the reader's framing, then let the transition pull back.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)))
    return () => {
      window.removeEventListener('resize', on)
      cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setCurrent((c) => Math.min(shown.length - 1, c + 1))
      else if (e.key === 'ArrowLeft') setCurrent((c) => Math.max(0, c - 1))
      else if (e.key === 'Escape') onClose()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true) // ahead of the reader's own shortcuts
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shown.length, onClose])

  // Carousel: every page at the same height, side by side, the current one centred.
  const height = vp.h - 2 * MARGIN_Y
  const widths = shown.map((p) => (sizes[p.id].w / sizes[p.id].h) * height)
  const lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, w) => a + w + GAP, 0))
  const shift = vp.w / 2 - (lefts[current] + widths[current] / 2)

  // Closed: the reader's exact frame (last panel in its box, every page beside it, blurred and dim).
  const boxW = Math.min(vp.w - 2 * PAD, MAX_PANEL_W)
  const framed = framePanel(shown, sizes, last, boxW, vp.h - 2 * PAD, { x: vp.w / 2, y: vp.h / 2 })

  const place = (p: Page, i: number): CSSProperties => {
    const size = sizes[p.id]
    if (!open) {
      const at = framed.get(p.id) ?? { x: 0, y: 0, s: 1 }
      return { transform: `translate(${at.x}px, ${at.y}px) scale(${at.s})`, '--blur': `${7 / at.s}px` } as CSSProperties
    }
    const s = height / size.h
    return {
      transform: `translate(${shift + lefts[i]}px, ${MARGIN_Y}px) scale(${s})`,
      opacity: i === current ? 1 : 0.45,
    }
  }
  const [px1, py1, px2, py2] = paddedBox(last.bbox, sizes[last.pageId] ?? { w: 1, h: 1 })

  const lastSize = sizes[shown[lastIndex]?.id]

  return (
    <div className={`finale${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label="The end: all pages">
      {shown.map((p, i) => (
        <button
          key={p.id}
          type="button"
          className={`finale-page${i === current ? ' current' : ''}${i === lastIndex ? ' last' : ''}`}
          style={{ width: sizes[p.id].w, height: sizes[p.id].h, ...place(p, i) }}
          onClick={() => setCurrent(i)}
          aria-label={`Page ${i + 1} of ${shown.length}`}
          aria-current={i === current ? 'true' : undefined}
          tabIndex={open ? 0 : -1}
        >
          <img src={p.image} alt="" />
          {i === lastIndex && lastSize && (
            // The sharp last panel the reader was showing; it dissolves into the page as the camera pulls back.
            <span
              className="finale-panel"
              style={{
                left: px1,
                top: py1,
                width: px2 - px1,
                height: py2 - py1,
                backgroundImage: `url("${p.image}")`,
                backgroundSize: `${lastSize.w}px ${lastSize.h}px`,
                backgroundPosition: `${-px1}px ${-py1}px`,
              }}
            />
          )}
        </button>
      ))}

      <header className="finale-top">
        <h2>The end</h2>
        {shown.length > 1 && (
          <p>
            Page {current + 1} of {shown.length}
          </p>
        )}
      </header>

      <div className="finale-bar">
        {shown.length > 1 && (
          <button type="button" className="btn" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0} aria-label="Previous page">
            ←
          </button>
        )}
        <button type="button" className="btn btn-accent" onClick={onRestart}>
          ↺ Read again
        </button>
        <a className="btn" href="./">
          Back to comics
        </a>
        {shown.length > 1 && (
          <button type="button" className="btn" onClick={() => setCurrent((c) => Math.min(shown.length - 1, c + 1))} disabled={current === shown.length - 1} aria-label="Next page">
            →
          </button>
        )}
      </div>
    </div>
  )
}
