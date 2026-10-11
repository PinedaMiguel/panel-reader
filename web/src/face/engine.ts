import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// On-device face sensing (MediaPipe Face Landmarker, served from /mediapipe): no video leaves the browser.
// Each camera frame becomes a FaceFrame of head pose, eye direction and expression scores, which the heart
// meter (passive enjoyment) and hands-free control (head turns, nods and shakes) build on.

export type FaceFrame = {
  t: number // ms
  found: boolean
  yaw: number // degrees, + = head turned to the user's right (confirmed on a real webcam)
  pitch: number // degrees, + = looking up
  gaze: { x: number; y: number } // eye direction within the eye openings, roughly -1..1
  smile: number // 0..1
  eyeWide: number // 0..1
  browDown: number // 0..1
  sneer: number // 0..1
  blink: { l: number; r: number } // 0..1 per eye
  jaw: number // 0..1 mouth open (moving = talking)
  faces: number // faces in view (a second one pauses control)
  tongue: number // 0..1 tongue out
  browUp: number // 0..1 eyebrows raised
}

export type Gesture = 'left' | 'right' // the user's own left/right: right = yes, left = no

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

// Dev only: fake a gesture from the console or a test (`__gesture('right')`).
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
      numFaces: 2, // a second face (someone leaning in) pauses control
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
    return { t, found: false, yaw: 0, pitch: 0, gaze: { x: 0, y: 0 }, smile: 0, eyeWide: 0, browDown: 0, sneer: 0, blink: { l: 0, r: 0 }, jaw: 0, faces: 0, tongue: 0, browUp: 0 }
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
    jaw: b('jawOpen'),
    tongue: b('tongueOut'),
    browUp: (b('browInnerUp') + b('browOuterUpLeft') + b('browOuterUpRight')) / 3,
    faces: r.faceLandmarks?.length ?? 0,
  }
}

// ---- Gestures ----
// Just two: turn right = yes, turn left = no. Every turn passes one gate (fire). Nothing acts while control
// is paused (looking away, face lost, a second face, the presenter's H key), during the grace after a screen
// change, or before the head has re-armed: back in the centre and still after the previous turn. So one
// movement is one action, a leftover turn after a screen change does nothing, and resting never repeats.

export type ControlState = 'ready' | 'wait' | 'away' | 'others' | 'paused'
const WINDOW_MS = 1200 // recent frames kept (stillness check)
const ARM_MS = 400 // centred and still this long re-arms
const STILL_DEG = 4
const TURN_DEG = 16
const AWAY_DEG = 38 // turned further than this...
const AWAY_MS = 2500 // ...for this long (or the face lost this long) = looking at someone else, not a gesture
const HOLD_MS = 350
const RESUME_MS = 1000 // facing the screen this long after looking away resumes control
const POSTURE_MS = 12000
const history: FaceFrame[] = []
let armed = false
let graceUntil = 0
let manual = false
let away: 'away' | 'others' | null = null
let backSince = 0
let lostSince = 0
let farSince = 0
let state: ControlState = 'wait'
let lastT = 0 // time of the latest frame, so pauses line up with the frames they apply to
const stateListeners = new Set<(s: ControlState) => void>()

export const controlState = () => state
export function onControlState(fn: (s: ControlState) => void) {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}
// A new screen: ignore gestures for a moment, then wait for the head to re-arm.
export function pauseGestures(ms = 1200) {
  graceUntil = Math.max(performance.now(), lastT) + ms
  armed = false
}
// The presenter's H key: freeze hands-free control while talking to people, and back.
export function toggleManualPause() {
  manual = !manual
  armed = false
  setState(manual ? 'paused' : 'wait')
}
function setState(next: ControlState) {
  if (next === state) return
  state = next
  stateListeners.forEach((fn) => fn(next))
}

function fire(g: Gesture, f: FaceFrame) {
  if (manual || away || !armed || f.t < graceUntil) return
  armed = false
  history.length = 0
  gestureListeners.forEach((fn) => fn(g))
}

const recent = (f: FaceFrame, ms: number) => history.filter((h) => f.t - h.t <= ms)
const spread = (hs: FaceFrame[], key: 'yaw' | 'pitch' | 'jaw') => {
  const v = hs.map((h) => h[key])
  return v.length ? Math.max(...v) - Math.min(...v) : 0
}

function detectGestures(f: FaceFrame) {
  lastT = f.t
  if (!f.found) {
    lostSince ||= f.t
    if (f.t - lostSince > AWAY_MS) away = 'away' // a big turn can lose the face for a moment: that's not away
    if (turnSince) wentFar = true // lost mid-turn: it was a big one
    backSince = 0
    setState(manual ? 'paused' : away ?? state)
    return
  }
  lostSince = 0
  history.push(f)
  while (history.length && f.t - history[0].t > WINDOW_MS) history.shift()
  const off = learnRest(f)
  // Still = the last ARM_MS (fully covered by frames) moved less than STILL_DEG on both axes.
  const win = recent(f, ARM_MS)
  const still = win.length >= 3 && f.t - win[0].t >= ARM_MS - 100 && spread(win, 'yaw') < STILL_DEG && spread(win, 'pitch') < STILL_DEG
  const centred = Math.abs(off) < TURN_DEG / 2

  // Looking away (turned past AWAY_DEG), or someone else in view: pause until you face the screen again.
  // Only a sustained big turn is looking away; a quick one, however far, is a gesture.
  farSince = Math.abs(off) > AWAY_DEG ? farSince || f.t : 0
  if (f.faces > 1) away = 'others'
  else if (farSince && f.t - farSince > AWAY_MS) away = 'away'
  else if (away && !farSince) {
    backSince = centred && still ? backSince || f.t : 0
    if (backSince && f.t - backSince > RESUME_MS) {
      away = null
      backSince = 0
      armed = false
    }
  }


  if (!armed && !manual && !away && f.t >= graceUntil && centred && still) {
    armed = true
    history.length = 0 // only movement after re-arming counts (no replaying the end of the last nod)
  }

  detectTurn(f, off)
  setState(manual ? 'paused' : away ? away : !armed ? 'wait' : 'ready')
}

// "Facing forward" is learned: quickly when a face first appears, then only slowly and only while you
// face roughly forward. It survives brief face loss; it is re-learned after 10 s without a face, or if
// you've stayed turned (but not looking away) for POSTURE_MS, which means it started wrong.
let restYaw: number | null = null
let seenSince = 0
let prevT = 0
let offSince = 0
export const turnState = () => ({ rest: restYaw, state })
function learnRest(f: FaceFrame) {
  if (restYaw === null || f.t - prevT > 10000) {
    restYaw = f.yaw
    seenSince = f.t
  }
  const dt = Math.min(0.2, (f.t - prevT) / 1000)
  prevT = f.t
  const off = f.yaw - restYaw
  if (f.t - seenSince < 1500) restYaw += off * Math.min(1, dt / 0.4)
  else if (Math.abs(off) < TURN_DEG / 2) restYaw += off * (dt / 2.5)
  const turned = Math.abs(off) >= TURN_DEG && Math.abs(off) <= AWAY_DEG
  offSince = turned ? offSince || f.t : 0
  if (offSince && f.t - offSince > POSTURE_MS) {
    restYaw = f.yaw
    offSince = 0
  }
  return f.yaw - restYaw
}

// Turn = head turned past TURN_DEG and held briefly. One turn, one step: to move again, come back to the
// centre (which re-arms) and turn again. A big turn (past AWAY_DEG, where people naturally go when asked to
// turn, and where the camera can briefly lose the face) counts when the head comes back, as long as the
// whole turn was quick; a long one is looking away, not a gesture.
let turnSince = 0
let turnDone = false
let wentFar = false
let turnDir = 0
function detectTurn(f: FaceFrame, off: number) {
  const a = Math.abs(off)
  if (a < TURN_DEG) {
    if (turnSince && !turnDone && wentFar && f.t - turnSince < AWAY_MS) fire(turnDir > 0 ? 'right' : 'left', f)
    turnSince = 0
    turnDone = false
    wentFar = false
    return
  }
  turnSince ||= f.t
  turnDir = off > 0 ? 1 : -1 // confirmed by the user on a real webcam: yaw + = turned right
  if (a > AWAY_DEG) wentFar = true
  if (turnDone || wentFar || f.t - turnSince < HOLD_MS) return
  turnDone = true
  fire(turnDir > 0 ? 'right' : 'left', f)
}
