import { useEffect, useRef, useState } from 'react'
import type { Character, Panel } from './types'

export type Caption = { speaker: string; speakerId: string | null; text: string }

type Item = Caption & { audio?: string; kind: 'narration' | 'line' }

const SFX_VOLUME = 0.35

// Browser voice: speak in the comic's language (translations), with an installed voice for it.
const LOCALES: Record<string, string> = {
  original: 'en-US', es: 'es-ES', fr: 'fr-FR', pt: 'pt-BR', de: 'de-DE', ja: 'ja-JP', hi: 'hi-IN', zh: 'zh-CN',
}

function browserVoice(lang: string): { locale: string; voice: SpeechSynthesisVoice | null } {
  const locale = LOCALES[lang] ?? lang
  const voices = speechSynthesis.getVoices()
  const base = locale.split('-')[0].toLowerCase()
  const same = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base))
  const exact = same.filter((v) => v.lang.toLowerCase().replace('_', '-') === locale.toLowerCase())
  // Prefer the exact regional voice, then any voice for the language; local voices first (no network).
  const pick = (list: SpeechSynthesisVoice[]) => list.find((v) => v.localService) ?? list[0] ?? null
  return { locale, voice: pick(exact) ?? pick(same) }
}

// getVoices() is empty until the browser has loaded its voice list.
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.getVoices()
  speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices())
}
const LOOK_MS = 3000 // nothing to say: time to take in the art
const MAX_SFX_WAIT_MS = 4500 // longer effects fade out on the page turn

type Runner = {
  panel: string
  pause: () => void
  resume: () => void
  stop: () => void
  skipNarration: () => void
}

// Plays the active panel as a queue: the narrator's description (audiobook mode only), then each line
// of dialogue, with sound effects underneath. The queue survives pause/resume (it picks up mid-clip) and
// reads audiobook mode live: turning it off cuts the current narration and moves on to the dialogue;
// turning it on only affects narration still ahead. Panels with nothing to say get a short look plus
// their sound effects in either mode. Calls onDone when the panel is finished so the reader turns the page.
export function usePanelAudio(
  panel: Panel | undefined,
  characters: Character[],
  playing: boolean,
  audiobook: boolean,
  lang: string, // 'original' or a translation code: the browser voice speaks this language
  onDone: () => void,
  onBlocked?: () => void, // the browser refused to autoplay (no user gesture yet)
) {
  const [caption, setCaption] = useState<Caption | null>(null)
  const runner = useRef<Runner | null>(null)
  const audiobookRef = useRef(audiobook)
  const langRef = useRef(lang)
  langRef.current = lang
  const onDoneRef = useRef(onDone)
  const onBlockedRef = useRef(onBlocked)
  onDoneRef.current = onDone
  onBlockedRef.current = onBlocked

  // New panel: the old queue is finished for good.
  useEffect(() => {
    return () => {
      runner.current?.stop()
      runner.current = null
      setCaption(null)
    }
  }, [panel, characters])

  useEffect(() => {
    if (!panel) return
    if (!playing) return runner.current?.pause()
    if (runner.current?.panel === panel.id) return runner.current.resume()
    runner.current = start(panel, characters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, panel, characters])

  useEffect(() => {
    audiobookRef.current = audiobook
    if (!audiobook) runner.current?.skipNarration()
  }, [audiobook])

  function start(panel: Panel, characters: Character[]): Runner {
    const names = new Map(characters.map((c) => [c.id, c.name ?? c.id]))
    const items: Item[] = [
      ...(panel.narration
        ? [{ kind: 'narration' as const, speaker: 'Narrator', speakerId: null, text: panel.narration, audio: panel.narrationAudio }]
        : []),
      ...panel.lines.map((l) => ({
        kind: 'line' as const,
        speaker: (l.speaker && names.get(l.speaker)) || 'Unknown',
        speakerId: l.speaker,
        text: l.text,
        audio: l.audio,
      })),
    ]

    let stopped = false
    let paused = false
    const waiters: (() => void)[] = []
    let currentAudio: HTMLAudioElement | null = null
    let speakingAloud = false // browser speech fallback in progress
    let currentKind: Item['kind'] | null = null
    let finishCurrent: (() => void) | null = null
    let sfx: HTMLAudioElement[] = []

    const gate = () => (paused ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve())
    // A wait that stands still while paused.
    const hold = async (ms: number, until?: () => boolean) => {
      for (let t = 0; t < ms && !stopped && !until?.(); t += 100) {
        await gate()
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    const speak = (item: Item) =>
      new Promise<void>((resolve) => {
        currentKind = item.kind
        finishCurrent = () => {
          currentAudio?.pause()
          if (speakingAloud) speechSynthesis.cancel()
          resolve()
        }
        if (item.audio) {
          const a = (currentAudio = new Audio(item.audio))
          a.onended = () => resolve()
          a.onerror = () => resolve()
          a.play().catch((e) => {
            if (e?.name === 'NotAllowedError') onBlockedRef.current?.() // the reader pauses; Play retries
            else resolve()
          })
        } else {
          // No rendered clip (quota ran out, or not generated yet): use the browser's voice.
          const u = new SpeechSynthesisUtterance(item.text)
          const { locale, voice } = browserVoice(langRef.current)
          u.lang = locale
          if (voice) u.voice = voice
          speakingAloud = true
          u.onend = u.onerror = () => {
            speakingAloud = false
            resolve()
          }
          speechSynthesis.speak(u)
        }
      }).finally(() => {
        currentAudio = null
        currentKind = null
        finishCurrent = null
      })

    ;(async () => {
      sfx = (panel.sfx ?? []).filter((s) => s.audio).map((s) => new Audio(s.audio))
      let sfxDone = !sfx.length
      Promise.all(
        sfx.map(
          (a) =>
            new Promise<void>((resolve) => {
              a.volume = SFX_VOLUME
              a.onended = a.onerror = () => resolve()
              a.play().catch(() => resolve())
            }),
        ),
      ).then(() => (sfxDone = true))

      let spoken = 0
      for (const item of items) {
        await gate()
        if (stopped) return
        // Read the mode at the moment the narration would start: never go back for one already passed.
        if (item.kind === 'narration' && !audiobookRef.current) continue
        setCaption(item)
        spoken++
        await speak(item)
        if (stopped) return
      }
      setCaption(null)
      if (!spoken) {
        // Nothing to say (no dialogue, narrator off or absent): give the art a moment and let a sound
        // effect finish, within reason.
        await hold(LOOK_MS)
        await hold(MAX_SFX_WAIT_MS - LOOK_MS, () => sfxDone)
      }
      await gate()
      if (!stopped) onDoneRef.current()
    })()

    return {
      panel: panel.id,
      pause() {
        paused = true
        currentAudio?.pause()
        if (speakingAloud) speechSynthesis.pause()
        sfx.forEach((a) => a.pause())
      },
      resume() {
        if (!paused) return
        paused = false
        currentAudio?.play().catch(() => {})
        if (speakingAloud) speechSynthesis.resume()
        sfx.forEach((a) => !a.ended && a.play().catch(() => {}))
        waiters.splice(0).forEach((r) => r())
      },
      stop() {
        stopped = true
        currentAudio?.pause()
        speechSynthesis.cancel()
        waiters.splice(0).forEach((r) => r())
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
      },
      skipNarration() {
        if (currentKind === 'narration') finishCurrent?.()
      },
    }
  }

  return caption
}
