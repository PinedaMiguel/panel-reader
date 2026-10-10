import type { CSSProperties } from 'react'
import { framePanel, pageStrip, paddedBox, type Size } from './camera'
import type { Page } from './types'

// The whole-page view in front of the reader: the page shown in full (neighbours dimmed beside it), and
// the camera move between that and a panel. Zoomed, it draws exactly the reader's frame (pages blurred
// and dim behind, the panel sharp in its box), so swapping to the reader underneath is invisible.

type Props = {
  pages: Page[]
  sizes: Record<string, Size>
  centerId: string // the page shown in full
  focus: { pageId: string; bbox: [number, number, number, number] } | null // the panel to zoom into
  zoomed: boolean
  boxW: number
  boxH: number
  center: { x: number; y: number }
  vp: { w: number; h: number }
}

export default function PageView({ pages, sizes, centerId, focus, zoomed, boxW, boxH, center, vp }: Props) {
  const shown = pages.filter((p) => p.image && sizes[p.id])
  const full = pageStrip(shown, sizes, centerId, vp)
  const framed = zoomed && focus ? framePanel(shown, sizes, focus, boxW, boxH, center) : null
  const crop = focus && sizes[focus.pageId] ? paddedBox(focus.bbox, sizes[focus.pageId]) : null

  return (
    <div className={`pageview${zoomed ? ' zoomed' : ''}`} aria-hidden="true">
      {shown.map((p) => {
        const at = (framed ?? full).get(p.id)
        if (!at) return null
        const size = sizes[p.id]
        const style = {
          width: size.w,
          height: size.h,
          transform: `translate(${at.x}px, ${at.y}px) scale(${at.s})`,
          opacity: zoomed || p.id === centerId ? 1 : 0.45,
          '--blur': `${7 / at.s}px`,
        } as CSSProperties
        return (
          <div key={p.id} className="pageview-page" style={style}>
            <div className="pageview-img" style={{ backgroundImage: `url("${p.image}")` }} />
            {crop && focus?.pageId === p.id && (
              <span
                className="pageview-panel"
                style={{
                  left: crop[0],
                  top: crop[1],
                  width: crop[2] - crop[0],
                  height: crop[3] - crop[1],
                  backgroundImage: `url("${p.image}")`,
                  backgroundSize: `${size.w}px ${size.h}px`,
                  backgroundPosition: `${-crop[0]}px ${-crop[1]}px`,
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
