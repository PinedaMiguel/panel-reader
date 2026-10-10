import { useEffect, useRef, useState } from 'react'
import { ANALYSIS_WIDTH, HINT_TEXT, analyze, pickHint, toGray, type Hint } from './scanQuality'

const TICK_MS = 160
const GOOD_FRAMES_TO_CAPTURE = 9 // ~1.5 s of steady, well-framed frames
const SPEAK_GAP_MS = 2500

type Status = 'starting' | 'live' | 'unsupported' | 'denied'

// Live camera scanning with spoken framing hints and auto-capture. Several pages per session.
export default function Scanner({ onDone, onCancel }: { onDone: (pages: File[]) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>('starting')
  const [hint, setHint] = useState<Hint | null>(null)
  const [streak, setStreak] = useState(0)
  const [pages, setPages] = useState<File[]>([])
  const [thumbs, setThumbs] = useState<string[]>([])
  const [flash, setFlash] = useState(false)
  const [voice, setVoice] = useState(true)
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const captureRef = useRef<() => void>(() => {})
  const count = useRef(0)

  const speak = (text: string) => {
    if (!voiceRef.current || !('speechSynthesis' in window)) return
    speechSynthesis.cancel()
    speechSynthesis.speak(new SpeechSynthesisUtterance(text))
  }

  const capture = () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    c.toBlob(
      (blob) => {
        if (!blob) return
        const n = ++count.current
        speak(`Page ${n} captured. Turn the page, or press Done.`)
        setPages((p) => [...p, new File([blob], `scan-${n}.jpg`, { type: 'image/jpeg' })])
        setThumbs((t) => [...t, URL.createObjectURL(blob)])
      },
      'image/jpeg',
      0.92,
    )
    setFlash(true)
    setTimeout(() => setFlash(false), 180)
    navigator.vibrate?.(60)
  }
  captureRef.current = capture

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      return
    }
    let stream: MediaStream | null = null
    let timer = 0
    let cancelled = false
    const small = document.createElement('canvas')
    const ctx = small.getContext('2d', { willReadFrequently: true })!
    let prev: Float32Array | null = null
    let best = 0
    let good = 0
    let waitForChange = false // after a capture, wait for the page to be turned
    let lastHint: Hint | null = null
    let lastSpoken = 0

    const tick = () => {
      const v = video.current
      if (!v || !v.videoWidth) return
      small.width = ANALYSIS_WIDTH
      small.height = Math.round((v.videoHeight / v.videoWidth) * ANALYSIS_WIDTH)
      ctx.drawImage(v, 0, 0, small.width, small.height)
      const gray = toGray(ctx.getImageData(0, 0, small.width, small.height))
      const stats = analyze(gray, small.width, small.height, prev)
      prev = gray
      best = Math.max(best * 0.98, stats.sharpness) // slowly forget, in case focus or lighting changes
      let h = pickHint(stats, best)

      if (waitForChange) {
        if (stats.motion > 9) waitForChange = false
        h = h === 'good' ? 'motion' : h
      }
      good = h === 'good' ? good + 1 : 0
      setHint(waitForChange ? null : h)
      setStreak(good)

      const now = Date.now()
      if (h !== lastHint && now - lastSpoken > SPEAK_GAP_MS && !waitForChange) {
        speak(HINT_TEXT[h])
        lastSpoken = now
      }
      lastHint = h

      if (good >= GOOD_FRAMES_TO_CAPTURE) {
        good = 0
        waitForChange = true
        captureRef.current()
      }
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        video.current!.srcObject = s
        return video.current!.play().then(() => {
          setStatus('live')
          timer = window.setInterval(tick, TICK_MS)
        })
      })
      .catch(() => setStatus('denied'))

    return () => {
      cancelled = true
      clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
      speechSynthesis?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => thumbs.forEach(URL.revokeObjectURL), [thumbs])

  const fallback = status === 'unsupported' || status === 'denied'

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="Scan comic pages">
      <video ref={video} playsInline muted className={flash ? 'flash' : ''} hidden={fallback} />
      {!fallback && <div className={`guide${hint === 'good' ? ' ok' : ''}`} aria-hidden="true" />}

      <p className="scan-hint" role="status" aria-live="polite">
        {status === 'starting' && 'Starting camera…'}
        {status === 'live' && (hint ? HINT_TEXT[hint] : 'Turn the page when you are ready.')}
        {fallback &&
          (status === 'denied'
            ? 'Camera unavailable. Take photos with your camera app instead:'
            : 'Live camera is not supported here. Take photos instead:')}
      </p>

      {fallback && (
        <label className="scan-fallback">
          Take or choose photos
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length) onDone([...pages, ...files])
            }}
          />
        </label>
      )}

      {status === 'live' && (
        <div className="scan-meter" aria-hidden="true">
          <span style={{ width: `${(Math.min(streak, GOOD_FRAMES_TO_CAPTURE) / GOOD_FRAMES_TO_CAPTURE) * 100}%` }} />
        </div>
      )}

      <div className="scan-bar">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {status === 'live' && (
          <button type="button" className="shutter" onClick={capture} aria-label="Capture page now">
            <span />
          </button>
        )}
        <button type="button" className="primary" disabled={!pages.length} onClick={() => onDone(pages)}>
          Done ({pages.length})
        </button>
      </div>

      <div className="scan-tools">
        <button type="button" aria-pressed={voice} onClick={() => setVoice((v) => !v)}>
          Voice hints {voice ? 'on' : 'off'}
        </button>
        <ol className="scan-thumbs" aria-label="Captured pages">
          {thumbs.map((t, i) => (
            <li key={t}>
              <img src={t} alt={`Page ${i + 1}`} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
