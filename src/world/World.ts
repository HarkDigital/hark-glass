import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared world for Hark Glass: a dark glass studio.
 *
 *  - LIGHT FIELD: a camera-centred dome painted with slow, domain-warped pools
 *    of coloured light (four colours + a deep base). It is an opaque mesh, so
 *    three's transmission pass captures it: every glass object refracts it.
 *    It is mostly screen-anchored (composition stays put while cameras move),
 *    with a little drift from the camera's heading so turns still read.
 *  - STUDIO REFLECTIONS: a PMREM environment built once from "lightformers"
 *    (softbox, two tall strips, a green rim ring, tinted low panels) in a dark
 *    room. Glass lives on its reflections; chapters sweep them across surfaces
 *    with params.envTurn.
 *  - KEY + FILL: one directional key (specular glints) and a low hemisphere.
 *
 * Chapters set world.params every frame they care; the engine resets them to
 * defaults first; values are damped so cuts never pop.
 */

export interface WorldParams {
  /** four light-pool colours, strongest first */
  a: THREE.ColorRepresentation
  b: THREE.ColorRepresentation
  c: THREE.ColorRepresentation
  d: THREE.ColorRepresentation
  /** the studio's deep base tone */
  base: THREE.ColorRepresentation
  /** light-field brightness (0 = dark studio, 1 = default, 1.6 = vivid) */
  glow: number
  /** how fast the pools drift and warp (0 = still) */
  flow: number
  /** where the pools gather, in screen space (-1..1, y up) */
  focus: THREE.Vector2
  /** how widely the pools spread (1 = default) */
  spread: number
  /**
   * backlight strips: soft vertical bars of light behind the subject (0..1).
   * Glass bends them into bright curved lines — the signature glass read.
   */
  strips: number
  /** strip colour (white-ish; tint for mood) */
  stripColor: THREE.ColorRepresentation
  /** studio reflection strength on glass/metal (scene.environmentIntensity) */
  env: number
  /** studio rotation about Y in radians: sweeps reflections across glass */
  envTurn: number
  /** key light: direction it comes FROM, and strength */
  keyDir: THREE.Vector3
  key: number
  /** hemisphere fill strength */
  fill: number
}

export const WORLD_DEFAULTS = {
  a: '#00ff85',
  b: '#29d9d0',
  c: '#6f5cff',
  d: '#ff5c9a',
  base: '#05070c',
  glow: 1,
  flow: 1,
  spread: 1,
  strips: 1,
  stripColor: '#eafff5',
  env: 1,
  envTurn: 0,
  key: 1.6,
  fill: 0.35,
}

const FIELD_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FIELD_FRAG = /* glsl */ `
  uniform vec3 uA, uB, uC, uD, uBase, uStripColor;
  uniform float uGlow, uTime, uSpread, uAspect, uTanV, uStrips;
  uniform vec2 uFocus, uShift;
  uniform mat3 uViewRot;
  varying vec3 vDir;

  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
  float pool(vec2 q, vec2 c, float r) { vec2 d = q - c; return exp(-dot(d, d) / (r * r)); }
  float pow2(float x) { return x * x; }

  void main() {
    // view-space direction -> screen-like coordinates (-1..1 on the short axis)
    vec3 v = uViewRot * normalize(vDir);
    float z = max(-v.z, 0.05);
    vec2 p = v.xy / z / uTanV;           // ~(-aspect..aspect, -1..1) at the frame edges
    p += uShift;

    float t = uTime;
    vec2 q = p + 0.55 * (vec2(fbm(p * 0.9 + vec2(t * 0.6, -t * 0.4)), fbm(p * 0.9 + vec2(5.2 - t * 0.5, 1.3 + t * 0.3))) - 0.5);
    vec2 f = uFocus;
    float s = uSpread;

    // coloured pools: dim, so the studio stays dark and glass keeps contrast
    vec3 light = vec3(0.0);
    light += uA * pool(q, f + s * vec2(0.55 * sin(t * 0.7) - 0.1, 0.2 * cos(t * 0.5)), 0.62 * s) * 0.42;
    light += uB * pool(q, f + s * vec2(0.8 + 0.3 * cos(t * 0.45), -0.3 + 0.2 * sin(t * 0.6)), 0.55 * s) * 0.3;
    light += uC * pool(q, f + s * vec2(-0.9 + 0.25 * sin(t * 0.35), 0.35 + 0.25 * cos(t * 0.4)), 0.75 * s) * 0.34;
    light += uD * pool(q, f + s * vec2(0.25 + 0.4 * cos(t * 0.3), -1.0 + 0.15 * sin(t * 0.55)), 0.5 * s) * 0.22;
    // backlight strips: tall soft bars behind the focus, slowly drifting apart
    vec2 sp = p - f;
    float band = exp(-sp.y * sp.y / (1.1 * s * s));               // fade top and bottom
    float bars = 0.0;
    bars += exp(-pow2((sp.x + 0.34 * s + 0.05 * sin(t * 0.8)) / (0.035 * s)));
    bars += 0.8 * exp(-pow2((sp.x - 0.18 * s + 0.06 * cos(t * 0.6)) / (0.022 * s)));
    bars += 0.55 * exp(-pow2((sp.x - 0.52 * s - 0.04 * sin(t * 0.5)) / (0.05 * s)));
    light += uStripColor * bars * band * uStrips * 0.55;
    // a low horizon glow: the studio cove
    light += mix(uB, uStripColor, 0.3) * exp(-pow2((p.y + 0.55) / 0.22)) * 0.08;
    float edge = smoothstep(2.4, 0.4, length(p * vec2(0.8, 1.0)));
    vec3 col = uBase + light * uGlow * mix(0.5, 1.0, edge);
    col += (hash(gl_FragCoord.xy + fract(t) * 37.0) - 0.5) / 180.0; // dither: no banding in the gradients
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`

export class World {
  object = new THREE.Group()
  key: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  params: WorldParams = {
    ...WORLD_DEFAULTS,
    focus: new THREE.Vector2(0.15, 0.05),
    keyDir: new THREE.Vector3(-0.4, 0.9, 0.5),
  }
  private cur = {
    a: new THREE.Color(),
    b: new THREE.Color(),
    c: new THREE.Color(),
    d: new THREE.Color(),
    base: new THREE.Color(),
    glow: WORLD_DEFAULTS.glow,
    flow: WORLD_DEFAULTS.flow,
    spread: WORLD_DEFAULTS.spread,
    strips: WORLD_DEFAULTS.strips,
    stripColor: new THREE.Color(),
    env: WORLD_DEFAULTS.env,
    envTurn: WORLD_DEFAULTS.envTurn,
    key: WORLD_DEFAULTS.key,
    fill: WORLD_DEFAULTS.fill,
    focus: new THREE.Vector2(0.15, 0.05),
  }
  private first = true
  private clock = 0
  private uniforms = {
    uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() },
    uC: { value: new THREE.Color() },
    uD: { value: new THREE.Color() },
    uBase: { value: new THREE.Color() },
    uStripColor: { value: new THREE.Color() },
    uStrips: { value: 1 },
    uGlow: { value: 1 },
    uTime: { value: 0 },
    uSpread: { value: 1 },
    uAspect: { value: 1 },
    uTanV: { value: 0.4 },
    uFocus: { value: new THREE.Vector2() },
    uShift: { value: new THREE.Vector2() },
    uViewRot: { value: new THREE.Matrix3() },
  }
  private tmp = new THREE.Color()
  private tmpV = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()
  /** the studio environment (PMREM); set as scene.environment */
  envMap: THREE.Texture | null = null

  constructor(
    private scene: THREE.Scene,
    private mobile: boolean,
    renderer?: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
        uniforms: this.uniforms,
        vertexShader: FIELD_VERT,
        fragmentShader: FIELD_FRAG,
      }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)

    this.key = new THREE.DirectionalLight(0xffffff, WORLD_DEFAULTS.key)
    scene.add(this.key)
    scene.add(this.key.target)
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x151021, WORLD_DEFAULTS.fill)
    scene.add(this.hemi)

    if (renderer) this.buildStudio(renderer)
  }

  /**
   * The studio reflections: a dark room with lightformers, prefiltered once.
   * Glass has almost no colour of its own; these panels are what make it read.
   */
  private buildStudio(renderer: THREE.WebGLRenderer) {
    const room = new THREE.Scene()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(24, 16, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#07090f'), side: THREE.BackSide }),
    )
    room.add(box)
    const panel = (w: number, h: number, color: THREE.ColorRepresentation, power: number, pos: [number, number, number], look: [number, number, number] = [0, 0, 0]) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }),
      )
      m.position.set(...pos)
      m.lookAt(...look)
      room.add(m)
    }
    // big overhead softbox, two tall strips (the classic glass-product setup)
    panel(9, 5, '#ffffff', 2.2, [0, 7.8, 0])
    panel(1.1, 11, '#ffffff', 5, [-9, 1, 2])
    panel(0.8, 11, '#f2f8ff', 3.6, [9, 1, -1])
    // a thin top-front strip for a crisp edge highlight
    panel(10, 0.35, '#ffffff', 4, [0, 3.5, 9])
    // coloured low panels: the brand green and cool accents
    panel(4, 2.2, '#00ff85', 1.6, [-5, -4, -6])
    panel(4, 2.2, '#29d9d0', 1.2, [6, -3.5, 5])
    panel(5, 2.5, '#6f5cff', 1.2, [5, -2, -8])
    // rim ring behind the subject
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.2, 0.12, 8, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#bfffe0').multiplyScalar(3) }),
    )
    ring.position.set(0, 0.5, -10.5)
    room.add(ring)

    const pmrem = new THREE.PMREMGenerator(renderer)
    const rt = pmrem.fromScene(room, 0.035)
    pmrem.dispose()
    room.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    this.envMap = rt.texture
    this.scene.environment = rt.texture
  }

  resetParams() {
    const p = this.params
    p.a = WORLD_DEFAULTS.a
    p.b = WORLD_DEFAULTS.b
    p.c = WORLD_DEFAULTS.c
    p.d = WORLD_DEFAULTS.d
    p.base = WORLD_DEFAULTS.base
    p.glow = WORLD_DEFAULTS.glow
    p.flow = WORLD_DEFAULTS.flow
    p.spread = WORLD_DEFAULTS.spread
    p.strips = WORLD_DEFAULTS.strips
    p.stripColor = WORLD_DEFAULTS.stripColor
    p.env = WORLD_DEFAULTS.env
    p.envTurn = WORLD_DEFAULTS.envTurn
    p.key = WORLD_DEFAULTS.key
    p.fill = WORLD_DEFAULTS.fill
    p.focus.set(0.15, 0.05)
    p.keyDir.set(-0.4, 0.9, 0.5)
  }

  update(frame: Frame, camera: THREE.Camera) {
    const p = this.params
    const c = this.cur
    const k = this.first ? 1 : 1 - Math.exp(-4 * frame.dt)
    const lerpColor = (dst: THREE.Color, src: THREE.ColorRepresentation) => dst.lerp(this.tmp.set(src), k)
    lerpColor(c.a, p.a)
    lerpColor(c.b, p.b)
    lerpColor(c.c, p.c)
    lerpColor(c.d, p.d)
    lerpColor(c.base, p.base)
    c.glow += (p.glow - c.glow) * k
    c.flow += (p.flow - c.flow) * k
    c.spread += (p.spread - c.spread) * k
    c.strips += (p.strips - c.strips) * k
    lerpColor(c.stripColor, p.stripColor)
    c.env += (p.env - c.env) * k
    c.key += (p.key - c.key) * k
    c.fill += (p.fill - c.fill) * k
    c.focus.lerp(p.focus, k)
    // shortest-path damp for the studio turn
    let dTurn = p.envTurn - c.envTurn
    dTurn = Math.atan2(Math.sin(dTurn), Math.cos(dTurn))
    c.envTurn += dTurn * k
    this.first = false

    const calm = frame.reducedMotion ? 0.15 : 1
    this.clock += frame.dt * 0.12 * c.flow * calm

    const u = this.uniforms
    u.uA.value.copy(c.a)
    u.uB.value.copy(c.b)
    u.uC.value.copy(c.c)
    u.uD.value.copy(c.d)
    u.uBase.value.copy(c.base)
    u.uGlow.value = c.glow
    u.uSpread.value = c.spread
    u.uStrips.value = c.strips
    u.uStripColor.value.copy(c.stripColor)
    u.uTime.value = this.clock
    u.uFocus.value.copy(c.focus)
    u.uAspect.value = frame.width / Math.max(1, frame.height)
    const persp = camera as THREE.PerspectiveCamera
    u.uTanV.value = Math.tan(THREE.MathUtils.degToRad((persp.fov ?? 45) / 2))
    // view rotation (world dir -> view dir) and a little drift from the heading
    camera.updateMatrixWorld()
    this.tmpM.extractRotation(camera.matrixWorldInverse)
    u.uViewRot.value.setFromMatrix4(this.tmpM)
    camera.getWorldDirection(this.tmpV)
    const yaw = Math.atan2(this.tmpV.x, -this.tmpV.z)
    const pitch = Math.asin(THREE.MathUtils.clamp(this.tmpV.y, -1, 1))
    u.uShift.value.set(Math.sin(yaw) * 0.35, pitch * 0.3)

    this.scene.environmentIntensity = c.env
    this.scene.environmentRotation.y = c.envTurn

    this.key.intensity = c.key
    this.key.position.copy(camera.position).addScaledVector(this.tmpV.copy(p.keyDir).normalize(), 50)
    this.key.target.position.copy(camera.position)
    this.key.target.updateMatrixWorld()
    this.hemi.intensity = c.fill
    this.object.position.copy(camera.position)
    void this.mobile
  }
}
