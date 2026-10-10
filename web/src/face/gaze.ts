import type { FaceFrame } from './engine'

// Eye-gaze pointer. A 9-point calibration fits a least-squares map from what the camera sees (eye
// direction within the eye openings + head turn/tilt) to a point on the screen. The pointer is then
// smoothed, snaps to the nearest control, and "clicks" when you keep looking at it (dwell).

const KEY = 'panel-reader-gaze-calibration'
export type Calibration = { wx: number[]; wy: number[]; w: number; h: number }

export const features = (f: FaceFrame) => [1, f.gaze.x, f.gaze.y, f.yaw / 30, f.pitch / 30]

export function loadCalibration(): Calibration | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Calibration | null
    // A calibration only holds for the screen size it was made on.
    return c && Math.abs(c.w - window.innerWidth) < 80 && Math.abs(c.h - window.innerHeight) < 80 ? c : null
  } catch {
    return null
  }
}

export function saveCalibration(c: Calibration) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // private mode: calibrate again next visit
  }
}

// Ordinary least squares via the normal equations (5 features, so a tiny solve).
export function fit(samples: { f: number[]; x: number; y: number }[]): Calibration {
  const n = samples[0].f.length
  const A = Array.from({ length: n }, () => new Array(n).fill(0))
  const bx = new Array(n).fill(0)
  const by = new Array(n).fill(0)
  for (const s of samples) {
    for (let i = 0; i < n; i++) {
      bx[i] += s.f[i] * s.x
      by[i] += s.f[i] * s.y
      for (let j = 0; j < n; j++) A[i][j] += s.f[i] * s.f[j]
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += 1e-3 // ridge: keeps the solve stable
  return { wx: solve(A, bx), wy: solve(A, by), w: window.innerWidth, h: window.innerHeight }
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = M[r][c] / M[c][c]
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

export function predict(c: Calibration, f: FaceFrame) {
  const v = features(f)
  const dot = (w: number[]) => w.reduce((s, wi, i) => s + wi * v[i], 0)
  return { x: dot(c.wx), y: dot(c.wy) }
}

// The controls the pointer can land on.
export function targets(): HTMLElement[] {
  const sel = 'button, a[href], [role="button"], input[type="checkbox"], summary, [data-gaze-target]'
  const out: HTMLElement[] = []
  // Inside an open dialog only the dialog's controls count, like a keyboard would.
  const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open) ?? document.querySelector('[aria-modal="true"]')
  for (const el of (dialog ?? document).querySelectorAll<HTMLElement>(sel)) {
    if ((el as HTMLButtonElement).disabled || el.closest('[aria-hidden="true"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    out.push(el)
  }
  return out
}

// Nearest control to the gaze point, by distance to its box (0 when inside), within `reach` px.
export function nearest(x: number, y: number, reach = 140): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestD = reach
  for (const el of targets()) {
    const r = el.getBoundingClientRect()
    const dx = Math.max(r.left - x, 0, x - r.right)
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    const d = Math.hypot(dx, dy)
    if (d < bestD) {
      bestD = d
      best = el
    }
  }
  return best
}
