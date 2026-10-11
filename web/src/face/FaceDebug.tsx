import { useEffect, useState } from 'react'
import { onFrame, onGesture, turnState, type FaceFrame } from './engine'

// Press D for a live readout of what the camera measures: head angle, the learned "facing forward",
// how far you're turned, eye closure, frame rate and the last gestures detected. For tuning on real hardware.
export default function FaceDebug() {
  const [on, setOn] = useState(false)
  const [f, setF] = useState<FaceFrame | null>(null)
  const [fps, setFps] = useState(0)
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    const key = (e: KeyboardEvent) =>
      e.isTrusted && (e.key === 'd' || e.key === 'D') && !(e.target instanceof HTMLInputElement) && setOn((v) => !v)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    if (!on) return
    let n = 0
    let since = performance.now()
    const offF = onFrame((x) => {
      setF(x)
      n++
      if (x.t - since > 1000) {
        setFps(Math.round((n * 1000) / (x.t - since)))
        n = 0
        since = x.t
      }
    })
    const offG = onGesture((g) => setLog((l) => [`${new Date().toLocaleTimeString()} ${g}`, ...l].slice(0, 6)))
    return () => {
      offF()
      offG()
    }
  }, [on])

  if (!on) return null
  // A quick visual for the candidate "this is a command" signals: 0.00 ▏▏▏▏▏▏▏▏▏▏ 1.00
  const bar = (v = 0) => `${v.toFixed(2)} ${'█'.repeat(Math.round(v * 10)).padEnd(10, '·')}`
  const { rest } = turnState()
  const off = f && rest !== null ? f.yaw - rest : 0
  return (
    <pre className="face-debug" aria-hidden="true">
      {f?.found ? '' : 'NO FACE\n'}
      yaw   {f?.yaw.toFixed(1)}°{'\n'}
      rest  {rest?.toFixed(1)}°{'\n'}
      off   {off.toFixed(1)}° {Math.abs(off) >= 16 ? (off > 0 ? '→ RIGHT' : '← LEFT') : ''}{'\n'}
      pitch {f?.pitch.toFixed(1)}°{'\n'}
      eyes  L {f?.blink.l.toFixed(2)} R {f?.blink.r.toFixed(2)}{'\n'}
      tongue {bar(f?.tongue)}{'\n'}
      brows  {bar(f?.browUp)}{'\n'}
      mouth  {bar(f?.jaw)}{'\n'}
      fps   {fps}{'\n'}
      {log.join('\n')}
    </pre>
  )
}
