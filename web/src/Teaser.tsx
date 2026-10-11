import { useEffect, useRef, useState } from 'react'

// A trailer-style teaser: a few key panels crossfading, with one voiced line landing on the second shot, over
// the comic's mood-matched music bed (quiet, dipping under the line). Used by the preview dialog and the lineup.

export type TeaserData = {
  teaser: { image: string }[]
  teaserLine: { text: string; audio: string | null; speaker: string | null } | null
  music?: string | null
}
const MUSIC = 0.32
const DUCKED = 0.1
export const SHOT_MS = 2800
export const teaserMs = (d: TeaserData) => Math.max(3, d.teaser.length) * SHOT_MS

export default function Teaser({ data, waiting, paused = false }: { data: TeaserData | null; waiting?: string; paused?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const music = useRef<HTMLAudioElement | null>(null)
  const [shot, setShot] = useState(0)
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => setShot(0), [data])
  useEffect(() => {
    if (!data?.teaser.length || paused) return
    const t = setInterval(() => setShot((s) => (s + 1) % data.teaser.length), SHOT_MS)
    return () => clearInterval(t)
  }, [data, paused])

  // Paused (looking up in the lineup): hold the music and the line where they are.
  useEffect(() => {
    for (const a of [audio.current, music.current]) {
      if (!a) continue
      if (paused) a.pause()
      else if (!a.ended) a.play().catch(() => {})
    }
  }, [paused])

  useEffect(() => {
    if (!data?.teaser.length) return
    const line = data.teaserLine?.audio
    let a: HTMLAudioElement | null = null
    const bed = data.music ? new Audio(data.music) : null
    if (bed) {
      bed.volume = MUSIC
      bed.muted = muted
      music.current = bed
      if (!pausedRef.current) bed.play().catch(() => {})
    }
    const cue = line
      ? setTimeout(() => {
          a = new Audio(line)
          a.muted = muted
          audio.current = a
          a.onplay = () => {
            if (pausedRef.current) return a?.pause() // its cue came while paused: wait for resume
            setSpeaking(true)
            if (bed) bed.volume = DUCKED
          }
          a.onended = () => {
            setSpeaking(false)
            if (bed) bed.volume = MUSIC
          }
          a.play().catch(() => setSpeaking(false))
        }, SHOT_MS * 0.6)
      : undefined
    return () => {
      clearTimeout(cue)
      a?.pause()
      bed?.pause()
      audio.current = null
      music.current = null
      setSpeaking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    if (audio.current) audio.current.muted = muted
    if (music.current) music.current.muted = muted
  }, [muted])

  return (
    <div className="teaser" aria-hidden={!data}>
      {data?.teaser.map((p, i) => (
        <img key={p.image} src={p.image} alt="" className={i === shot ? 'on' : ''} />
      ))}
      {!data && waiting && <p className="teaser-wait">{waiting}</p>}
      {data?.teaserLine && (
        <p className={`teaser-line${speaking ? ' on' : ''}`}>
          {data.teaserLine.speaker && <b>{data.teaserLine.speaker}</b>}“{data.teaserLine.text}”
        </p>
      )}
      {(data?.teaserLine?.audio || data?.music) && (
        <button type="button" className="teaser-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? '🔇 Unmute' : '🔊 Mute'}
        </button>
      )}
    </div>
  )
}
