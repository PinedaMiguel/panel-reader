import { useEffect, useState } from 'react'
import Lineup, { LINEUP_SKIP, type LineupShow } from './Lineup'
import { useSettings } from './settings'

// The start page (/): the lineup, dealt again (three other shows) whenever you ask for other picks. It never
// sends you to the gallery; that lives at /gallery for whoever types it.
export default function Start() {
  const [settings] = useSettings()
  const [comics, setComics] = useState<LineupShow[] | null>(null)
  const [deal, setDeal] = useState<{ round: number; skip: string[] }>(() => {
    try {
      const s = sessionStorage.getItem(LINEUP_SKIP) // the show just finished, when "Other picks" brought you here
      return { round: 0, skip: s ? [s] : [] }
    } catch {
      return { round: 0, skip: [] }
    }
  })

  useEffect(() => {
    try {
      sessionStorage.removeItem(LINEUP_SKIP)
    } catch {
      // nothing stored
    }
    fetch('/api/comics')
      .then((r) => (r.ok ? r.json() : []))
      .then(setComics)
      .catch(() => setComics([]))
  }, [])

  return (
    <div className="start">
      {settings.onboarded && comics && comics.length > 0 && (
        <Lineup key={deal.round} comics={comics} skip={deal.skip} onOther={(shown) => setDeal((d) => ({ round: d.round + 1, skip: shown }))} />
      )}
    </div>
  )
}
