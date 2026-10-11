import { useEffect, useState } from 'react'
import { useSettings } from '../settings'
import { calibrate, controlState, onControlState, onGesture, pauseGestures, startFace, stopFace, toggleManualPause, type ControlState, type Gesture } from './engine'

// Hands-free control for the whole site, kept as simple as possible: turn your head right for yes (press
// what's highlighted: Play, Watch...) and left for no (close, go back). While a comic plays, right and left
// go to the next and previous panel. The highlight is real keyboard focus, so screen readers announce it and Tab/mouse still work.

const SEL = 'button, a[href], [role="button"], input[type="checkbox"], summary, [data-switch-target]'
const LABEL: Record<Gesture, string> = { right: 'Yes →', left: '← No', eyes: 'Eyes closed: narrator', up: 'Looked up: pause' }

// Controls in reading order. Inside an open dialog only the dialog's controls count, like a keyboard.
function targets(): HTMLElement[] {
  const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open) ?? document.querySelector('[aria-modal="true"]')
  return [...(dialog ?? document).querySelectorAll<HTMLElement>(SEL)].filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.closest('[aria-hidden="true"], .switch-layer')) return false
    const r = el.getBoundingClientRect()
    return r.width >= 4 && r.height >= 4 && getComputedStyle(el).visibility !== 'hidden'
  })
}


// What the face engine is doing right now, always on screen so nobody wonders why a gesture did nothing.
const STATE: Record<ControlState, string> = {
  ready: 'Ready',
  wait: 'Hold still…',
  away: 'Paused: look at the screen',
  others: 'Paused: someone else is in view',
  paused: 'Paused: press H to resume',
}

const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

export default function SwitchLayer() {
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied'>('starting')
  const [toast, setToast] = useState<string | null>(null)
  const [control, setControl] = useState<ControlState>(controlState)
  const [{ calib }] = useSettings()
  useEffect(() => calibrate(calib), [calib]) // thresholds from the setup, on every page

  // Hands-free control starting (end of setup, a page load): the nod that got you here doesn't count.
  useEffect(() => {
    pauseGestures()
    const off = onControlState(setControl)
    // H: the presenter's pause, for talking to people without the page reacting.
    const h = (e: KeyboardEvent) => e.isTrusted && (e.key === 'h' || e.key === 'H') && !(e.target instanceof HTMLInputElement) && toggleManualPause()
    window.addEventListener('keydown', h)
    return () => {
      off()
      window.removeEventListener('keydown', h)
    }
  }, [])

  useEffect(() => {
    let alive = true
    startFace().then(() => alive && setStatus('ready')).catch(() => alive && setStatus('denied'))
    return () => {
      alive = false
      stopFace()
    }
  }, [])

  useEffect(() => {
    let hide = 0
    const off = onGesture((g) => {
      if (document.querySelector('[data-face-own]')) return // that screen (the setup, the lineup) handles gestures itself
      const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open)
      const inReader = !!document.querySelector('.reader[data-playing="true"]') && !dialog
      if (g === 'eyes') return inReader && key('a') // the narrator toggle, while reading
      if (g === 'up') return inReader && key('p') // look at the sky: pause
      if (inReader) return key(g === 'right' ? 'ArrowRight' : 'ArrowLeft') // while reading: next / previous panel
      if (g === 'right') {
        // Yes: press what's highlighted (something always is, see below).
        const el = document.activeElement as HTMLElement | null
        if (el && el !== document.body && targets().includes(el)) el.click()
      } else if (dialog) dialog.close() // No: close (a synthetic Esc doesn't close a real dialog)
      else key('Escape')
      setToast(LABEL[g])
      clearTimeout(hide)
      hide = window.setTimeout(() => setToast(null), 1200)
    })
    return () => {
      off()
      clearTimeout(hide)
    }
  }, [])

  // Always have something highlighted, so the first nod presses a visible control instead of just picking
  // one (pages, the end of setup and async lists all start with nothing focused). Not in the reader:
  // there turns flip panels and a nod plays.
  useEffect(() => {
    const t = setInterval(() => {
      const a = document.activeElement
      if ((a && a !== document.body) || document.querySelector('[data-face-own]')) return
      if (document.querySelector('.reader[data-playing="true"]') && ![...document.querySelectorAll('dialog')].some((d) => d.open)) return
      targets().find((el) => el.getBoundingClientRect().top >= 0)?.focus({ preventScroll: true })
    }, 400)
    return () => clearInterval(t)
  }, [])

  // A big focus ring on whatever is highlighted (CSS, so it also shows inside dialogs' top layer).
  useEffect(() => {
    document.documentElement.classList.add('switch-on')
    return () => document.documentElement.classList.remove('switch-on')
  }, [])

  return (
    <div className="switch-layer" aria-live="polite">
      {status === 'denied' ? (
        <p className="switch-toast">Camera unavailable: hands-free mode needs camera access.</p>
      ) : (
        toast && <p className="switch-toast">{toast}</p>
      )}
      {status === 'ready' && (
        <p className={`switch-state ${control}`} role="status">
          <span aria-hidden="true" /> {STATE[control]}
        </p>
      )}
      <p className="switch-legend" aria-hidden="true">
        <b>Turn right</b> yes · <b>Turn left</b> no
      </p>
    </div>
  )
}
