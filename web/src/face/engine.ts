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
}

export type Gesture = 'nod' | 'shake' | 'left' | 'right' // left/right: the user's own left/right

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
if (import.meta.env.DEV) Object.assign(window, { __gesture: (g: Gesture) => gestureListeners.forEach((fn) => fn(g)) })

// Reference-counted: the camera runs while any feature (heart meter, gaze control) needs it.
export async function startFace(): Promise<void> {
  users++
  if (running) return
  running = true
  try {
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
    loop()
  } catch (e) {
    running = false
    users = Math.max(0, users - 1)
    throw e
  }
}

export function stopFace() {
  users = Math.max(0, users - 1)
  if (users > 0) return
  running = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video = null
  last = null
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
    return { t, found: false, yaw: 0, pitch: 0, gaze: { x: 0, y: 0 }, smile: 0, eyeWide: 0, browDown: 0, sneer: 0 }
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
  }
}

// Nod = up-down swing of the head (pitch), shake = left-right (yaw), within ~1.2 s, the other axis steady.
const WINDOW_MS = 1200
const history: FaceFrame[] = []
let cooldownUntil = 0
function detectGestures(f: FaceFrame) {
  if (!f.found) return
  detectTurn(f)
  history.push(f)
  while (history.length && f.t - history[0].t > WINDOW_MS) history.shift()
  if (f.t < cooldownUntil || f.t - lastTurn < WINDOW_MS || history.length < 8) return // turning back isn't a shake
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
let turnSince = 0
let turnFired = 0
let lastTurn = 0
function detectTurn(f: FaceFrame) {
  restYaw ??= f.yaw
  const off = f.yaw - restYaw
  if (Math.abs(off) < TURN_DEG / 2) restYaw += off * 0.02 // follow slow posture changes while facing forward
  if (Math.abs(off) < TURN_DEG || f.t < cooldownUntil) {
    turnSince = turnFired = 0
    return
  }
  turnSince ||= f.t
  if (f.t - turnSince < HOLD_MS || (turnFired && f.t - turnFired < REPEAT_MS)) return
  turnFired = lastTurn = f.t
  const g: Gesture = off > 0 ? 'left' : 'right' // yaw + = turned to the user's left
  gestureListeners.forEach((fn) => fn(g))
}
