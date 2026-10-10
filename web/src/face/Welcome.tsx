import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSettings } from '../settings'
import { cameraStream, onFrame, onGesture, startFace, stopFace, winkLevel, type Gesture } from './engine'
import FaceGuide, { CYCLE_S, type GuideAction } from './FaceGuide'
import SwitchLayer from './SwitchLayer'

// The setup, shown on every load (the site is a pitch demo). A 3D guide acts out one gesture at a time
// next to a small animation of what that gesture does in the app, so it reads without reading. Doing the
// gesture moves on. "Use mouse & keyboard instead", Back and Skip are always there.

type StepId = 'hello' | Gesture | 'smile' | 'ready'
type Step = { id: StepId; act: GuideAction; title: string; line: string }
const STEPS: Step[] = [
  { id: 'hello', act: 'idle', title: 'Hi! Let’s see you', line: 'Sit so your face fits the frame. Nothing is recorded.' },
  { id: 'right', act: 'right', title: 'Turn right', line: 'Hold it, and the highlight moves to the next show.' },
  { id: 'left', act: 'left', title: 'Turn left', line: 'Hold it to go back one.' },
  { id: 'nod', act: 'nod', title: 'Nod', line: 'Presses whatever is highlighted.' },
  { id: 'shake', act: 'shake', title: 'Shake', line: 'Closes it and goes back.' },
  { id: 'wink', act: 'wink', title: 'Wink', line: 'While a comic plays, turns the narrator on or off.' },
  { id: 'smile', act: 'smile', title: 'Just enjoy it', line: 'Your smiles fill a heart meter that picks what to read next. Nothing to do here.' },
  { id: 'ready', act: 'nod', title: 'You’re set', line: 'Nod to start reading.' },
]
const GESTURE_NAME: Record<Gesture, string> = { right: 'a right turn', left: 'a left turn', nod: 'a nod', shake: 'a shake', wink: 'a wink' }
const SEEN_MS = 1500 // face steadily in view before the first gesture
const DONE_MS = 1100 // success moment before the next step
const isGesture = (id: StepId): id is Gesture => id in GESTURE_NAME

export default function Welcome() {
  const [, set] = useSettings()
  const [i, setI] = useState(0)
  const [camera, setCamera] = useState<'starting' | 'on' | 'denied'>('starting')
  const [face, setFace] = useState(false)
  const [success, setSuccess] = useState(false)
  const [miss, setMiss] = useState<string | null>(null)
  const [covers, setCovers] = useState<string[]>([])
  const [wink, setWink] = useState(0) // live: how far one eye is shut past the other, 1 = counts as a wink
  const video = useRef<HTMLVideoElement>(null)
  const step = STEPS[i]
  const go = (to: number) => {
    setSuccess(false)
    setMiss(null)
    setI(Math.max(0, Math.min(STEPS.length - 1, to)))
  }

  const finish = (faceControl: boolean) => set({ onboarded: true, gaze: faceControl, heart: faceControl })

  useEffect(() => {
    // Real key presses only: a head shake also sends a (synthetic) Escape.
    const esc = (e: KeyboardEvent) => e.isTrusted && e.key === 'Escape' && finish(false)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  })

  // Real covers make the demo animations look like the app they explain.
  useEffect(() => {
    fetch('/api/comics')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { cover?: string | null }[]) => setCovers(list.flatMap((c) => (c.cover ? [c.cover] : [])).slice(0, 3)))
      .catch(() => {})
  }, [])

  // Hold the camera for the whole setup; SwitchLayer shares the same stream.
  useEffect(() => {
    let alive = true
    startFace()
      .then(() => {
        if (!alive) return
        setCamera('on')
        if (video.current) video.current.srcObject = cameraStream()
      })
      .catch(() => alive && setCamera('denied'))
    return () => {
      alive = false
      stopFace()
    }
  }, [])

  useEffect(() => {
    let since = 0
    const off = onFrame((f) => {
      setFace(f.found)
      if (step.id === 'wink' && f.found) setWink(Math.min(1, winkLevel(f)))
      if (step.id !== 'hello') return
      if (!f.found) since = 0
      else if (!since) since = f.t
      else if (f.t - since > SEEN_MS) go(1)
    })
    return () => {
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id])

  // Practice: the right gesture celebrates and moves on; anything else says what it saw.
  useEffect(() => {
    if (!isGesture(step.id) || success) return
    let hide = 0
    const off = onGesture((g) => {
      if (g === step.id) return setSuccess(true)
      setMiss(`That was ${GESTURE_NAME[g]}. Try ${GESTURE_NAME[step.id as Gesture]}.`)
      clearTimeout(hide)
      hide = window.setTimeout(() => setMiss(null), 2000)
    })
    return () => {
      off()
      clearTimeout(hide)
    }
  }, [step.id, success])

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => go(i + 1), DONE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success])

  // The heart meter is passive (no one should have to smile on cue), so its step just plays twice.
  useEffect(() => {
    if (step.id !== 'smile') return
    const t = setTimeout(() => go(i + 1), CYCLE_S * 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id])

  return (
    <>
      {i > 0 && <SwitchLayer />}
      <div
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        data-face-practice={step.id !== 'ready' || undefined}
        style={{ '--cycle': `${CYCLE_S}s` } as CSSProperties}
      >
        <header className="welcome-top">
          <span className="welcome-kicker">Panel Reader</span>
          <ol className="welcome-steps" aria-label={`Step ${i + 1} of ${STEPS.length}`}>
            {STEPS.map((s, k) => (
              <li key={s.id} className={k < i ? 'done' : k === i ? 'now' : ''} />
            ))}
          </ol>
          <button type="button" className="welcome-fallback" onClick={() => finish(false)}>
            Use mouse &amp; keyboard
          </button>
        </header>

        <div className="welcome-stage">
          <FaceGuide action={success ? 'happy' : step.act} label={`Guide showing: ${step.title}`} />
          {step.id !== 'hello' && (
            <div className={`demo demo-${step.id}${success ? ' success' : ''}`} key={step.id} aria-hidden="true">
              <Demo id={step.id} covers={covers} />
              {success && (
                <span className="demo-check">
                  <Icon name="check" />
                </span>
              )}
            </div>
          )}
          {/* One video element for the whole setup: big in the first step, a small "you" bubble after. */}
          <div className={`welcome-cam${face ? ' found' : ''}${step.id === 'hello' ? ' big' : ''}`}>
            <video ref={video} autoPlay muted playsInline aria-hidden="true" />
            {step.id === 'hello' && (
              <span role="status">
                {camera === 'starting' ? 'Allow the camera…' : camera === 'denied' ? 'Camera blocked' : face ? 'Got you!' : 'Centre your face'}
              </span>
            )}
          </div>
        </div>

        <div className="welcome-caption" aria-live="polite">
          <h1 id="welcome-title">{success ? 'Nice!' : step.title}</h1>
          <p>{step.line}</p>
          {step.id === 'hello' && camera === 'denied' && (
            <p className="welcome-warn">The camera is blocked. Allow it, or use mouse &amp; keyboard.</p>
          )}
          {step.id === 'wink' && !success && (
            <span className={`wink-meter${wink >= 1 ? ' hit' : ''}`} role="meter" aria-label="Wink strength" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(wink * 100)}>
              <span style={{ transform: `scaleX(${wink})` }} />
            </span>
          )}
          {miss && <p className="welcome-miss">{miss}</p>}
          {step.id === 'ready' ? (
            <button type="button" className="btn btn-accent btn-lg welcome-start" autoFocus onClick={() => finish(true)}>
              <Icon name="play" /> Start reading
            </button>
          ) : (
            <div className="welcome-nav">
              {i > 0 && (
                <button type="button" className="btn-link" onClick={() => go(i - 1)}>
                  Back
                </button>
              )}
              <button type="button" className="btn-link" onClick={() => go(i + 1)}>
                Skip
              </button>
            </div>
          )}
        </div>

      </div>
    </>
  )
}

// What each gesture does, as a looping mini version of the app (synced to the guide's CYCLE_S).
function Demo({ id, covers }: { id: StepId; covers: string[] }) {
  const card = (k: number) => (
    <span key={k} className="demo-card">
      {covers[k] && <img src={covers[k]} alt="" />}
    </span>
  )
  if (id === 'wink')
    return (
      <div className="demo-screen demo-reading">
        {covers[0] && <img src={covers[0]} alt="" />}
        <span className="demo-narrator">
          <Icon name="speaker" />
          <span className="demo-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="demo-toggle" />
        </span>
      </div>
    )
  if (id === 'smile')
    return (
      <div className="demo-screen demo-hearts">
        {[0, 1, 2, 3, 4].map((k) => (
          <span key={k} className="demo-float" style={{ '--k': k } as CSSProperties}>
            <Icon name="heart" />
          </span>
        ))}
        <span className="demo-meter">
          <Icon name="heart" />
          <span className="demo-bar">
            <span className="demo-fill" />
          </span>
        </span>
        <span className="demo-pick">
          <span className="demo-card">{covers[2] && <img src={covers[2]} alt="" />}</span>
          <b>For you</b>
        </span>
      </div>
    )
  return (
    <div className="demo-screen">
      <div className="demo-row">
        {[0, 1, 2].map(card)}
        <span className="demo-ring" />
      </div>
      {(id === 'right' || id === 'left') && (
        <span className="demo-arrow">
          <Icon name={id} />
        </span>
      )}
      {(id === 'nod' || id === 'shake' || id === 'ready') && (
        <div className="demo-sheet">
          {covers[1] && <img src={covers[1]} alt="" />}
          <span className="demo-play">
            <Icon name="play" />
          </span>
        </div>
      )}
    </div>
  )
}

const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  right: 'M5 12h13m-5-6 6 6-6 6',
  left: 'M19 12H6m5-6-6 6 6 6',
  play: 'M8 5.5v13l11-6.5z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  speaker: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
}
function Icon({ name }: { name: keyof typeof PATHS }) {
  const filled = name === 'play' || name === 'heart'
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="icon"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
