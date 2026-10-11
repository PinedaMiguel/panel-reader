import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSettings } from '../settings'
import { calibrate, calibrationNow, cameraStream, headOffset, onFrame, onGesture, pauseGestures, startFace, stopFace, eyesClosedLevel, thresholdFrom, type Gesture } from './engine'
import FaceGuide, { CYCLE_S, type GuideAction } from './FaceGuide'
import SwitchLayer from './SwitchLayer'

// The setup, shown on every load (the site is a pitch demo). A 3D guide acts out one gesture at a time
// next to a small animation of what that gesture does in the app, so it reads without reading. Doing the
// gesture moves on. "Use mouse & keyboard instead", Back and Skip are always there.

type StepId = 'hello' | Gesture | 'smile' | 'ready'
type Step = { id: StepId; act: GuideAction; title: string; line: string }
const STEPS: Step[] = [
  { id: 'hello', act: 'idle', title: 'Look at the camera', line: 'Look at the camera so it can see your face. Nothing is recorded.' },
  { id: 'right', act: 'right', title: 'Turn right = yes', line: 'Turn your head right and hold it there until the bar fills. Turning right says yes: it picks the show.' },
  { id: 'left', act: 'left', title: 'Turn left = no', line: 'Turn your head left and hold it there until the bar fills. Turning left says no: it skips to the next show.' },
  { id: 'eyes', act: 'eyes', title: 'Close your eyes', line: 'Close your eyes for a second to turn the narrator on or off while a comic plays.' },
  { id: 'up', act: 'up', title: 'Look up = pause', line: 'Look up at the sky and hold it there until the bar fills. Looking up pauses a comic while it plays.' },
  { id: 'smile', act: 'smile', title: 'Just enjoy it', line: 'Your smiles fill a heart meter that picks what to read next. Nothing to do here.' },
  { id: 'ready', act: 'right', title: 'You’re set', line: 'Turn your head right to start reading.' },
]
const GESTURE_NAME: Record<Gesture, string> = { right: 'a right turn', left: 'a left turn', eyes: 'closing your eyes', up: 'looking up' }
const SEEN_MS = 1500 // face steadily in view before the first gesture
const DONE_MS = 1100 // success moment before the next step
// Demo animation per step: yes picks a show (it opens), no skips it (it closes).
const DEMO: Partial<Record<StepId, string>> = { right: 'yes', left: 'no', ready: 'yes' }
const isGesture = (id: StepId): id is Gesture => id in GESTURE_NAME
// Calibration: the turn and look-up steps ask you to hold the position, and how far you hold it sets your
// thresholds (calibrate in the engine). Holding starts counting from a low bar, so small movers can do it.
type CalId = 'right' | 'left' | 'up'
const CAL_MS = 1500
const CAL_FROM: Record<CalId, number> = { right: 10, left: 10, up: 12 }
const isCal = (id: StepId): id is CalId => id in CAL_FROM
const reach = (id: CalId) => (id === 'up' ? headOffset().pitch : id === 'right' ? headOffset().yaw : -headOffset().yaw)

export default function Welcome() {
  const [, set] = useSettings()
  const [i, setI] = useState(0)
  const [camera, setCamera] = useState<'starting' | 'on' | 'denied'>('starting')
  const [face, setFace] = useState(false)
  const [success, setSuccess] = useState(false)
  const [miss, setMiss] = useState<string | null>(null)
  const [covers, setCovers] = useState<string[]>([])
  const [held, setHeld] = useState(0) // live: how far through the current hold (eyes closed, a turn), 1 = done
  const video = useRef<HTMLVideoElement>(null)
  const step = STEPS[i]
  const go = (to: number) => {
    pauseGestures(700) // the gesture just practised mustn't count for the next step
    setSuccess(false)
    setMiss(null)
    setI(Math.max(0, Math.min(STEPS.length - 1, to)))
  }

  // The guide also says what to do, in a word or two, and "Nice!" when you do it (pre-made ElevenLabs
  // clips in /setup-voice: Matilda, a calm adult voice that is rare in the comics). If the browser blocks sound before any interaction, it retries once the camera is
  // running or on the first click or key press.
  const [voice, setVoice] = useState(true)
  const speaker = useRef<HTMLAudioElement | null>(null)
  const pending = useRef<string | null>(null)
  const say = (clip: string) => {
    speaker.current?.pause()
    pending.current = null
    if (!voice) return
    const a = new Audio(`/setup-voice/${clip}.mp3`)
    speaker.current = a
    a.play().catch(() => (pending.current = clip))
  }
  const retry = () => pending.current && say(pending.current)
  useEffect(() => {
    const t = setTimeout(() => say(step.id), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, voice])
  useEffect(() => {
    if (success) say('nice')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success])
  useEffect(() => {
    if (camera === 'on') retry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])
  useEffect(() => {
    window.addEventListener('pointerdown', retry)
    window.addEventListener('keydown', retry)
    return () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
    }
  })
  useEffect(() => () => speaker.current?.pause(), [])
  // The heart step: a soft sparkle each time the demo's hearts float up (start of each loop), under the line.
  useEffect(() => {
    if (step.id !== 'smile' || !voice) return
    const fx: HTMLAudioElement[] = []
    const pop = () => {
      const a = new Audio('/setup-voice/hearts.mp3')
      a.volume = 0.4
      fx.push(a)
      a.play().catch(() => {})
    }
    pop()
    const t = setInterval(pop, CYCLE_S * 1000)
    return () => {
      clearInterval(t)
      fx.forEach((a) => a.pause())
    }
  }, [step.id, voice])

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
    let holdSince = 0
    let samples: number[] = []
    const off = onFrame((f) => {
      setFace(f.found)
      if (step.id === 'eyes' && f.found) setHeld(eyesClosedLevel(f))
      const id = step.id
      if (isCal(id) && !success) {
        const a = f.found ? reach(id) : 0
        if (a < CAL_FROM[id]) {
          holdSince = 0
          samples = []
          return setHeld(0)
        }
        holdSince ||= f.t
        samples.push(a)
        const k = Math.min(1, (f.t - holdSince) / CAL_MS)
        setHeld(k)
        if (k < 1) return
        calibrate({ ...calibrationNow(), [id]: thresholdFrom(samples, id === 'up') })
        set({ calib: calibrationNow() })
        setSuccess(true)
        return
      }
      if (step.id !== 'hello') return
      if (!f.found) since = 0
      else if (!since) since = f.t
      else if (f.t - since > SEEN_MS) go(1)
    })
    return () => {
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, success])

  // Practice: the right gesture celebrates and moves on; anything else says what it saw.
  useEffect(() => {
    if (!isGesture(step.id) || success) return
    let hide = 0
    const off = onGesture((g) => {
      if (g === step.id) return isCal(g) || setSuccess(true) // held steps succeed when the hold is done
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
        data-face-own={step.id !== 'ready' || undefined}
        style={{ '--cycle': `${CYCLE_S}s` } as CSSProperties}
      >
        <header className="welcome-top">
          <span className="welcome-kicker">Panel Reader</span>
          <ol className="welcome-steps" aria-label={`Step ${i + 1} of ${STEPS.length}`}>
            {STEPS.map((s, k) => (
              <li key={s.id} className={k < i ? 'done' : k === i ? 'now' : ''} />
            ))}
          </ol>
          <span className="welcome-top-actions">
            <button type="button" className="welcome-fallback" aria-pressed={voice} onClick={() => setVoice((v) => !v)}>
              {voice ? 'Voice on' : 'Voice off'}
            </button>
            <button type="button" className="welcome-fallback" onClick={() => finish(false)}>
              Use mouse &amp; keyboard
            </button>
          </span>
        </header>

        <div className="welcome-stage">
          <FaceGuide action={success ? 'happy' : step.act} label={`Guide showing: ${step.title}`} />
          {step.id !== 'hello' && (
            <div className={`demo demo-${DEMO[step.id] ?? step.id}${success ? ' success' : ''}`} key={step.id} aria-hidden="true">
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
          {(step.id === 'eyes' || isCal(step.id)) && !success && (
            <span className={`hold-meter${held >= 1 ? ' hit' : ''}`} role="meter" aria-label={step.id === 'eyes' ? 'Eyes closed' : 'Hold'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(held * 100)}>
              <span style={{ transform: `scaleX(${held})` }} />
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
  if (id === 'up')
    return (
      <div className="demo-screen demo-reading">
        {covers[0] && <img src={covers[0]} alt="" />}
        <span className="demo-pause">
          <Icon name="pause" />
        </span>
      </div>
    )
  if (id === 'eyes')
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
      {(id === 'right' || id === 'left' || id === 'ready') && (
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
  pause: 'M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  speaker: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
}
function Icon({ name }: { name: keyof typeof PATHS }) {
  const filled = name === 'play' || name === 'pause' || name === 'heart'
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
