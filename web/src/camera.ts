import type { Page } from './types'

// Where each page sits on screen when the "camera" frames one panel: the panel's page is scaled so the
// panel fills the reader's panel box at the centre of the screen, and the other pages line up beside
// it at the same height, like a strip of pages on a table. Shared by the reader's backdrop and the
// end-of-comic zoom-out so both start from the same picture.

export type Size = { w: number; h: number }
export type Placement = { x: number; y: number; s: number }

export const PAD = 16
export const MAX_PANEL_W = 900
export const CROP_PAD = 4 // the API crops panels with 4 px padding (api/src/api/panels.py)
export const PAGE_GAP = 48 // between neighbouring pages, in screen px

export function paddedBox(b: [number, number, number, number], size: Size): [number, number, number, number] {
  return [
    Math.max(0, b[0] - CROP_PAD), Math.max(0, b[1] - CROP_PAD),
    Math.min(size.w, b[2] + CROP_PAD), Math.min(size.h, b[3] + CROP_PAD),
  ]
}

export function framePanel(
  pages: Page[],
  sizes: Record<string, Size>,
  focus: { pageId: string; bbox: [number, number, number, number] },
  boxW: number,
  boxH: number,
  center: { x: number; y: number },
): Map<string, Placement> {
  const out = new Map<string, Placement>()
  const i0 = pages.findIndex((p) => p.id === focus.pageId)
  const size0 = sizes[focus.pageId]
  if (i0 < 0 || !size0) return out
  const [x1, y1, x2, y2] = paddedBox(focus.bbox, size0)
  const s = Math.min(boxW / (x2 - x1), boxH / (y2 - y1))
  const x0 = center.x - ((x1 + x2) / 2) * s
  const y0 = center.y - ((y1 + y2) / 2) * s
  const height = size0.h * s
  out.set(focus.pageId, { x: x0, y: y0, s })

  // Pages after the focus page, left to right…
  let x = x0 + size0.w * s + PAGE_GAP
  for (const p of pages.slice(i0 + 1)) {
    const size = sizes[p.id]
    if (!size) break
    const k = height / size.h
    out.set(p.id, { x, y: y0, s: k })
    x += size.w * k + PAGE_GAP
  }
  // …and before it, right to left.
  x = x0 - PAGE_GAP
  for (const p of pages.slice(0, i0).reverse()) {
    const size = sizes[p.id]
    if (!size) break
    const k = height / size.h
    x -= size.w * k
    out.set(p.id, { x, y: y0, s: k })
    x -= PAGE_GAP
  }
  return out
}

// Whole pages side by side at one height, with `centerId` centred on screen: the "page view"
// (before panel 1, the end of the visualization, the end of the comic).
export function pageStrip(
  pages: Page[],
  sizes: Record<string, Size>,
  centerId: string,
  vp: { w: number; h: number },
  marginY = 64,
  gap = 56,
): Map<string, Placement> {
  const out = new Map<string, Placement>()
  const shown = pages.filter((p) => sizes[p.id])
  const ci = shown.findIndex((p) => p.id === centerId)
  if (ci < 0) return out
  const height = vp.h - 2 * marginY
  const widths = shown.map((p) => (sizes[p.id].w / sizes[p.id].h) * height)
  const lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, w) => a + w + gap, 0))
  const shift = vp.w / 2 - (lefts[ci] + widths[ci] / 2)
  shown.forEach((p, i) => out.set(p.id, { x: shift + lefts[i], y: marginY, s: height / sizes[p.id].h }))
  return out
}
