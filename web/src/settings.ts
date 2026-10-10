import { useEffect, useState } from 'react'

export type FontChoice = 'default' | 'atkinson' | 'opendyslexic'
export type ColorMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'contrast' | 'grayscale'

export type Settings = {
  font: FontChoice
  textScale: number // captions and overlays, 1 = default
  color: ColorMode
  emotions: boolean // emotion labels over each panel
  captions: boolean
  lang: string // 'original' or a language code
}

export const DEFAULTS: Settings = {
  font: 'default',
  textScale: 1,
  color: 'none',
  emotions: false,
  captions: true,
  lang: 'original',
}

const KEY = 'panel-reader-settings'
const EVENT = 'panel-reader-settings'

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

let current = load() // also the source of truth when storage is unavailable

// Per-browser reading preferences. Every component using this hook stays in sync.
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(current)

  useEffect(() => {
    const sync = () => setSettings(current)
    window.addEventListener(EVENT, sync)
    return () => window.removeEventListener(EVENT, sync)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.font = settings.font
    root.dataset.color = settings.color
    root.style.setProperty('--text-scale', String(settings.textScale))
  }, [settings])

  const update = (patch: Partial<Settings>) => {
    const next = { ...current, ...patch }
    current = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // private mode: settings still apply for this visit
    }
    setSettings(next)
    window.dispatchEvent(new Event(EVENT))
  }

  return [settings, update]
}
