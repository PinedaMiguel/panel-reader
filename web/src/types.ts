// Shared contract between the pipeline (api/) and the reader. Later steps only fill fields.

export type Character = {
  id: string
  name?: string
  description: string
  voiceId?: string | null // null → neutral voice
}

export type Line = {
  speaker: string | null // character id, null when unknown
  text: string
  tagged?: string // text with ElevenLabs audio tags, e.g. "[whispers] ..."
  audio?: string
}

export type Panel = {
  id: string
  image: string
  bbox?: [number, number, number, number]
  order: number
  scene: string // short description, also used as alt text
  narration?: string // audiobook narrator text read before the dialogue
  narrationAudio?: string
  characters: { characterId: string; emotion: string; appearance: string }[]
  lines: Line[]
  sfx?: { prompt: string; audio?: string }[]
  emotionLabels: string[]
}

export type Page = { id: string; image?: string; panels: Panel[] } // image: the full page (uploaded comics)

export type Comic = {
  id: string
  title: string
  lang?: string // set when a translation is applied
  languages?: string[] // translations that already exist
  characters: Character[]
  pages: Page[]
}
