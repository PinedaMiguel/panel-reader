import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../settings'
import { cameraStream, onFrame, onGesture, startFace, stopFace } from './engine'
import GazeLayer from './GazeLayer'

// First visit: set up face control, the site's primary input. The camera starts straight away (a
// hands-free reader can't press "start"), then eye calibration, then a nod and a shake to practise.
// "Use mouse & keyboard instead" is always one click or Esc away.

type Step = 'camera' | 'calibrate' | 'gestures' | 'ready'
const SEEN_MS = 1500 // face steadily in view before calibrating

export default function Welcome() {
  const [, set] = useSettings()
  const [step, setStep] = useState<Step>('camera')
  const [camera, setCamera] = useState<'starting' | 'on' | 'denied'>('starting')
  const [face, setFace] = useState(false)
  const [nodded, setNodded] = useState(false)
  const [shook, setShook] = useState(false)
  const video = useRef<HTMLVideoElement>(null)

  const finish = (faceControl: boolean) => set({ onboarded: true, gaze: faceControl, heart: faceControl })

  useEffect(() => {
    // Real key presses only: a head shake also sends a (synthetic) Escape.
    const esc = (e: KeyboardEvent) => e.isTrusted && e.key === 'Escape' && finish(false)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  })

  // Hold the camera for the whole setup; GazeLayer shares the same stream.
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
      else if (f.t - since > SEEN_MS) setStep('calibrate')
    })
    return () => {
      off()
    }
  }, [step])

  useEffect(() => {
    if (step !== 'gestures') return
    const off = onGesture((g) => (g === 'nod' ? setNodded(true) : setShook(true)))
    return () => {
      off()
    }
  }, [step])

  useEffect(() => {
    if (step === 'gestures' && nodded && shook) {
      const t = setTimeout(() => setStep('ready'), 900)
      return () => clearTimeout(t)
    }
  }, [step, nodded, shook])

  const fallback = (
    <button type="button" className="welcome-fallback" onClick={() => finish(false)}>
      Use mouse &amp; keyboard instead
    </button>
  )

  return (
    <>
      {step !== 'camera' && <GazeLayer fresh onCalibrated={() => setStep('gestures')} />}
      {step === 'calibrate' ? (
        <div className="welcome-corner">{fallback}</div>
      ) : (
        <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
          <div className="welcome-card">
            <p className="welcome-kicker">Panel Reader</p>
            {step === 'camera' && (
              <>
                <h1 id="welcome-title">Read comics with your eyes and head.</h1>
                <p>
                  Look at a button to press it. Nod to say yes, shake your head to go back. While you read, a heart
                  meter learns what you enjoy from your expressions to recommend what to read next.
                </p>
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
                <ul className="welcome-gestures" data-gaze-practice>
                  <li className={nodded ? 'done' : ''}>
                    <span aria-hidden="true">{nodded ? '✓' : '↕'}</span> Nod: yes, play, pause
                  </li>
                  <li className={shook ? 'done' : ''}>
                    <span aria-hidden="true">{shook ? '✓' : '↔'}</span> Shake: no, back, close
                  </li>
                </ul>
                <button type="button" className="btn" onClick={() => setStep('ready')}>
                  Skip practice
                </button>
              </>
            )}
            {step === 'ready' && (
              <>
                <h1 id="welcome-title">You're set.</h1>
                <p>Look at “Start reading” for a second to press it. You can redo this setup any time in Settings.</p>
                <button type="button" className="btn btn-accent btn-lg" onClick={() => finish(true)}>
                  Start reading
                </button>
              </>
            )}
            {fallback}
          </div>
        </div>
      )}
    </>
  )
}
