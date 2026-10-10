import { useEffect, useState } from 'react'
import type { Character, Panel } from './types'

export type Caption = { speaker: string; speakerId: string | null; text: string }

type Item = Caption & { audio?: string }

const SFX_VOLUME = 0.35
const LOOK_MS = 3000 // time to take in a panel when nothing is spoken
const MAX_SFX_WAIT_MS = 4500 // longer effects fade out on the page turn

// Plays the active panel: the narrator's description (audiobook mode only), then each line of
// dialogue, with SFX underneath. Calls onDone when the panel is finished so the reader turns the page.
export function usePanelAudio(
  panel: Panel | undefined,
  characters: Character[],
  listening: boolean,
  narration: boolean,
  onDone: () => void,
  onBlocked?: () => void, // the browser refused to autoplay (no user gesture yet)
) {
  const [caption, setCaption] = useState<Caption | null>(null)

  useEffect(() => {
    if (!panel || !listening) {
      setCaption(null)
      return
    }
    const names = new Map(characters.map((c) => [c.id, c.name ?? c.id]))
    const items: Item[] = [
      ...(narration && panel.narration
        ? [{ speaker: 'Narrator', speakerId: null, text: panel.narration, audio: panel.narrationAudio }]
        : []),
      ...panel.lines.map((l) => ({
        speaker: (l.speaker && names.get(l.speaker)) || 'Unknown',
        speakerId: l.speaker,
        text: l.text,
        audio: l.audio,
      })),
    ]

    let cancelled = false
    let current: HTMLAudioElement | null = null
    const sfx = (panel.sfx ?? []).filter((s) => s.audio).map((s) => new Audio(s.audio))
    const sfxDone = Promise.all(
      sfx.map(
        (a) =>
          new Promise<void>((resolve) => {
            a.volume = SFX_VOLUME
            a.onended = () => resolve()
            a.onerror = () => resolve()
            a.play().catch(() => resolve())
          }),
      ),
    )
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

    const speak = (item: Item) =>
      new Promise<void>((resolve) => {
        if (item.audio) {
          current = new Audio(item.audio)
          current.onended = () => resolve()
          current.onerror = () => resolve()
          current.play().catch((e) => {
            if (e?.name === 'NotAllowedError') {
              cancelled = true // don't race silently through the queue
              onBlocked?.()
            }
            resolve()
          })
        } else {
          // No rendered clip (quota ran out, or not generated yet): use the browser's voice.
          const u = new SpeechSynthesisUtterance(item.text)
          u.onend = () => resolve()
          u.onerror = () => resolve()
          speechSynthesis.speak(u)
        }
      })

    ;(async () => {
      for (const item of items) {
        if (cancelled) return
        setCaption(item)
        await speak(item)
      }
      if (!items.length) {
        // Nothing to say (or narrator off on a silent panel): give the art a moment, and let any
        // sound effect finish, within reason.
        await Promise.all([wait(LOOK_MS), Promise.race([sfxDone, wait(MAX_SFX_WAIT_MS)])])
      }
      if (!cancelled) {
        setCaption(null)
        onDone()
      }
    })()

    return () => {
      cancelled = true
      current?.pause()
      speechSynthesis.cancel()
      // Fade sound effects out instead of cutting them off mid-sound.
      sfx.forEach((a) => {
        const step = a.volume / 8
        const t = setInterval(() => {
          a.volume = Math.max(0, a.volume - step)
          if (a.volume <= 0) {
            clearInterval(t)
            a.pause()
          }
        }, 50)
      })
    }
    // onDone is read fresh each run; restarting playback when it changes identity would cut audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, listening, narration, characters])

  return caption
}
