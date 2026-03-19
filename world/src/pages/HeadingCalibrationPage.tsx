import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const SCENE_BG = 0x070b14
const GROUND_COLOR = 0x234626
const GRID_COLOR = 0x365f3f
const FLY_SCALE = 0.08

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

function normalizeAngleRad(rad: number): number {
  let a = rad
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function stepTowardAngle(current: number, target: number, maxStepRad: number): number {
  const delta = normalizeAngleRad(target - current)
  if (delta > maxStepRad) return normalizeAngleRad(current + maxStepRad)
  if (delta < -maxStepRad) return normalizeAngleRad(current - maxStepRad)
  return normalizeAngleRad(target)
}

type TurnMode = 'snap' | 'rate_limit'
type HeadingMode = 'analytic_tangent' | 'sampled_delta'

export default function HeadingCalibrationPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [modelStatus, setModelStatus] = useState('loading model...')
  const [yawOffsetDeg, setYawOffsetDeg] = useState(270)
  const [pathSpeed, setPathSpeed] = useState(0.9)
  const [radius, setRadius] = useState(8)
  const [headingDeg, setHeadingDeg] = useState(0)
  const [velocityDeg, setVelocityDeg] = useState(0)
  const [flyTurnMode, setFlyTurnMode] = useState<TurnMode>('snap')
  const [arrowTurnMode, setArrowTurnMode] = useState<TurnMode>('snap')
  const [lockFlyToArrow, setLockFlyToArrow] = useState(true)
  const [flyTurnRateDegPerSec, setFlyTurnRateDegPerSec] = useState(720)
  const [arrowTurnRateDegPerSec, setArrowTurnRateDegPerSec] = useState(720)
  const [headingMode, setHeadingMode] = useState<HeadingMode>('analytic_tangent')

  const yawOffsetRad = useMemo(() => degToRad(yawOffsetDeg), [yawOffsetDeg])
  const controlsRef = useRef({
    yawOffsetRad,
    pathSpeed,
    radius,
    headingMode,
    arrowTurnMode,
    arrowTurnRateDegPerSec,
    flyTurnMode,
    flyTurnRateDegPerSec,
    lockFlyToArrow,
  })

  useEffect(() => {
    controlsRef.current = {
      yawOffsetRad,
      pathSpeed,
      radius,
      headingMode,
      arrowTurnMode,
      arrowTurnRateDegPerSec,
      flyTurnMode,
      flyTurnRateDegPerSec,
      lockFlyToArrow,
    }
  }, [
    yawOffsetRad,
    pathSpeed,
    radius,
    headingMode,
    arrowTurnMode,
    arrowTurnRateDegPerSec,
    flyTurnMode,
    flyTurnRateDegPerSec,
    lockFlyToArrow,
  ])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(SCENE_BG)

    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 2000)
    camera.position.set(16, 12, 16)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0, 0)

    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(8, 14, 6)
    scene.add(dir)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: GROUND_COLOR, side: THREE.DoubleSide }),
    )
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)
    const grid = new THREE.GridHelper(120, 60, 0x5e9f5f, GRID_COLOR)
    scene.add(grid)

    const path = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1.02, 128),
      new THREE.MeshBasicMaterial({ color: 0x8db7ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    )
    path.rotation.x = -Math.PI / 2
    scene.add(path)

    const flyRoot = new THREE.Group()
    scene.add(flyRoot)

    // Keep arrow in world space (not child of fly) to avoid local-rotation compounding.
    const velocityArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0.12, 0),
      1.8,
      0xff5f9f,
      0.36,
      0.22,
    )
    scene.add(velocityArrow)

    const loader = new GLTFLoader()
    const mixers: THREE.AnimationMixer[] = []
    let disposed = false
    const loadFly = (url: string, label: string, onFail?: () => void) => {
      loader.load(
        url,
        (gltf) => {
          if (disposed) return
          const flyModel = gltf.scene.clone(true)
          flyModel.scale.setScalar(FLY_SCALE)
          flyRoot.add(flyModel)
          if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(flyModel)
            for (const clip of gltf.animations) {
              if (clip.name.toLowerCase().includes('wing')) {
                mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play()
              }
            }
            mixers.push(mixer)
          }
          setModelStatus(`loaded: ${label}`)
        },
        undefined,
        () => {
          if (disposed) return
          if (onFail) onFail()
          else setModelStatus(`failed to load: ${label}`)
        },
      )
    }
    // Match main sim path first, then fallback to .gltf asset in repo.
    loadFly('/models/fly-animated/fly2-animation.glb', 'fly2-animation.glb', () => {
      loadFly('/models/fly-animated/fly2-animation.gltf', 'fly2-animation.gltf')
    })

    let prevX = controlsRef.current.radius
    let prevY = 0
    let flyDisplayHeading = 0
    let arrowDisplayHeading = 0
    let prevTimeMs = performance.now()
    const startMs = prevTimeMs
    let rafId = 0
    const tick = () => {
      const now = performance.now()
      const dtSec = Math.max(1 / 240, (now - prevTimeMs) / 1000)
      prevTimeMs = now

      const c = controlsRef.current
      const safeRadius = Math.max(0.1, c.radius)
      path.scale.setScalar(safeRadius)
      const t = ((now - startMs) / 1000) * c.pathSpeed
      const x = Math.cos(t) * safeRadius
      const y = Math.sin(t) * safeRadius
      const dx = x - prevX
      const dy = y - prevY
      prevX = x
      prevY = y

      const tangentHeading = normalizeAngleRad(t + Math.PI / 2)
      const sampledHeading = normalizeAngleRad(Math.atan2(dy, dx))
      const targetHeading = c.headingMode === 'analytic_tangent' ? tangentHeading : sampledHeading

      if (c.arrowTurnMode === 'snap') {
        arrowDisplayHeading = targetHeading
      } else {
        const maxStep = degToRad(c.arrowTurnRateDegPerSec) * dtSec
        arrowDisplayHeading = stepTowardAngle(arrowDisplayHeading, targetHeading, maxStep)
      }

      if (c.lockFlyToArrow) {
        flyDisplayHeading = arrowDisplayHeading
      } else if (c.flyTurnMode === 'snap') {
        flyDisplayHeading = targetHeading
      } else {
        const maxStep = degToRad(c.flyTurnRateDegPerSec) * dtSec
        flyDisplayHeading = stepTowardAngle(flyDisplayHeading, targetHeading, maxStep)
      }

      setHeadingDeg(radToDeg(flyDisplayHeading))
      setVelocityDeg(radToDeg(targetHeading))

      flyRoot.position.set(x, 0.12, y)
      flyRoot.rotation.y = -flyDisplayHeading + c.yawOffsetRad

      velocityArrow.position.set(x, 0.12, y)
      velocityArrow.setDirection(new THREE.Vector3(Math.cos(arrowDisplayHeading), 0, Math.sin(arrowDisplayHeading)))

      for (const mixer of mixers) mixer.update(dtSec)
      controls.update()
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, el.clientWidth)
      const h = Math.max(1, el.clientHeight)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(el)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      ro.disconnect()
      controls.dispose()
      for (const mixer of mixers) mixer.stopAllAction()
      renderer.dispose()
      velocityArrow.line.geometry.dispose()
      ;(velocityArrow.line.material as THREE.Material).dispose()
      velocityArrow.cone.geometry.dispose()
      ;(velocityArrow.cone.material as THREE.Material).dispose()
      scene.remove(velocityArrow)
      scene.remove(grid)
      grid.geometry.dispose()
      if (Array.isArray(grid.material)) grid.material.forEach((m) => m.dispose())
      else grid.material.dispose()
      path.geometry.dispose()
      ;(path.material as THREE.Material).dispose()
      scene.remove(path)
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      scene.remove(ground)
      flyRoot.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose())
          else obj.material.dispose()
        }
      })
      scene.remove(flyRoot)
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', background: '#05080f' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          width: 390,
          border: '1px solid #46658d',
          borderRadius: 8,
          background: 'rgba(3, 7, 14, 0.86)',
          color: '#d9e9ff',
          padding: 12,
          fontSize: 13,
          lineHeight: 1.35,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Fly Heading Calibration</div>
        <div style={{ marginBottom: 8 }}>
          Pink arrow should stay tangent to the circle. Use turn-mode/rate controls to test response lag.
        </div>

        <label style={{ display: 'block', marginBottom: 8 }}>
          Yaw offset: <b>{yawOffsetDeg.toFixed(0)}°</b>
          <input
            type="range"
            min={-360}
            max={360}
            step={1}
            value={yawOffsetDeg}
            onChange={(e) => setYawOffsetDeg(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 8 }}>
          Path speed: <b>{pathSpeed.toFixed(2)}</b>
          <input
            type="range"
            min={0.2}
            max={2.5}
            step={0.05}
            value={pathSpeed}
            onChange={(e) => setPathSpeed(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 8 }}>
          Path radius: <b>{radius.toFixed(1)}</b>
          <input
            type="range"
            min={3}
            max={20}
            step={0.5}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <div style={{ marginBottom: 6 }}>
          Heading source:
          <button style={{ marginLeft: 8 }} onClick={() => setHeadingMode('analytic_tangent')}>analytic tangent</button>
          <button style={{ marginLeft: 6 }} onClick={() => setHeadingMode('sampled_delta')}>sampled delta</button>
        </div>

        <div style={{ marginBottom: 6 }}>
          Arrow turn:
          <button style={{ marginLeft: 8 }} onClick={() => setArrowTurnMode('snap')}>SNAP</button>
          <button style={{ marginLeft: 6 }} onClick={() => setArrowTurnMode('rate_limit')}>rate limit</button>
        </div>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Arrow turn rate: <b>{arrowTurnRateDegPerSec.toFixed(0)}°/s</b>
          <input
            type="range"
            min={45}
            max={2160}
            step={15}
            value={arrowTurnRateDegPerSec}
            onChange={(e) => setArrowTurnRateDegPerSec(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <div style={{ marginBottom: 6 }}>
          <label>
            <input
              type="checkbox"
              checked={lockFlyToArrow}
              onChange={(e) => setLockFlyToArrow(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            lock fly heading to arrow heading
          </label>
        </div>
        <div style={{ marginBottom: 6 }}>
          Fly turn:
          <button style={{ marginLeft: 8 }} onClick={() => setFlyTurnMode('snap')}>SNAP</button>
          <button style={{ marginLeft: 6 }} onClick={() => setFlyTurnMode('rate_limit')}>rate limit</button>
        </div>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Fly turn rate: <b>{flyTurnRateDegPerSec.toFixed(0)}°/s</b>
          <input
            type="range"
            min={45}
            max={2160}
            step={15}
            value={flyTurnRateDegPerSec}
            onChange={(e) => setFlyTurnRateDegPerSec(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <div>Fly heading: {headingDeg.toFixed(1)}°</div>
        <div>Target velocity heading: {velocityDeg.toFixed(1)}°</div>
        <div>Model: {modelStatus}</div>
      </div>
    </div>
  )
}

