import { useEffect, useState } from 'react'
import { onGesture, startFace, stopFace, type Gesture } from './engine'

// Hands-free control for the whole site, the "switch access" way: no pointer to aim and no calibration.
// Turn your head right/left to move a highlight to the next/previous control, nod to press it, shake to
// go back. While a comic plays, only deliberate gestures count (an unconscious nod or shake shouldn't
// stop the show): turns flip panels and a wink toggles audiobook narration. The highlight is real keyboard focus,
// so screen readers announce each control and Tab/mouse keep working alongside.

const SEL = 'button, a[href], [role="button"], input[type="checkbox"], summary, [data-switch-target]'
const LABEL: Record<Gesture, string> = { right: 'Next →', left: '← Previous', nod: 'Nod: press', shake: 'Shake: back', wink: 'Wink: narrator' }

// Controls in reading order. Inside an open dialog only the dialog's controls count, like a keyboard.
function targets(): HTMLElement[] {
  const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open) ?? document.querySelector('[aria-modal="true"]')
  return [...(dialog ?? document).querySelectorAll<HTMLElement>(SEL)].filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.closest('[aria-hidden="true"], .switch-layer')) return false
    const r = el.getBoundingClientRect()
    return r.width >= 4 && r.height >= 4 && getComputedStyle(el).visibility !== 'hidden'
  })
}

function move(by: 1 | -1) {
  const list = targets()
  if (!list.length) return
  const i = list.indexOf(document.activeElement as HTMLElement)
  // Nothing highlighted yet: start at the first control on screen.
  const next = i < 0 ? list.find((el) => el.getBoundingClientRect().bottom > 0) ?? list[0] : list[(i + by + list.length) % list.length]
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

export default function SwitchLayer() {
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied'>('starting')
  const [toast, setToast] = useState<string | null>(null)

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
      if (document.querySelector('[data-face-practice]')) return // the setup is practising gestures, not acting on them
      const dialog = [...document.querySelectorAll('dialog')].find((d) => d.open)
      const inReader = !!document.querySelector('.reader[data-playing="true"]') && !dialog
      if (g === 'wink') {
        if (!inReader) return
        key('a')
      } else if (inReader && (g === 'nod' || g === 'shake')) return
      else if (g === 'left' || g === 'right') {
        if (inReader) key(g === 'right' ? 'ArrowRight' : 'ArrowLeft')
        else move(g === 'right' ? 1 : -1)
      } else if (g === 'nod') {
        const el = document.activeElement as HTMLElement | null
        if (el && el !== document.body && targets().includes(el)) el.click()
        else move(1)
      } else if (dialog) dialog.close() // a synthetic Esc doesn't close a real dialog
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
      if (a && a !== document.body) return
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
      <p className="switch-legend" aria-hidden="true">
        <b>Turn</b> ← → move · <b>Nod</b> press · <b>Shake</b> back
      </p>
    </div>
  )
}
