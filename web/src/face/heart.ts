import { useEffect, useRef, useState } from 'react'
import { onFrame, onGesture, startFace, stopFace } from './engine'

// Passive enjoyment meter. While you read, spontaneous signs of interest (smiling, eyes opening wide,
// nodding) fill the heart; a lowered brow, a sneer or a head shake drain it. Each signal is measured
// against your own neutral face (a slow-moving baseline), so a resting smile or a naturally low brow
// doesn't count, and brief twitches are smoothed away. Scores are kept per comic for recommendations.

const KEY = 'panel-reader-hearts'
export type Hearts = Record<string, { score: number; updated: number }>

export function loadHearts(): Hearts {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveHeart(comicId: string, score: number) {
  try {
    const all = loadHearts()
    all[comicId] = { score: Math.round(score), updated: Date.now() }
    sessionStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // private mode: the score lives for this visit only
  }
}

const FAST = 0.25 // s: smoothing of what you're doing now
const SLOW = 25 // s: your neutral face, learned slowly
const DEADZONE = 0.06
const RATE = 22 // heart points per second at a full-strength expression
const GESTURE = 6

export function useHeart(comicId: string, enabled: boolean) {
  const [score, setScore] = useState(() => loadHearts()[comicId]?.score ?? 50)
  const [trend, setTrend] = useState<-1 | 0 | 1>(0)
  const [status, setStatus] = useState<'off' | 'starting' | 'watching' | 'no-face' | 'denied'>('off')
  const value = useRef(score)

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      return
    }
    let alive = true
    setStatus('starting')
    const fast = { smile: 0, eyeWide: 0, browDown: 0, sneer: 0 }
    const base = { smile: 0, eyeWide: 0, browDown: 0, sneer: 0 }
    let primed = 0
    let lastT = 0
    let lastSave = 0

    const bump = (d: number) => {
      value.current = Math.max(0, Math.min(100, value.current + d))
      setScore(value.current)
      setTrend(d > 0 ? 1 : d < 0 ? -1 : 0)
    }

    const offFrame = onFrame((f) => {
      if (!alive) return
      if (!f.found) {
        setStatus('no-face')
        lastT = 0
        return
      }
      setStatus('watching')
      const dt = lastT ? Math.min(0.2, (f.t - lastT) / 1000) : 0
      lastT = f.t
      if (!dt) return
      for (const k of Object.keys(fast) as (keyof typeof fast)[]) {
        fast[k] += (f[k] - fast[k]) * Math.min(1, dt / FAST)
        // The baseline learns quickly for the first few seconds, then slowly.
        base[k] += (f[k] - base[k]) * Math.min(1, dt / (primed < 3 ? 1 : SLOW))
      }
      primed += dt
      if (primed < 3) return // learn the neutral face first
      const lift = (k: keyof typeof fast) => Math.max(0, fast[k] - base[k] - DEADZONE)
      const like = lift('smile') + 0.8 * lift('eyeWide')
      const dislike = lift('browDown') + 0.6 * lift('sneer')
      const delta = (like - dislike) * RATE * dt
      if (Math.abs(delta) > 0.002) bump(delta)
      else setTrend(0)
      if (f.t - lastSave > 3000) {
        lastSave = f.t
        saveHeart(comicId, value.current)
      }
    })
    const offGesture = onGesture((g) => alive && (g === 'nod' || g === 'shake') && bump(g === 'nod' ? GESTURE : -GESTURE))
    startFace().catch(() => alive && setStatus('denied'))

    return () => {
      alive = false
      offFrame()
      offGesture()
      stopFace()
      saveHeart(comicId, value.current)
    }
  }, [comicId, enabled])

  return { score, trend, status }
}
