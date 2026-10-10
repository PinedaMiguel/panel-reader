import type { Hearts } from './face/heart'

// Picks from the heart meter and Gemini's genre/mood tags. Used by the home rows and "playing next".

export type Listed = {
  id: string
  title: string
  panels: number
  voices?: number
  languages?: string[]
  cover?: string | null
  genres?: string[] | null
  moods?: string[] | null
}

export const tags = (c: Listed) => [...(c.genres ?? []), ...(c.moods ?? [])]

// Tone: above 0 is dark (horror, crime, tense), below 0 light (comedy, wholesome, whimsical). Only the
// sign and order matter.
const DARK = /horror|thrill|crime|noir|myster|suspens|dark|tense|grit|eerie|creep|chill|macabre|sinister|spook|ominous|grim|\bwar\b|political|conspira|supernatural|menac/
const LIGHT = /comed|humor|humour|funny|wholesome|whims|light|playful|heartwarm|cozy|charm|silly|feel-good|cheer|family|child|fairy|dream|gentle|sweet|fantasy/
export const tone = (c: Listed) =>
  tags(c).reduce((t, w) => t + (DARK.test(w.toLowerCase()) ? 1 : 0) - (LIGHT.test(w.toLowerCase()) ? 1 : 0), 0)

const LIKED = 55
const DISLIKED = 45

// What to play after finishing `done`, and why, in words a viewer reads in a second.
export function upNext(done: Listed, list: Listed[], hearts: Hearts): { show: Listed; reason: string; score: number } | null {
  const score = hearts[done.id]?.score ?? 50
  const others = list.filter((c) => c.id !== done.id && c.cover)
  if (!others.length) return null
  const unseen = (c: Listed) => (hearts[c.id] ? 0 : 1) // tie-break: something new
  const mine = new Set(tags(done))
  const shared = (c: Listed) => tags(c).filter((t) => mine.has(t))
  const words = (ws: string[]) => ws.slice(0, 2).join(', ').toLowerCase()

  if (score < DISLIKED) {
    const away = tone(done) > 0 ? -1 : 1 // dark → light, light → dark
    const show = [...others].sort((a, b) => away * (tone(b) - tone(a)) || shared(a).length - shared(b).length || unseen(b) - unseen(a))[0]
    return {
      show,
      score,
      reason: `Because ${done.title} didn’t click for you, here’s something ${away < 0 ? 'lighter' : 'with more bite'}: ${words(show.moods?.length ? show.moods : tags(show))}.`,
    }
  }
  const show = [...others].sort((a, b) => shared(b).length - shared(a).length || unseen(b) - unseen(a) || Math.abs(tone(a) - tone(done)) - Math.abs(tone(b) - tone(done)))[0]
  const common = shared(show)
  const why = common.length ? `it’s also ${words(common)}` : `it’s ${words(tags(show))}`
  return { show, score, reason: score >= LIKED ? `Because you liked ${done.title}: ${why}.` : `Because you watched ${done.title}: ${why}.` }
}
