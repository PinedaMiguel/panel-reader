import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// The setup's guide: a toon-shaded 3D head (built from primitives, comic-style ink outlines) that acts out
// each gesture on a loop, so it can be copied without reading anything. Mirrored like a fitness video:
// "right" turns toward the screen's right, the way the user's own head should go.

export type GuideAction = 'idle' | 'right' | 'left' | 'eyes' | 'up' | 'smile' | 'happy'
export const CYCLE_S = 3.2 // one demonstration; the demo animations next to the head share this loop

const SKIN = 0xf2c29b
const HAIR = 0x2a1c15
const INK = 0x0b0b0c
const SHIRT = 0xffd300

type Pose = { yaw: number; pitch: number; roll: number; lidL: number; lidR: number; smile: number; brow: number }
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
// 0 → 1 → 0 over the cycle: rise at a, hold, fall at b (seconds).
const hold = (t: number, a: number, b: number, d = 0.35) => ease((t - a) / d) * (1 - ease((t - b) / d))

function pose(action: GuideAction, s: number): Pose {
  const t = s % CYCLE_S
  const p: Pose = { yaw: Math.sin(s * 0.7) * 0.05, pitch: Math.sin(s * 0.5) * 0.03, roll: 0, lidL: 0, lidR: 0, smile: 0.25, brow: 0 }
  const blink = t > 2.9 && t < 3.05 ? 1 : 0 // a natural blink keeps it alive
  p.lidL = p.lidR = blink
  switch (action) {
    case 'right':
    case 'left': {
      const k = hold(t, 0.3, 2.1) * (action === 'right' ? 1 : -1)
      p.yaw += 0.62 * k
      p.brow = Math.abs(k) * 0.3
      break
    }
    case 'eyes': {
      const k = hold(t, 0.4, 1.7, 0.15) // both eyes shut, held a moment
      p.lidL = p.lidR = Math.max(blink, k)
      p.pitch += 0.05 * k
      p.smile = 0.25 + 0.35 * k
      break
    }
    case 'up': {
      const k = hold(t, 0.3, 2.1) // tilt back to the sky, held (- pitch = face up)
      p.pitch -= 0.5 * k
      p.brow = 0.4 * k
      break
    }
    case 'smile':
      p.smile = 0.3 + 0.7 * hold(t, 0.2, 2.6, 0.5)
      p.pitch += Math.sin(s * 3) * 0.02 * p.smile
      p.brow = 0.3 * p.smile
      break
    case 'happy':
      p.smile = 1
      p.brow = 0.5
      p.pitch += Math.abs(Math.sin(s * 9)) * 0.08
      break
  }
  return p
}

function buildHead() {
  const g = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat)
  g.minFilter = g.magFilter = THREE.NearestFilter
  g.needsUpdate = true
  const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: g })
  const ink = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide })
  const sphere = (r: number, mat: THREE.Material, seg = 32) => new THREE.Mesh(new THREE.SphereGeometry(r, seg * 1.5, seg), mat)
  const outline = (m: THREE.Mesh, k = 1.035) => {
    const o = new THREE.Mesh(m.geometry, ink)
    o.scale.setScalar(k)
    m.add(o)
    return m
  }

  const root = new THREE.Group()
  const skin = toon(SKIN)

  const torso = outline(sphere(1, toon(SHIRT)), 1.02)
  torso.scale.set(1.55, 0.8, 0.85)
  torso.position.y = -0.75
  const neck = outline(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.7, 32), skin), 1.06)
  neck.position.y = 0.05
  root.add(torso, neck)

  // Pivot at the top of the neck, so nods and turns move like a real head.
  const head = new THREE.Group()
  head.position.y = 0.3
  root.add(head)
  const face = new THREE.Group()
  face.position.y = 0.78
  head.add(face)

  const skull = outline(sphere(1, skin, 48))
  skull.scale.set(0.88, 1.06, 0.94)
  // Hair: a cap tilted back, so the hairline sits just above the brows and it covers more at the back.
  const hair = outline(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32, 0, Math.PI * 2, 0, Math.PI * 0.42), toon(HAIR)), 1.025)
  hair.scale.set(0.95, 1.13, 1.02)
  hair.rotation.x = -0.2
  hair.position.y = 0.05
  face.add(skull, hair)

  for (const side of [-1, 1]) {
    const ear = outline(sphere(0.2, skin, 16), 1.08)
    ear.scale.set(0.45, 1, 0.75)
    ear.position.set(side * 0.86, 0.02, -0.05)
    face.add(ear)
  }

  const white = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const dark = new THREE.MeshBasicMaterial({ color: 0x1b120e })
  const lids: THREE.Group[] = []
  const brows: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const eye = outline(sphere(0.15, white, 20), 1.06)
    eye.position.set(side * 0.31, 0.08, 0.76)
    const pupil = sphere(0.075, dark, 16)
    pupil.scale.z = 0.4
    pupil.position.z = 0.12
    const glint = sphere(0.022, white, 8)
    glint.position.set(0.03, 0.035, 0.145)
    eye.add(pupil, glint)
    // Eyelid: a skin dome hinged at the top of the eye; scaling it down the eye closes it.
    const lid = new THREE.Group()
    lid.position.set(side * 0.31, 0.08 + 0.17, 0.76)
    const dome = outline(sphere(0.172, skin, 20), 1.05)
    dome.position.y = -0.17
    lid.add(dome)
    lid.scale.y = 0.001
    lids.push(lid)
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.2, 4, 8), toon(HAIR))
    brow.rotation.z = Math.PI / 2 + side * -0.12
    brow.position.set(side * 0.31, 0.36, 0.8)
    brows.push(brow)
    face.add(eye, lid, brow)
  }

  const nose = outline(sphere(0.09, skin, 16), 1.08)
  nose.scale.set(1, 1.15, 1)
  nose.position.set(0, -0.12, 0.92)
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 8, 32, Math.PI), new THREE.MeshBasicMaterial({ color: 0x5a1f1a }))
  mouth.rotation.set(-0.15, 0, Math.PI)
  mouth.position.set(0, -0.36, 0.86)
  const blush = new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0 })
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), blush)
    b.position.set(side * 0.5, -0.18, 0.75)
    b.rotation.y = side * 0.55
    face.add(b)
  }
  face.add(nose, mouth)

  return { root, head, lids, brows, mouth, blush }
}

export default function FaceGuide({ action, label }: { action: GuideAction; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef({ action, since: performance.now() })
  if (current.current.action !== action) current.current = { action, since: performance.now() }

  useEffect(() => {
    const el = host.current
    if (!el) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      return // no WebGL: the animated demo beside it still explains each gesture
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(2, 3, 4)
    scene.add(key)
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50)
    camera.position.set(0, 1.0, 6.4)
    camera.lookAt(0, 0.85, 0)
    const h = buildHead()
    scene.add(h.root)

    const fit = () => {
      const { width, height } = el.getBoundingClientRect()
      renderer.setSize(width, height, false)
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()

    const now: Pose = pose('idle', 0)
    let raf = 0
    const frame = () => {
      const { action: a, since } = current.current
      const target = pose(a, (performance.now() - since) / 1000)
      // Ease toward the target pose: smooth starts and stops without a keyframe system.
      for (const k of Object.keys(now) as (keyof Pose)[]) now[k] += (target[k] - now[k]) * (k.startsWith('lid') ? 0.5 : 0.18)
      h.head.rotation.set(now.pitch, now.yaw, now.roll)
      h.lids[0].scale.y = Math.max(0.001, now.lidR)
      h.lids[1].scale.y = Math.max(0.001, now.lidL)
      h.lids.forEach((l) => (l.visible = l.scale.y > 0.05)) // a flattened lid's ink outline would show as a line
      h.brows.forEach((b) => (b.position.y = 0.36 + now.brow * 0.06))
      h.mouth.scale.set(1 + now.smile * 0.15, 0.25 + now.smile * 0.85, 1)
      h.blush.opacity = Math.max(0, now.smile - 0.4) * 0.7
      renderer.render(scene, camera)
      raf = requestAnimationFrame(frame)
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={host} className="face-guide" role="img" aria-label={label} />
}
