// Frame quality checks for camera scanning, run on a small downscaled grayscale frame.
// Thresholds are relative where possible (sharpness is compared to the best seen so far)
// because phone cameras differ a lot in noise and exposure.

export const ANALYSIS_WIDTH = 160

export type Hint = 'dark' | 'glare' | 'motion' | 'far' | 'close' | 'blur' | 'good'

export const HINT_TEXT: Record<Hint, string> = {
  dark: 'Too dark. Add more light.',
  glare: 'Too much glare. Tilt the page away from the light.',
  motion: 'Hold still.',
  far: 'Move closer to the page.',
  close: 'Too close. Move back so the whole page fits.',
  blur: 'Hold steady, focusing.',
  good: 'Looks good. Hold still.',
}

export type FrameStats = {
  brightness: number // 0-255 mean luma
  glare: number // fraction of near-white pixels
  motion: number // mean abs difference from previous frame
  sharpness: number // variance of the Laplacian
  cover: number // how much of the frame's width or height the page's content spans (0-1)
  cutOff: number // worst side: fraction of that frame edge covered by content (page cut off)
}

const CELL = 10 // px per grid cell at analysis size

export function toGray(img: ImageData): Float32Array {
  const { data, width, height } = img
  const g = new Float32Array(width * height)
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return g
}

export function analyze(gray: Float32Array, w: number, h: number, prev: Float32Array | null): FrameStats {
  let sum = 0
  let bright = 0
  let diff = 0
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i]
    if (gray[i] > 245) bright++
    if (prev) diff += Math.abs(gray[i] - prev[i])
  }

  // Laplacian magnitude: sharpness overall, and per-cell "is there content here" for framing.
  const gw = Math.floor(w / CELL)
  const gh = Math.floor(h / CELL)
  const cells = new Float32Array(gw * gh)
  let lapSum = 0
  let lapSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      lapSum += lap
      lapSq += lap * lap
      n++
      const cx = Math.floor(x / CELL)
      const cy = Math.floor(y / CELL)
      if (cx < gw && cy < gh) cells[cy * gw + cx] += Math.abs(lap)
    }
  }
  const mean = lapSum / n
  const sharpness = lapSq / n - mean * mean

  // A cell holds content if its edge energy is well above the quiet background.
  const sorted = Array.from(cells).sort((a, b) => a - b)
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const threshold = Math.max(CELL * CELL * 6, p90 * 0.35)
  let minX = gw, minY = gh, maxX = -1, maxY = -1
  const sides = [0, 0, 0, 0] // top, bottom, left, right
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      if (cells[cy * gw + cx] <= threshold) continue
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx)
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy)
      if (cy === 0) sides[0]++
      if (cy === gh - 1) sides[1]++
      if (cx === 0) sides[2]++
      if (cx === gw - 1) sides[3]++
    }
  }
  const cover = maxX < 0 ? 0 : Math.max((maxX - minX + 1) / gw, (maxY - minY + 1) / gh)
  const cutOff = Math.max(sides[0] / gw, sides[1] / gw, sides[2] / gh, sides[3] / gh)

  return {
    brightness: sum / gray.length,
    glare: bright / gray.length,
    motion: prev ? diff / gray.length : 0,
    sharpness,
    cover,
    cutOff,
  }
}

// Most urgent problem first; `bestSharpness` is the sharpest frame seen recently.
// Thresholds calibrated on simulated frames of a comic page on a table (portrait and landscape).
export function pickHint(s: FrameStats, bestSharpness: number): Hint {
  if (s.brightness < 60) return 'dark'
  if (s.glare > 0.08 || s.brightness > 215) return 'glare'
  if (s.motion > 9) return 'motion'
  if (s.cover < 0.55) return 'far'
  if (s.cutOff > 0.5) return 'close'
  if (s.sharpness < Math.max(150, bestSharpness * 0.5)) return 'blur'
  return 'good'
}
