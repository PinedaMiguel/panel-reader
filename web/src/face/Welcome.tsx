import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../settings'
import { cameraStream, onFrame, onGesture, startFace, stopFace, type Gesture } from './engine'
import SwitchLayer from './SwitchLayer'

// First visit: set up face control, the site's primary input. The camera starts straight away (a
// hands-free reader can't press "start"), then each head gesture is practised once. No calibration.
// "Use mouse & keyboard instead" is always one click or Esc away.

type Step = 'camera' | 'gestures' | 'ready'
const SEEN_MS = 2500 // face steadily in view (and time to read the guide) before practising
const PRACTICE: [Gesture, string, string][] = [
  ['right', '→', 'Turn your head right and hold: next'],
  ['left', '←', 'Turn your head left and hold: previous'],
  ['nod', '↕', 'Nod: press, play, pause'],
  ['shake', '↔', 'Shake: back, close'],
]

export default function Welcome() {
  const [, set] = useSettings()
  const [step, setStep] = useState<Step>('camera')
  const [camera, setCamera] = useState<'starting' | 'on' | 'denied'>('starting')
  const [face, setFace] = useState(false)
  const [done, setDone] = useState<Gesture[]>([])
  const video = useRef<HTMLVideoElement>(null)

  const finish = (faceControl: boolean) => set({ onboarded: true, gaze: faceControl, heart: faceControl })

  useEffect(() => {
    // Real key presses only: a head shake also sends a (synthetic) Escape.
    const esc = (e: KeyboardEvent) => e.isTrusted && e.key === 'Escape' && finish(false)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  })

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
    if (step !== 'camera') return
    let since = 0
    const off = onFrame((f) => {
      setFace(f.found)
      if (!f.found) since = 0
      else if (!since) since = f.t
      else if (f.t - since > SEEN_MS) setStep('gestures')
    })
    return () => {
      off()
    }
  }, [step])

  useEffect(() => {
    if (step !== 'gestures') return
    const off = onGesture((g) => setDone((d) => (d.includes(g) ? d : [...d, g])))
    return () => {
      off()
    }
  }, [step])

  useEffect(() => {
    if (step === 'gestures' && done.length === PRACTICE.length) {
      const t = setTimeout(() => setStep('ready'), 900)
      return () => clearTimeout(t)
    }
  }, [step, done])

  const fallback = (
    <button type="button" className="welcome-fallback" onClick={() => finish(false)}>
      Use mouse &amp; keyboard instead
    </button>
  )

  return (
    <>
      {step !== 'camera' && <SwitchLayer />}
      <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <div className="welcome-card">
          <p className="welcome-kicker">Panel Reader</p>
          {step === 'camera' && (
            <>
              <h1 id="welcome-title">Read comics with just your head.</h1>
              <ol className="welcome-guide" aria-label="How it works">
                <li>
                  <b>Pick a show.</b> Turn your head to move between covers, nod to open one.
                </li>
                <li>
                  <b>Listen along.</b> Every panel is read aloud, with a voice for each character. Turn to flip panels,
                  nod to pause, shake to go back.
                </li>
                <li>
                  <b>Get a pick.</b> A heart meter reads your expressions as you go and suggests what to read next.
                </li>
              </ol>
              <div className={`welcome-cam${face ? ' found' : ''}`}>
                <video ref={video} autoPlay muted playsInline aria-hidden="true" />
                <span role="status">
                  {camera === 'starting' ? 'Allow the camera to begin…'
                    : camera === 'denied' ? 'The camera is blocked or unavailable.'
                    : face ? 'Got you. Hold still…'
                    : 'Centre your face in the frame.'}
                </span>
              </div>
              <p className="welcome-note">Everything runs on this device. No video is recorded or sent anywhere.</p>
            </>
          )}
          {step === 'gestures' && (
            <>
              <h1 id="welcome-title">Now try your head.</h1>
              <ul className="welcome-gestures" data-face-practice>
                {PRACTICE.map(([g, icon, text]) => (
                  <li key={g} className={done.includes(g) ? 'done' : ''}>
                    <span aria-hidden="true">{done.includes(g) ? '✓' : icon}</span> {text}
                  </li>
                ))}
              </ul>
              <button type="button" className="btn" onClick={() => setStep('ready')}>
                Skip practice
              </button>
            </>
          )}
          {step === 'ready' && (
            <>
              <h1 id="welcome-title">You're set.</h1>
              <p>“Start reading” is highlighted: nod to press it. You can redo this setup any time in Settings.</p>
              <button type="button" className="btn btn-accent btn-lg" autoFocus onClick={() => finish(true)}>
                Start reading
              </button>
            </>
          )}
          {fallback}
        </div>
      </div>
    </>
  )
}
