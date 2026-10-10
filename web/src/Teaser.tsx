import { useEffect, useRef, useState } from 'react'

// A trailer-style teaser: a few key panels crossfading, with one voiced line landing on the second shot.
// Used by the preview dialog and the startup lineup.

export type TeaserData = {
  teaser: { image: string }[]
  teaserLine: { text: string; audio: string | null; speaker: string | null } | null
}
export const SHOT_MS = 2800
export const teaserMs = (d: TeaserData) => Math.max(3, d.teaser.length) * SHOT_MS

export default function Teaser({ data, waiting }: { data: TeaserData | null; waiting?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [shot, setShot] = useState(0)
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    setShot(0)
    if (!data?.teaser.length) return
    const t = setInterval(() => setShot((s) => (s + 1) % data.teaser.length), SHOT_MS)
    const line = data.teaserLine?.audio
    let a: HTMLAudioElement | null = null
    const cue = line
      ? setTimeout(() => {
          a = new Audio(line)
          a.muted = muted
          audio.current = a
          a.onplay = () => setSpeaking(true)
          a.onended = () => setSpeaking(false)
          a.play().catch(() => setSpeaking(false))
        }, SHOT_MS * 0.6)
      : undefined
    return () => {
      clearInterval(t)
      clearTimeout(cue)
      a?.pause()
      audio.current = null
      setSpeaking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    if (audio.current) audio.current.muted = muted
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
      {data?.teaserLine?.audio && (
        <button type="button" className="teaser-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? '🔇 Unmute' : '🔊 Mute'}
        </button>
      )}
    </div>
  )
}
