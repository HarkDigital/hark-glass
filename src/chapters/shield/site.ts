import * as THREE from 'three'
import type { CrackLine, V2 } from './crack'

/*
 * "Your site": a minimal website etched into the glass pane, and the light
 * lines of the fracture.
 *
 * Both render in three's OPAQUE list with additive blending (no depth
 * writes for the etch): the transmission pass captures opaque objects, so
 * the etched site and the crack light are refracted by the pane they sit in
 * and by the shield that later slides in front — glass does not see other
 * glass, but it does see these.
 *
 * The etch texture packs two masks: R = neutral lines, G = accent (buttons,
 * the chart line, icons). The shader tints each by uniform, so the site can
 * turn ember in the breach and signal green when it's healthy again.
 */

/** Rounded-rect path (Safari 15 has no CanvasRenderingContext2D.roundRect). */
function rrPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.min(r, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + q, y)
  g.lineTo(x + w - q, y)
  g.arcTo(x + w, y, x + w, y + q, q)
  g.lineTo(x + w, y + h - q)
  g.arcTo(x + w, y + h, x + w - q, y + h, q)
  g.lineTo(x + q, y + h)
  g.arcTo(x, y + h, x, y + h - q, q)
  g.lineTo(x, y + q)
  g.arcTo(x, y, x + q, y, q)
  g.closePath()
}

/**
 * Draw the site. Designed on a 1600 x 1050 board (the pane's 3.2 x 2.1
 * units at 500 px per unit) and scaled to the canvas.
 */
function drawSite(cv: HTMLCanvasElement) {
  const g = cv.getContext('2d')!
  const s = cv.width / 1600
  // opaque black first: the rgb must keep its anti-aliasing when uploaded
  g.globalCompositeOperation = 'source-over'
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#000'
  g.fillRect(0, 0, cv.width, cv.height)
  g.setTransform(s, 0, 0, s, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const N = (v: number) => `rgb(${v},0,0)`
  const A = (v: number) => `rgb(0,${v},0)`
  const fillR = (x: number, y: number, w: number, h: number, r: number, c: string) => {
    rrPath(g, x, y, w, h, r)
    g.fillStyle = c
    g.fill()
  }
  const strokeR = (x: number, y: number, w: number, h: number, r: number, c: string, lw: number) => {
    rrPath(g, x, y, w, h, r)
    g.strokeStyle = c
    g.lineWidth = lw
    g.stroke()
  }
  const bar = (x: number, y: number, w: number, h: number, v: number) => fillR(x, y - h / 2, w, h, h / 2, N(v))

  // browser frame (an inner rim so the site still reads through other glass)
  strokeR(18, 18, 1564, 1014, 58, N(70), 3)
  // title bar: three lights, the address pill
  for (const [i, x] of [60, 90, 120].entries()) {
    g.beginPath()
    g.arc(x + 12, 58, 9, 0, Math.PI * 2)
    g.fillStyle = N(i === 0 ? 170 : 120)
    g.fill()
  }
  strokeR(560, 38, 480, 40, 20, N(105), 3)
  g.fillStyle = N(165)
  g.font = `500 22px 'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('yoursite.com', 800, 59)
  g.beginPath()
  g.moveTo(40, 100)
  g.lineTo(1560, 100)
  g.strokeStyle = N(62)
  g.lineWidth = 2
  g.stroke()

  // site nav: a mark + wordmark, links, a CTA pill
  g.save()
  g.translate(106, 160)
  g.rotate(Math.PI / 4)
  g.fillStyle = A(255)
  g.fillRect(-10, -10, 20, 20)
  g.restore()
  bar(132, 160, 120, 14, 205)
  for (const x of [896, 986, 1076, 1166]) bar(x, 160, 62, 10, 135)
  strokeR(1296, 140, 206, 40, 20, A(215), 3)
  bar(1344, 160, 110, 9, 150)

  // hero, left: headline, sub-lines, buttons
  fillR(96, 238, 610, 58, 16, N(215))
  fillR(96, 316, 470, 58, 16, N(215))
  bar(96, 432, 560, 13, 118)
  bar(96, 460, 510, 13, 118)
  bar(96, 488, 380, 13, 118)
  fillR(96, 540, 230, 58, 29, A(225))
  bar(146, 569, 130, 11, 70)
  strokeR(346, 540, 190, 58, 29, N(140), 3)
  bar(386, 569, 110, 11, 130)

  // hero, right: a dashboard card with a line chart
  strokeR(860, 232, 644, 388, 26, N(112), 3)
  bar(904, 276, 150, 12, 150)
  bar(904, 300, 96, 9, 90)
  for (const y of [360, 430, 500, 570]) {
    g.beginPath()
    g.moveTo(904, y)
    g.lineTo(1462, y)
    g.strokeStyle = N(38)
    g.lineWidth = 2
    g.stroke()
  }
  const pts: [number, number][] = [
    [904, 548],
    [984, 520],
    [1064, 530],
    [1144, 470],
    [1224, 488],
    [1304, 412],
    [1384, 400],
    [1462, 338],
  ]
  // soft area under the line (accent, low)
  g.beginPath()
  g.moveTo(pts[0][0], 590)
  for (const [x, y] of pts) g.lineTo(x, y)
  g.lineTo(pts[pts.length - 1][0], 590)
  g.closePath()
  const grad = g.createLinearGradient(0, 330, 0, 590)
  grad.addColorStop(0, A(70))
  grad.addColorStop(1, A(0))
  g.fillStyle = grad
  g.fill()
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.strokeStyle = A(255)
  g.lineWidth = 6
  g.stroke()
  for (const [x, y] of pts.slice(1)) {
    g.beginPath()
    g.arc(x, y, 8, 0, Math.PI * 2)
    g.fillStyle = A(255)
    g.fill()
  }

  // three feature cards
  for (const x of [96, 578, 1060]) {
    strokeR(x, 694, 444, 272, 24, N(92), 3)
    strokeR(x + 34, 728, 46, 46, 12, A(205), 3)
    bar(x + 34, 822, 230, 17, 195)
    bar(x + 34, 866, 340, 10, 96)
    bar(x + 34, 890, 300, 10, 96)
    bar(x + 34, 914, 318, 10, 96)
  }
}

export function siteTexture(mobile: boolean): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = mobile ? 1152 : 1600
  cv.height = Math.round((cv.width * 1050) / 1600)
  drawSite(cv)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 8
  // the address text is Geist Mono: redraw once the web fonts are in
  document.fonts?.ready.then(() => {
    drawSite(cv)
    tex.needsUpdate = true
  })
  return tex
}

/** The etched site: R and G masks tinted by uniform, added to what's behind. */
export function etchMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uNeutral: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uNeutral, uAccent;
      varying vec2 vUv;
      void main() {
        vec3 t = texture2D(uMap, vUv).rgb;
        gl_FragColor = vec4(t.r * uNeutral + t.g * uAccent, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

/**
 * The pane's face catching the studio: a long diagonal reflection streak (a
 * crisp line inside a soft halo) and a faint brighter top edge, laid out in
 * pane UV space so seated shards form one continuous reflection. uOff slides
 * the streak across with the studio turn (the light sweep).
 */
export function sheenMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOff: { value: 0.5 },
      uStrength: { value: 0.1 },
      uColor: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOff, uStrength;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float d = vUv.x * 0.86 + vUv.y * 0.62 - uOff;
        float e = d + 0.075;
        float band = exp(-d * d / 0.0011) * 0.8 + exp(-d * d / 0.018) * 0.3 + exp(-e * e / 0.0003) * 0.45;
        float top = smoothstep(0.8, 1.0, vUv.y) * 0.22;
        gl_FragColor = vec4(uColor * (band + top) * uStrength, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

/**
 * Crack light. Visible where growth time < uGrow; a hot head rides the
 * growth front (it runs out in the breach and back in when the glass heals).
 * No depth writes: the pane in front of it paints over the direct copy and
 * shows the one it refracts (with depth writes you'd see both, doubled).
 */
export function crackMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uGrow: { value: 0 },
      uIntensity: { value: 1 },
      uHead: { value: 1 },
      uColor: { value: new THREE.Color() },
      uHot: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      attribute float aG;
      attribute float aS;
      attribute float aK;
      varying float vG;
      varying float vS;
      varying float vK;
      void main() {
        vG = aG; vS = aS; vK = aK;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uGrow, uIntensity, uHead;
      uniform vec3 uColor, uHot;
      varying float vG;
      varying float vS;
      varying float vK;
      void main() {
        float d = uGrow - vG;
        if (d < 0.0) discard;
        float head = (1.0 - smoothstep(0.0, 0.07, d)) * uHead;
        float prof = 1.0 - vS * vS;
        prof = prof * (0.35 + 0.65 * prof);
        vec3 c = (uColor + uHot * head * 2.2) * uIntensity * vK * prof;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

/** Ribbons along crack lines (thin quads with mitred joints), relative to `origin`. */
export function crackGeometry(lines: CrackLine[], z: number, origin: V2, widthScale = 1): THREE.BufferGeometry {
  const pos: number[] = []
  const gA: number[] = []
  const sA: number[] = []
  const kA: number[] = []
  const idx: number[] = []
  for (const ln of lines) {
    const P = ln.pts
    const n = P.length
    if (n < 2) continue
    const cum = [0]
    for (let j = 1; j < n; j++) cum.push(cum[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]))
    const total = cum[n - 1] || 1
    const base = pos.length / 3
    for (let j = 0; j < n; j++) {
      const a = P[Math.max(0, j - 1)]
      const b = P[Math.min(n - 1, j + 1)]
      let tx = b[0] - a[0]
      let ty = b[1] - a[1]
      const tl = Math.hypot(tx, ty) || 1
      tx /= tl
      ty /= tl
      // mitre: widen at joints so the ribbon keeps its width round a kink
      let scale = 1
      if (j > 0 && j < n - 1) {
        const sx = P[j + 1][0] - P[j][0]
        const sy = P[j + 1][1] - P[j][1]
        const sl = Math.hypot(sx, sy) || 1
        scale = 1 / Math.max(0.6, Math.abs(tx * (sx / sl) + ty * (sy / sl)))
      }
      const hw = ((ln.w0 + (ln.w1 - ln.w0) * (cum[j] / total)) / 2) * scale * widthScale
      const nx = -ty * hw
      const ny = tx * hw
      pos.push(P[j][0] + nx - origin[0], P[j][1] + ny - origin[1], z)
      pos.push(P[j][0] - nx - origin[0], P[j][1] - ny - origin[1], z)
      gA.push(ln.g[j], ln.g[j])
      sA.push(-1, 1)
      kA.push(ln.k, ln.k)
    }
    for (let j = 0; j < n - 1; j++) {
      const q = base + j * 2
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aG', new THREE.Float32BufferAttribute(gA, 1))
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(sA, 1))
  geo.setAttribute('aK', new THREE.Float32BufferAttribute(kA, 1))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return geo
}

export function shapeOf(poly: V2[]): THREE.Shape {
  return new THREE.Shape(poly.map(p => new THREE.Vector2(p[0], p[1])))
}

/** A flat cap of the polygon, UV-mapped onto the whole pane (w x h), relative to `origin`. */
export function etchGeometry(poly: V2[], w: number, h: number, z: number, origin: V2): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(shapeOf(poly), 1)
  const p = geo.attributes.position
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) + w / 2) / w
    uv[i * 2 + 1] = (p.getY(i) + h / 2) / h
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.translate(-origin[0], -origin[1], z)
  geo.computeBoundingSphere()
  return geo
}
