import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// On-device face sensing (MediaPipe Face Landmarker, served from /mediapipe): no video leaves the browser.
// Each camera frame becomes a FaceFrame of head pose, eye direction and expression scores, which the heart
// meter (passive enjoyment) and hands-free control (head turns, nods and shakes) build on.

export type FaceFrame = {
  t: number // ms
  found: boolean
  yaw: number // degrees, + = head turned to the user's left (screen right)
  pitch: number // degrees, + = looking up
  gaze: { x: number; y: number } // eye direction within the eye openings, roughly -1..1
  smile: number // 0..1
  eyeWide: number // 0..1
  browDown: number // 0..1
  sneer: number // 0..1
  blink: { l: number; r: number } // 0..1 per eye
}

export type Gesture = 'nod' | 'shake' | 'left' | 'right' | 'wink' // left/right: the user's own left/right

type Listener = (f: FaceFrame) => void
type GestureListener = (g: Gesture) => void

let landmarker: FaceLandmarker | null = null
let video: HTMLVideoElement | null = null
let stream: MediaStream | null = null
let running = false
let users = 0
const listeners = new Set<Listener>()
const gestureListeners = new Set<GestureListener>()
let last: FaceFrame | null = null

export const lastFrame = () => last
export const cameraStream = () => stream

export function onFrame(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function onGesture(fn: GestureListener) {
  gestureListeners.add(fn)
  return () => gestureListeners.delete(fn)
}

// Dev only: fake a gesture from the console or a test (`__gesture('nod')`).
if (import.meta.env.DEV)
  Object.assign(window, {
    __gesture: (g: Gesture) => gestureListeners.forEach((fn) => fn(g)),
    __feed: (f: FaceFrame) => detectGestures(f), // simulated head poses, for testing the detectors
  })

// Reference-counted: the camera runs while any feature (heart meter, hands-free control) needs it. One
// shared start, so overlapping starts (React's dev double-mount, the setup handing over to the site) never
// open a second camera or model; stopping waits a moment, so a stop followed by a start keeps it running.
let starting: Promise<void> | null = null
let stopTimer = 0
export async function startFace(): Promise<void> {
  users++
  clearTimeout(stopTimer)
  starting ??= init().catch((e) => {
    starting = null
    throw e
  })
  try {
    await starting
  } catch (e) {
    users = Math.max(0, users - 1)
    throw e
  }
}

async function init() {
  if (!landmarker) {
    const files = await FilesetResolver.forVisionTasks('/mediapipe')
    landmarker = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    })
  }
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
  video = document.createElement('video')
  video.playsInline = true
  video.muted = true
  video.srcObject = stream
  await video.play()
  running = true
  loop()
}

export function stopFace() {
  users = Math.max(0, users - 1)
  if (users > 0) return
  clearTimeout(stopTimer)
  stopTimer = window.setTimeout(async () => {
    await starting?.catch(() => {})
    if (users > 0) return
    running = false
    starting = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    video = null
    last = null
  }, 1000)
}

export const faceRunning = () => running

let lastVideoTime = -1
function loop() {
  if (!running || !video || !landmarker) return
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime
    const t = performance.now()
    const r = landmarker.detectForVideo(video, t)
    const frame = toFrame(r, t)
    last = frame
    detectGestures(frame)
    listeners.forEach((fn) => fn(frame))
  }
  requestAnimationFrame(loop)
}

function toFrame(r: ReturnType<FaceLandmarker['detectForVideo']>, t: number): FaceFrame {
  const lm = r.faceLandmarks?.[0]
  const shapes = r.faceBlendshapes?.[0]?.categories
  if (!lm || !shapes) {
    return { t, found: false, yaw: 0, pitch: 0, gaze: { x: 0, y: 0 }, smile: 0, eyeWide: 0, browDown: 0, sneer: 0, blink: { l: 0, r: 0 } }
  }
  const b = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0
  // Head rotation from the facial transformation matrix (column-major 4x4).
  const m = r.facialTransformationMatrixes?.[0]?.data
  let yaw = 0
  let pitch = 0
  if (m) {
    yaw = (Math.atan2(-m[8], Math.hypot(m[9], m[10])) * 180) / Math.PI
    pitch = (Math.atan2(m[9], m[10]) * 180) / Math.PI
  }
  // Iris position inside each eye opening (landmarks 468/473 = iris centres).
  const eye = (iris: number, outer: number, inner: number, top: number, bottom: number) => {
    const w = lm[inner].x - lm[outer].x
    const h = lm[bottom].y - lm[top].y || 1e-6
    return {
      x: ((lm[iris].x - lm[outer].x) / (w || 1e-6)) * 2 - 1,
      y: ((lm[iris].y - lm[top].y) / h) * 2 - 1,
    }
  }
  const right = eye(468, 33, 133, 159, 145) // the user's right eye (image left)
  const left = eye(473, 362, 263, 386, 374)
  return {
    t,
    found: true,
    yaw,
    pitch,
    gaze: { x: (right.x + left.x) / 2, y: (right.y + left.y) / 2 },
    smile: (b('mouthSmileLeft') + b('mouthSmileRight')) / 2,
    eyeWide: (b('eyeWideLeft') + b('eyeWideRight')) / 2,
    browDown: (b('browDownLeft') + b('browDownRight')) / 2,
    sneer: (b('noseSneerLeft') + b('noseSneerRight')) / 2,
    blink: { l: b('eyeBlinkLeft'), r: b('eyeBlinkRight') },
  }
}

// Nod = up-down swing of the head (pitch), shake = left-right (yaw), within ~1.2 s, the other axis steady.
const WINDOW_MS = 1200
const history: FaceFrame[] = []
let cooldownUntil = 0
function detectGestures(f: FaceFrame) {
  if (!f.found) return
  detectTurn(f)
  detectWink(f)
  history.push(f)
  while (history.length && f.t - history[0].t > WINDOW_MS) history.shift()
  // While turned, or just back from a turn, the swing isn't a shake. 5 frames: slow cameras still count.
  if (f.t < cooldownUntil || turnSince || f.t - lastTurn < WINDOW_MS || f.t - seenSince < 2500 || history.length < 5) return
  const swings = (key: 'yaw' | 'pitch') => {
    const v = history.map((h) => h[key])
    const range = Math.max(...v) - Math.min(...v)
    let turns = 0
    let dir = 0
    for (let i = 1; i < v.length; i++) {
      const d = v[i] - v[i - 1]
      if (Math.abs(d) < 0.6) continue
      const s = Math.sign(d)
      if (dir && s !== dir) turns++
      dir = s
    }
    return { range, turns }
  }
  const p = swings('pitch')
  const y = swings('yaw')
  let g: Gesture | null = null
  if (p.range > 10 && p.turns >= 2 && y.range < p.range * 0.6) g = 'nod'
  else if (y.range > 14 && y.turns >= 2 && p.range < y.range * 0.6) g = 'shake'
  if (g) {
    cooldownUntil = f.t + 1300
    history.length = 0
    turnSince = 0
    gestureListeners.forEach((fn) => fn(g!))
  }
}

// Turn = head turned past TURN_DEG from where it usually rests, and held. A shake swings back too fast to
// count. Holding repeats, so you can move several steps without turning back and forth.
const TURN_DEG = 16
const HOLD_MS = 350
const REPEAT_MS = 700
let restYaw: number | null = null
let seenSince = 0
let prevT = 0
let turnSince = 0
let turnFired = 0
let lastTurn = 0
function detectTurn(f: FaceFrame) {
  // "Facing forward" is learned, never fixed: wherever the head rests relative to the camera. It settles
  // fast when a face appears, then keeps following slowly, even while turned, so a bad start (camera off
  // to one side, caught mid-turn) corrects itself instead of leaving one direction stuck on.
  if (restYaw === null || f.t - prevT > 1000) {
    restYaw = f.yaw
    seenSince = f.t
  }
  const dt = Math.min(0.2, (f.t - prevT) / 1000)
  prevT = f.t
  const off = f.yaw - restYaw
  const tau = f.t - seenSince < 1500 ? 0.4 : Math.abs(off) < TURN_DEG ? 2.5 : 8
  restYaw += off * (dt / tau)
  if (Math.abs(off) < TURN_DEG || f.t < cooldownUntil) {
    if (turnFired) lastTurn = f.t // coming back from a turn
    turnSince = turnFired = 0
    return
  }
  turnSince ||= f.t
  if (f.t - turnSince < HOLD_MS || (turnFired && f.t - turnFired < REPEAT_MS)) return
  turnFired = f.t
  const g: Gesture = off > 0 ? 'right' : 'left' // sign checked on a real webcam: yaw + = turned to the user's right
  gestureListeners.forEach((fn) => fn(g))
}

// Wink = one eye closes clearly more than the other, held briefly. Each eye is measured against its own
// resting level (some faces rest with one eye lower), and the open eye may squint along, as it does in a
// real wink: it only has to move much less than the winking one. A blink moves both alike.
const WINK_MS = 150
const WINK_MIN = 0.35 // the winking eye closes at least this far past its rest
const WINK_RATIO = 1.4 // ...and this many times further than the other eye
const rest = { l: 0.1, r: 0.1 }
let winkSince = 0
let winkFired = 0
// 0..1+, where 1 counts as a wink (also drives the setup's live meter).
export function winkLevel(f: FaceFrame) {
  const dl = f.blink.l - rest.l
  const dr = f.blink.r - rest.r
  const big = Math.max(dl, dr)
  const small = Math.max(0.02, Math.min(dl, dr))
  return Math.min(big / WINK_MIN, big / (WINK_RATIO * small))
}
function detectWink(f: FaceFrame) {
  const { l, r } = f.blink
  if (Math.max(l, r) < 0.3) {
    rest.l += (l - rest.l) * 0.03 // both open: learn each eye's resting level
    rest.r += (r - rest.r) * 0.03
  }
  if (winkLevel(f) < 1) {
    winkSince = 0
    return
  }
  winkSince ||= f.t
  if (f.t - winkSince < WINK_MS || f.t - winkFired < 1200) return
  winkFired = f.t
  gestureListeners.forEach((fn) => fn('wink'))
}
