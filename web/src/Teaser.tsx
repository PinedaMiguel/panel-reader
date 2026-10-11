import { useEffect, useRef, useState } from 'react'

// The preview's opening: a film-style trailer when the comic has one (see api/trailer.py), else the older
// teaser (a few key panels crossfading, with one voiced line). Used by the preview dialog and the lineup.

type Shot = {
  image: string
  card: string | null
  voice: string | null
  voiceText: string | null
  line: { text: string; speaker: string | null; audio: string } | null
  hit: string | null
  ms: number
}
export type Trailer = { shots: Shot[]; tagline: string; music: string; finalMs: number; totalMs: number }
export type TeaserData = {
  title?: string
  teaser: { image: string }[]
  teaserLine: { text: string; audio: string | null; speaker: string | null } | null
  trailer?: Trailer | null
}
export const SHOT_MS = 2800
export const teaserMs = (d: TeaserData) => d.trailer?.totalMs ?? Math.max(3, d.teaser.length) * SHOT_MS

export default function Teaser({ data, waiting }: { data: TeaserData | null; waiting?: string }) {
  if (data?.trailer) return <TrailerPlayer key={data.trailer.music} trailer={data.trailer} title={data.title ?? ''} />
  return <OldTeaser data={data} waiting={waiting} />
}

const MUSIC = 0.5
const DUCKED = 0.16 // music under the voice

// Cuts between the chosen panels with a slow push-in on each, impact flashes and title cards; music under
// it all, ducked while the narrator or a character speaks; what's said is captioned. Ends on a title card.
function TrailerPlayer({ trailer, title }: { trailer: Trailer; title: string }) {
  const [i, setI] = useState(0) // shot index; shots.length = the closing title card
  const [said, setSaid] = useState<{ who: string | null; text: string } | null>(null)
  const [muted, setMuted] = useState(false)
  const playing = useRef<HTMLAudioElement[]>([])
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  useEffect(() => {
    const timers: number[] = []
    const play = (src: string, volume: number) => {
      const a = new Audio(src)
      a.volume = volume
      a.muted = mutedRef.current
      playing.current.push(a)
      a.play().catch(() => {})
      return a
    }
    const music = play(trailer.music, MUSIC)
    let at = 0
    trailer.shots.forEach((s, k) => {
      timers.push(window.setTimeout(() => {
        setI(k)
        setSaid(null)
        if (s.hit) play(s.hit, 0.8)
        const talk = s.voice ?? s.line?.audio
        if (!talk) return
        timers.push(window.setTimeout(() => {
          const a = play(talk, 1)
          music.volume = DUCKED
          setSaid(s.voice ? { who: null, text: s.voiceText ?? '' } : { who: s.line!.speaker, text: s.line!.text })
          a.onended = () => {
            music.volume = MUSIC
            setSaid(null)
          }
        }, 150))
      }, at))
      at += s.ms
    })
    timers.push(window.setTimeout(() => {
      setI(trailer.shots.length)
      setSaid(null)
      music.volume = MUSIC
    }, at))
    return () => {
      timers.forEach(clearTimeout)
      playing.current.forEach((a) => a.pause())
      playing.current = []
    }
  }, [trailer])

  useEffect(() => playing.current.forEach((a) => (a.muted = muted)), [muted])

  const shot = trailer.shots[i]
  return (
    <div className="teaser trailer" aria-label={`Trailer for ${title}`}>
      {trailer.shots.map((s, k) => (
        <img key={k} src={s.image} alt="" className={`${k === i ? 'on' : ''} kb${k % 3}`} />
      ))}
      {shot?.hit && <span key={`flash${i}`} className="trailer-flash" aria-hidden="true" />}
      {shot?.card && (
        <p key={`card${i}`} className="trailer-card">
          {shot.card}
        </p>
      )}
      {!shot && (
        <div className="trailer-end">
          <p className="trailer-title">{title}</p>
          <p className="trailer-tagline">{trailer.tagline}</p>
        </div>
      )}
      {said && (
        <p className={`trailer-said${said.who ? '' : ' narrator'}`} aria-live="polite">
          {said.who && <b>{said.who}</b>}
          {said.text}
        </p>
      )}
      <button type="button" className="teaser-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
        {muted ? '🔇 Unmute' : '🔊 Mute'}
      </button>
    </div>
  )
}

function OldTeaser({ data, waiting }: { data: TeaserData | null; waiting?: string }) {
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
