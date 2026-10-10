"""Voice pool: ElevenLabs default voices. The API key can't list voices, so the pool is fixed."""

NEUTRAL = "SAz9YHcvj6GT2YYXdXww"  # River: relaxed, gender-neutral; used when the speaker is unknown

# id -> short description the casting agent picks from
POOL: dict[str, str] = {
    "21m00Tcm4TlvDq8ikWAM": "Rachel: young adult woman, American, calm and clear",
    "EXAVITQu4vr4xnSDxMaL": "Sarah: young woman, American, soft and confident",
    "Xb7hH8MSUJpSbSDYk0k2": "Alice: middle-aged woman, British, crisp and authoritative",
    "XrExE9yKIg1WjnnlVkGX": "Matilda: middle-aged woman, American, warm and professional",
    "pFZP5JQG7iQjIQuC4Bku": "Lily: young woman, British, gentle and slightly raspy",
    "cgSgspJ2msm6clMCkdW9": "Jessica: young woman, American, bright and expressive",
    "FGY2WhTYpPnrIDTdsKH5": "Laura: young woman, American, sassy and energetic",
    "XB0fDUnXU5powFXDhCwa": "Charlotte: young woman, Swedish-accented English, cool and composed",
    "nPczCjzI2devNBz1zQrb": "Brian: middle-aged man, American, deep and resonant",
    "onwK4e9ZLuTAKqWW03F9": "Daniel: middle-aged man, British, formal news-presenter tone",
    "iP95p4xoKVk53GoZ742B": "Chris: adult man, American, casual and friendly",
    "cjVigY5qzO86Huf0OWal": "Eric: middle-aged man, American, smooth and trustworthy",
    "TX3LPaxmHKxFdv7VOQHJ": "Liam: young man, American, energetic",
    "bIHbv24MWmeRgasZH58o": "Will: young man, American, relaxed and chill",
    "N2lVS1w4EtoT3dr4eOWO": "Callum: adult man, intense and gravelly",
    "IKne3meq5aSn9XLyUdCD": "Charlie: young adult man, Australian, casual",
    "CwhRBWXzGAHq8TQ4Fs17": "Roger: middle-aged man, American, laid-back and confident",
    "2EiwWnXFnvU5JabPnv8n": "Clyde: older man, American, gravelly war veteran",
    "pNInz6obpgDQGcFmaJgB": "Adam: middle-aged man, American, deep and commanding",
}
