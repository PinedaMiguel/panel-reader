import { useEffect, useRef } from 'react'
import { useSettings, type ColorMode, type FontChoice } from './settings'

const FONTS: [FontChoice, string][] = [
  ['default', 'Default'],
  ['atkinson', 'Atkinson Hyperlegible (low vision)'],
  ['opendyslexic', 'OpenDyslexic (dyslexia)'],
]

const COLORS: [ColorMode, string][] = [
  ['none', 'Original colours'],
  ['protanopia', 'Protanopia (red-blind) correction'],
  ['deuteranopia', 'Deuteranopia (green-blind) correction'],
  ['tritanopia', 'Tritanopia (blue-blind) correction'],
  ['contrast', 'High contrast'],
  ['grayscale', 'Grayscale'],
]

type Props = {
  open: boolean
  onClose: () => void
  languages: Record<string, string> | null // null: this comic can't be translated (local file)
  translating: string | null // progress text while a translation is being made
}

export default function SettingsPanel({ open, onClose, languages, translating }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [s, set] = useSettings()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog ref={ref} className="settings" onClose={onClose} aria-labelledby="settings-title">
      <h2 id="settings-title">Reading settings</h2>

      <label>
        Font
        <select value={s.font} onChange={(e) => set({ font: e.target.value as FontChoice })}>
          {FONTS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>

      <label>
        Caption size: {Math.round(s.textScale * 100)}%
        <input
          type="range"
          min={0.8}
          max={2}
          step={0.1}
          value={s.textScale}
          onChange={(e) => set({ textScale: Number(e.target.value) })}
        />
      </label>

      <label>
        Colours
        <select value={s.color} onChange={(e) => set({ color: e.target.value as ColorMode })}>
          {COLORS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>

      <label>
        Language
        <select
          value={languages ? s.lang : 'original'}
          disabled={!languages}
          onChange={(e) => set({ lang: e.target.value })}
        >
          <option value="original">Original</option>
          {languages &&
            Object.entries(languages).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
        </select>
      </label>
      {!languages && <p className="note">Translation is available for uploaded comics.</p>}
      {translating && (
        <p className="note" role="status">
          {translating}
        </p>
      )}

      <label className="check">
        <input type="checkbox" checked={s.captions} onChange={(e) => set({ captions: e.target.checked })} />
        Show captions while listening
      </label>

      <label className="check">
        <input type="checkbox" checked={s.emotions} onChange={(e) => set({ emotions: e.target.checked })} />
        Show emotion labels on panels
      </label>

      <fieldset className="camera-opts">
        <legend>Camera features (on this device only)</legend>
        <label className="check">
          <input type="checkbox" checked={s.heart} onChange={(e) => set({ heart: e.target.checked })} />
          Heart meter: learn what I enjoy from my expressions
        </label>
        <label className="check">
          <input type="checkbox" checked={s.gaze} onChange={(e) => set({ gaze: e.target.checked })} />
          Hands-free: control with my eyes and head
        </label>
      </fieldset>

      <form method="dialog">
        <button type="submit">Done</button>
      </form>
    </dialog>
  )
}
