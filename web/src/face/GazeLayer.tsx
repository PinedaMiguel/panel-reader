import { useEffect, useRef, useState } from 'react'
import { onFrame, onGesture, startFace, stopFace, type FaceFrame } from './engine'
import { features, fit, loadCalibration, nearest, predict, saveCalibration, type Calibration } from './gaze'

// Hands-free control for the whole site: an eye-gaze pointer that snaps to controls and clicks when you
// keep looking (dwell), plus head gestures: nod = confirm (Play/Pause in the reader), shake = back (Esc).

const DWELL_MS = 1000
const SMOOTH = 0.2
const POINTS = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y })))
const POINT_MS = 1600
const SETTLE_MS = 600

// `fresh`: always calibrate on mount (the first-visit setup). `onCalibrated` fires when a calibration is saved.
export default function GazeLayer({ fresh = false, onCalibrated }: { fresh?: boolean; onCalibrated?: () => void }) {
  const [cal, setCal] = useState<Calibration | null>(() => (fresh ? null : loadCalibration()))
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied'>('starting')
  const [calibrating, setCalibrating] = useState(!cal)
  const [point, setPoint] = useState(0)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<{ rect: DOMRect; progress: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const calRef = useRef(cal)
  calRef.current = cal
  const done = useRef(onCalibrated)
  done.current = onCalibrated

  useEffect(() => {
    let alive = true
    startFace().then(() => alive && setStatus('ready')).catch(() => alive && setStatus('denied'))
    return () => {
      alive = false
      stopFace()
    }
  }, [])

  // Recalibrate on request (the settings button) or when the window size changes a lot.
  useEffect(() => {
    const again = () => {
      setPoint(0)
      setCalibrating(true)
    }
    window.addEventListener('gaze-recalibrate', again)
    return () => window.removeEventListener('gaze-recalibrate', again)
  }, [])

  // Calibration: show each dot, collect samples once the eyes have settled on it.
  useEffect(() => {
    if (!calibrating || status !== 'ready') return
    const samples: { f: number[]; x: number; y: number }[] = []
    let i = 0
    let shownAt = performance.now()
    setPoint(0)
    const off = onFrame((f: FaceFrame) => {
      if (!f.found) return
      const now = performance.now()
      const p = POINTS[i]
      if (now - shownAt > SETTLE_MS) samples.push({ f: features(f), x: p.x * innerWidth, y: p.y * innerHeight })
      if (now - shownAt > POINT_MS) {
        i++
        shownAt = now
        if (i >= POINTS.length) {
          const c = fit(samples)
          saveCalibration(c)
          setCal(c)
          setCalibrating(false)
          done.current?.()
          setToast('Calibrated. Look at a button and hold your gaze to press it.')
          setTimeout(() => setToast(null), 4000)
          return
        }
        setPoint(i)
      }
    })
    return () => {
      off()
    }
  }, [calibrating, status])

  // Pointer, snapping and dwell-to-click.
  useEffect(() => {
    if (calibrating) return
    let x = innerWidth / 2
    let y = innerHeight / 2
    let target: HTMLElement | null = null
    let since = 0
    let fired: HTMLElement | null = null // must look away before the same control fires again
    const off = onFrame((f) => {
      const c = calRef.current
      if (!c || !f.found) return
      const p = predict(c, f)
      x += (Math.min(innerWidth, Math.max(0, p.x)) - x) * SMOOTH
      y += (Math.min(innerHeight, Math.max(0, p.y)) - y) * SMOOTH
      setPos({ x, y })
      const el = nearest(x, y)
      if (el !== target) {
        target = el
        since = f.t
        if (el !== fired) fired = null
      }
      if (!el) return setHover(null)
      const progress = Math.min(1, (f.t - since) / DWELL_MS)
      setHover({ rect: el.getBoundingClientRect(), progress: fired === el ? 0 : progress })
      if (progress >= 1 && fired !== el) {
        fired = el
        el.focus({ preventScroll: true })
        el.click()
      }
    })
    const offG = onGesture((g) => {
      if (document.querySelector('[data-gaze-practice]')) return // the setup is practising gestures, not acting on them
      const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open)
      if (g === 'shake' && dialog) dialog.close() // a synthetic Esc doesn't close a real dialog
      else if (g === 'nod' && (dialog || !document.querySelector('.reader'))) target?.click()
      else window.dispatchEvent(new KeyboardEvent('keydown', { key: g === 'nod' ? 'p' : 'Escape', bubbles: true }))
      setToast(g === 'nod' ? 'Nod: confirm' : 'Shake: back')
      setTimeout(() => setToast(null), 1200)
    })
    return () => {
      off()
      offG()
    }
  }, [calibrating])

  const dot = POINTS[point]
  return (
    <div className="gaze-layer" aria-live="polite">
      {status === 'denied' && <p className="gaze-toast">Camera unavailable: hands-free mode needs camera access.</p>}
      {calibrating && status === 'ready' && (
        <div className="gaze-calibration" role="dialog" aria-label="Eye calibration">
          <p>Follow the yellow dot with your eyes. Keep your head comfortable. {point + 1} / {POINTS.length}</p>
          <span key={point} className="gaze-dot" style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }} />
        </div>
      )}
      {!calibrating && pos && <span className="gaze-pointer" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }} />}
      {!calibrating && hover && (
        <span
          className="gaze-target"
          style={{ left: hover.rect.left - 6, top: hover.rect.top - 6, width: hover.rect.width + 12, height: hover.rect.height + 12 }}
        >
          <span className="gaze-fill" style={{ transform: `scaleX(${hover.progress})` }} />
        </span>
      )}
      {!calibrating && !document.querySelector('.reader') && (
        // Scrolling by gaze on long pages (the reader moves panel by panel instead).
        <>
          <button type="button" className="gaze-scroll up" data-gaze-target onClick={() => scrollBy({ top: -innerHeight * 0.7, behavior: 'smooth' })}>
            ▲ Scroll up
          </button>
          <button type="button" className="gaze-scroll down" data-gaze-target onClick={() => scrollBy({ top: innerHeight * 0.7, behavior: 'smooth' })}>
            ▼ Scroll down
          </button>
        </>
      )}
      {toast && <p className="gaze-toast">{toast}</p>}
    </div>
  )
}
