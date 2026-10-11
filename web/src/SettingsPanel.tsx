import { useEffect, useRef } from 'react'
import { useSettings, type ColorMode, type FontChoice } from './settings'

const FONTS: [FontChoice, string][] = [
  ['default', 'Default'],
  ['atkinson', 'Atkinson (low vision)'],
  ['opendyslexic', 'OpenDyslexic (dyslexia)'],
]

const COLORS: [ColorMode, string][] = [
  ['none', 'Original'],
  ['protanopia', 'Red-blind'],
  ['deuteranopia', 'Green-blind'],
  ['tritanopia', 'Blue-blind'],
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

      <Choice label="Font" value={s.font} options={FONTS} onPick={(font) => set({ font })} />

      <div className="choice" role="group" aria-labelledby="caption-size">
        <span id="caption-size">Caption size: {Math.round(s.textScale * 100)}%</span>
        <div className="choice-row">
          <button type="button" aria-label="Smaller captions" disabled={s.textScale <= 0.8}
            onClick={() => set({ textScale: Math.max(0.8, +(s.textScale - 0.2).toFixed(1)) })}>
            A−
          </button>
          <button type="button" aria-label="Larger captions" disabled={s.textScale >= 2}
            onClick={() => set({ textScale: Math.min(2, +(s.textScale + 0.2).toFixed(1)) })}>
            A+
          </button>
        </div>
      </div>

      <Choice label="Colours" value={s.color} options={COLORS} onPick={(color) => set({ color })} />

      {languages && Object.keys(languages).length > 0 && (
        <Choice
          label="Language"
          value={s.lang}
          options={[['original', 'Original'], ...Object.entries(languages)]}
          onPick={(lang) => set({ lang })}
        />
      )}
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
          Hands-free: turn my head (right = yes, left = no)
        </label>
        <button type="button" className="recalibrate" onClick={() => (onClose(), set({ onboarded: false }))}>
          Run face setup again
        </button>
      </fieldset>

      <form method="dialog">
        <button type="submit">Done</button>
      </form>
    </dialog>
  )
}

// Buttons instead of a <select>: a native dropdown can't be opened or picked from hands-free.
function Choice<T extends string>({ label, value, options, onPick }: {
  label: string
  value: T
  options: [T, string][]
  onPick: (v: T) => void
}) {
  return (
    <div className="choice" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="choice-row">
        {options.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={v === value} onClick={() => onPick(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
