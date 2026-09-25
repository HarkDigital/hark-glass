import * as THREE from 'three'
import { G, glass, pane, caustic } from '../../kit/glass'
import { SERVICES } from '../../content'
import { buildAtlas } from './icons'

/*
 * The Facets crystal: eleven thick glass tiles standing in a ring around a
 * vertical axis, like the facets of a cut gem, on a dark turntable with an
 * emerald rim. Inside every tile, a thin glowing line glyph (the service
 * icon) — drawn OPAQUE-with-additive-blending so three's transmission pass
 * captures it and the glass refracts it (transparent objects are invisible
 * through glass). Behind the crystal, a faint ruled backdrop (fine vertical
 * light lines) the facets bend, which turns into a spectrum at the outro.
 *
 *   crystal.stand    float + turntable pivot (the chapter drives rotation)
 *   crystal.ring     rotation.y = turntable angle
 *   crystal.tiles[i] { holder, glass, plate, mat, plateMat, angle }
 */

export const N = SERVICES.length
export const STEP = (Math.PI * 2) / N
export const TILE_W = 0.8
export const TILE_H = 2.1
export const TILE_D = 0.2
const GAP = 0.06
/** distance from the axis to each tile's centre plane */
export const APOTHEM = (TILE_W + GAP) / (2 * Math.tan(Math.PI / N))
/** outer radius incl. tile depth (for framing) */
export const OUTER_R = Math.hypot(APOTHEM + TILE_D / 2, TILE_W / 2)
export const PLINTH_Y = -TILE_H / 2 - 0.16
export const PLINTH_R = OUTER_R + 0.12

/** Each facet's light colour (glyph tint, caustic pool, the strongest light pool). */
export const FACET_COLORS: string[] = [
  G.aqua, // 01 software
  '#9d92ff', // 02 web design
  G.mint, // 03 ecommerce
  G.signal, // 04 seo / geo
  G.amber, // 05 page speed
  '#b3abff', // 06 ai
  '#6fe3ff', // 07 aerial
  '#ff6fa6', // 08 hack remediation
  G.signal, // 09 security
  G.aqua, // 10 ada
  '#9d92ff', // 11 wordpress
]

export interface Tile {
  holder: THREE.Group
  glass: THREE.Mesh
  plate: THREE.Mesh
  mat: THREE.MeshPhysicalMaterial
  plateMat: THREE.MeshBasicMaterial
  /**
   * phones only: a crisp copy of the glyph etched on the tile's front face.
   * Phones take the transmission pass at half resolution, which softens the
   * refracted glyph; the facet in focus gets this sharp surface line on top.
   */
  faceMat: THREE.MeshBasicMaterial | null
  angle: number
  index: number
}

export interface Crystal {
  stand: THREE.Group
  ring: THREE.Group
  tiles: Tile[]
  plinth: THREE.Mesh
  rim: THREE.Mesh
  rimMat: THREE.MeshBasicMaterial
  pool: THREE.Mesh
  poolMat: THREE.ShaderMaterial
  backdrop: THREE.Mesh
  backdropMat: THREE.ShaderMaterial
  atlasTex: THREE.CanvasTexture
}

const BACKDROP_FRAG = /* glsl */ `
  uniform float uLines, uSpectrum, uTime;
  uniform vec3 uLineColor;
  varying vec2 vUv;
  vec3 hue(float h) {
    return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  }
  void main() {
    vec2 p = (vUv - 0.5) * vec2(18.0, 11.0);           // plane units
    // soft oval falloff: the lines live behind the crystal only
    vec2 q = p * vec2(0.21, 0.26);
    float fade = exp(-dot(q, q) * 2.0);
    // fine vertical light lines (a ruled studio backdrop the facets bend)
    float x = p.x * 2.6;
    float d = abs(fract(x) - 0.5);
    float line = exp(-(d * d) / 0.0016);
    float band = exp(-(p.y * p.y) / 7.0);
    vec3 col = uLineColor * line * band * fade * uLines;
    // the outro: seven spectral bars fan out behind the glass
    float spread = 0.6 + 0.4 * uSpectrum;
    vec3 spec = vec3(0.0);
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float cx = (fi - 3.0) * 0.5 * spread + 0.06 * sin(uTime * 0.6 + fi);
      float w = 0.075;
      float b = exp(-((p.x - cx) * (p.x - cx)) / (w * w));
      spec += hue(fi / 7.0 + 0.02) * b;
    }
    // shorter than the ruled lines: a flare behind the glass that fades before the chrome
    col += spec * exp(-(p.y * p.y) / 3.0) * exp(-dot(q, q) * 1.2) * uSpectrum * 0.6;
    gl_FragColor = vec4(col, 1.0);
  }
`

export function buildCrystal(mobile: boolean): Crystal {
  const stand = new THREE.Group()
  const ring = new THREE.Group()
  stand.add(ring)

  // ---- the tiles: one shared bevelled slab, a material per tile (frost + env animate)
  // clearcoat adds a second, sharper highlight layer on the bevels (desktop only: phones keep the lighter shader)
  const base = glass({ thickness: 0.55, ior: 1.52, dispersion: 0.5, env: 1.3, coat: mobile ? 0 : 0.35, tint: '#eafff6', tintDistance: 4 })
  const proto = pane(TILE_W, TILE_H, { radius: 0.075, depth: TILE_D, bevel: 0.05, material: base })
  const tileGeo = proto.geometry

  // ---- the glyph atlas (tall cells, one per facet)
  const cellW = mobile ? 192 : 256
  const PLATE_W = TILE_W - 0.16
  const PLATE_H = TILE_H - 0.16
  const cellH = Math.round((cellW * PLATE_H) / PLATE_W)
  const atlas = buildAtlas(cellW, cellH, mobile ? 1.3 : 1, !mobile)
  const atlasTex = new THREE.CanvasTexture(atlas.canvas)
  atlasTex.colorSpace = THREE.SRGBColorSpace
  atlasTex.anisotropy = 8
  atlasTex.generateMipmaps = true
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter
  document.fonts?.ready.then(() => {
    atlas.draw()
    atlasTex.needsUpdate = true
  })

  const tiles: Tile[] = []
  for (let i = 0; i < N; i++) {
    const angle = i * STEP
    const pivot = new THREE.Group()
    pivot.rotation.y = angle
    ring.add(pivot)
    const holder = new THREE.Group()
    holder.position.set(0, 0, APOTHEM)
    pivot.add(holder)

    const mat = base.clone()
    const tile = new THREE.Mesh(tileGeo, mat)
    tile.userData.facet = i
    holder.add(tile)

    const pg = new THREE.PlaneGeometry(PLATE_W, PLATE_H)
    const uv = pg.getAttribute('uv') as THREE.BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / N)
    uv.needsUpdate = true
    const plateMat = new THREE.MeshBasicMaterial({
      map: atlasTex,
      color: new THREE.Color(1, 1, 1),
      // opaque list + additive: the transmission pass captures it, so the glass bends it
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    const plate = new THREE.Mesh(pg, plateMat)
    plate.position.z = -0.012
    plate.renderOrder = 2
    holder.add(plate)
    let faceMat: THREE.MeshBasicMaterial | null = null
    if (mobile) {
      faceMat = new THREE.MeshBasicMaterial({
        map: atlasTex,
        color: new THREE.Color(0, 0, 0),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
      const face = new THREE.Mesh(pg, faceMat)
      face.position.z = TILE_D / 2 + 0.05 + 0.004
      face.renderOrder = 3
      holder.add(face)
    }
    tiles.push({ holder, glass: tile, plate, mat, plateMat, faceMat, angle, index: i })
  }

  // ---- the turntable: a thin dark polished disc with an emerald rim line
  const plinthR = PLINTH_R
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(plinthR, plinthR + 0.04, 0.07, mobile ? 72 : 128, 1),
    new THREE.MeshPhysicalMaterial({
      color: '#07090e',
      roughness: 0.42,
      metalness: 0,
      specularIntensity: 0.45,
      clearcoat: 0.35,
      clearcoatRoughness: 0.22,
      envMapIntensity: 0.4,
    }),
  )
  plinth.position.y = PLINTH_Y - 0.035
  stand.add(plinth)
  const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(G.signal).multiplyScalar(1.2), toneMapped: false })
  const rim = new THREE.Mesh(new THREE.TorusGeometry(plinthR - 0.01, 0.0045, 6, mobile ? 120 : 220), rimMat)
  rim.rotation.x = Math.PI / 2
  rim.position.y = PLINTH_Y + 0.001
  stand.add(rim)

  // ---- the caustic pool on the turntable (opaque list so it shows through the glass)
  const pool = caustic({ size: plinthR * 2.1, color: G.aqua, strength: 0.6 })
  const poolMat = pool.material as THREE.ShaderMaterial
  poolMat.transparent = false
  pool.position.y = PLINTH_Y + 0.004
  pool.renderOrder = 2
  stand.add(pool)

  // ---- the ruled backdrop + outro spectrum (static, behind the crystal)
  const backdropMat = new THREE.ShaderMaterial({
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uLines: { value: 0.1 },
      uSpectrum: { value: 0 },
      uTime: { value: 0 },
      uLineColor: { value: new THREE.Color('#dff7ff') },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: BACKDROP_FRAG,
  })
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(18, 11), backdropMat)
  backdrop.position.set(0, 0.1, -3.4)
  backdrop.renderOrder = 1

  return { stand, ring, tiles, plinth, rim, rimMat, pool, poolMat, backdrop, backdropMat, atlasTex }
}
