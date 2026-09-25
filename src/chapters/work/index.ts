import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, WORK, workImage, type WorkItem } from '../../content'
import { G } from '../../kit/glass'
import { loadScreenshot, whenRevealed } from '../../kit/images'
import { ACCENTS, BW, CH, CW, STACK_THETA, arcNormal, buildGallery, isPreview, onArc, theta, LIFT, type Gallery } from './scene'
import './work.css'

/*
 * VITRINE (Selected work) — a cool glass gallery.
 *
 * Six thick glass display blocks stand on a gentle arc of dark polished
 * plinth, each with its project's screenshot embedded behind the front face.
 * The camera glides along the arc; the block it arrives at turns to face it
 * and a light sweep (the studio environment rotating) runs across its face
 * while the others dim and drift back; blocks the story has passed fade right
 * down (on landscape they sit behind the card's column). A frosted card names
 * the block on screen. At the end of the plinth, a file of nine frosted glass
 * cards fans open in depth (the rest of the portfolio), with the list of links
 * beside it: the current row's card rises out of the file showing its site.
 *
 *   0.000–0.145  intro: "Built to be heard." — the row at a 3/4 angle, light
 *                running block to block (nav jumps land here, at 0.12)
 *   0.145–0.800  six items (~0.109 each): glide 0–34%, turn 6–42%, sweep
 *                16–62%, card 17–99%
 *   0.800–0.842  glide to the file (a brief focus pull), the cards fan open
 *   0.842–0.956  "Nine more, all live." list; the current card rises out
 *   0.956–1.000  out: a slow pull back
 *
 * Everything derives from `local`; frame.time only drives the float, the
 * turntable sway and the caustic ripple.
 */

const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const NF = FEATURED.length
const NR = REST.length

const F0 = 0.145
const F1 = 0.8
const SPAN = (F1 - F0) / NF
const LIST_IN = 0.842
const ROW0 = 0.852
const ROW1 = 0.944
const LIST_OUT = 0.956

/* inside one item (phase p 0..1) */
const TRAVEL = 0.34
const TURN_A = 0.06
const TURN_B = 0.42
const SWEEP_A = 0.16
const SWEEP_B = 0.62

const itemStart = (k: number) => F0 + SPAN * k
/* the glide from the intro view to the first block starts under the fading headline */
const T0A = F0 - 0.012
const TRAVEL0 = 0.2
const T0B = F0 + TRAVEL0 * SPAN
const rowAt = (j: number) => ROW0 + ((j + 0.5) * (ROW1 - ROW0)) / NR

/** the long glass ease-out (~cubic-bezier(0.16, 1, 0.3, 1)) */
const settle = (t: number) => 1 - Math.pow(1 - clamp(t), 4)

/* block poses (pivot yaw relative to the arc normal) */
const REST_YAW = -0.42
const ACTIVE_YAW = 0.05
/* camera: a touch left of square so the block's thick left edge shows */
const CAM_YAW = -0.17
const CAM_PITCH = 0.1
const FOV = 30
/** studio reflection strength for this chapter */
const ENV = 1.2
const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
const pad = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const emLast = (s: string) => {
  const parts = s.split(' ')
  if (parts.length < 2) return `<em>${esc(s)}</em>`
  const last = parts.pop()!
  return `${esc(parts.join(' '))} <em>${esc(last)}</em>`
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

type PhaseKind = 'intro' | 'item' | 'list' | 'out'
interface Phase {
  kind: PhaseKind
  k: number
  p: number
}
function phaseOf(l: number): Phase {
  if (l < F0) return { kind: 'intro', k: -1, p: clamp(l / F0) }
  if (l < F1) {
    const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
    return { kind: 'item', k, p: clamp((l - itemStart(k)) / SPAN) }
  }
  if (l < LIST_OUT) return { kind: 'list', k: NF, p: clamp((l - F1) / (LIST_OUT - F1)) }
  return { kind: 'out', k: NF, p: clamp((l - LIST_OUT) / (1 - LIST_OUT)) }
}

/** 0..1: how much featured block k is "the one" at local l */
function activeW(k: number, l: number) {
  const s = itemStart(k)
  const inn = settle((l - (s + TURN_A * SPAN)) / ((TURN_B - TURN_A) * SPAN))
  const next = k < NF - 1 ? itemStart(k + 1) : F1
  const out = ease.inOutCubic(clamp((l - next) / (0.3 * SPAN)))
  return inn * (1 - out)
}

interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface Shot {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  /** subject centre in NDC */
  cx: number
  cy: number
  /** subject half-width in light-field units (screen height = 2) */
  hw: number
}
const shot = (): Shot => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: FOV, cx: 0, cy: 0, hw: 0.5 })

interface Layout {
  key: string
  W: number
  H: number
  portrait: boolean
  safe: Region
  dockR: number
  cardTop: number[]
  listR: number
  listTop: number
  introB: number
}

interface CardEl {
  root: HTMLElement
  name: HTMLElement
}

const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const _c = new THREE.Vector3()
const _n = new THREE.Vector3()

/**
 * Aim a camera (yaw, pitch) so a w×h subject centred at C fills the screen
 * region `reg` (CSS px). `halfW` is the half-width used for the light field's
 * spread (world units).
 */
function frameTo(out: Shot, C: THREE.Vector3, w: number, h: number, yaw: number, pitch: number, fov: number, reg: Region, W: number, H: number, halfW: number) {
  _d.set(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const aspect = W / Math.max(1, H)
  const tanH = Math.tan((fov * DEG) / 2)
  const fw = Math.max(0.08, (reg.x1 - reg.x0) / W)
  const fh = Math.max(0.08, (reg.y1 - reg.y0) / H)
  const cx = ((reg.x0 + reg.x1) / 2 / W) * 2 - 1
  const cy = 1 - ((reg.y0 + reg.y1) / 2 / H) * 2
  const dist = Math.max(w / 2 / (fw * tanH * aspect), h / 2 / (fh * tanH))
  const hh = dist * tanH
  const hwid = hh * aspect
  _r.crossVectors(_d, UP).normalize()
  _u.crossVectors(_r, _d).normalize()
  out.pos.copy(C).addScaledVector(_d, -dist).addScaledVector(_r, -cx * hwid).addScaledVector(_u, -cy * hh)
  out.tgt.copy(out.pos).addScaledVector(_d, dist)
  out.fov = fov
  out.cx = cx
  out.cy = cy
  out.hw = halfW / hh
  return out
}

class Work implements Chapter {
  id = 'work'
  group = new THREE.Group()
  anchors = [...FEATURED.map((_, k) => itemStart(k) + SPAN * 0.52), ...REST.map((_, j) => rowAt(j))]

  private ctx!: ChapterContext
  private gal!: Gallery
  private mobile = false
  private reduced = false

  // DOM
  private safe!: HTMLElement
  private intro!: HTMLElement
  private introTitle!: HTMLElement
  private dock!: HTMLElement
  private cards: CardEl[] = []
  private listDock!: HTMLElement
  private list!: HTMLElement
  private listTitle!: HTMLElement
  private rows: HTMLAnchorElement[] = []
  private hoverRow = -1
  private curRow = -2

  // layout / camera
  private lay: Layout | null = null
  private layDirty = true
  private cur = shot()
  private sa = shot()
  private sb = shot()
  private tmp = new THREE.Vector3()
  /** per index card: 0 = in the file, 1 = risen out of it (damped) */
  private sel: number[] = REST.map(() => 0)
  /**
   * Materials that carry their own envMap (the studio) so their
   * envMapIntensity is honoured — with only scene.environment, three uses
   * scene.environmentIntensity for every material. Their envMapRotation
   * follows the scene's each frame so light sweeps still run across them.
   */
  private envMats: THREE.MeshPhysicalMaterial[] = []
  private lastT = -1

  async init(ctx: ChapterContext) {
    this.ctx = ctx
    this.mobile = ctx.mobile
    this.reduced = ctx.reducedMotion
    this.buildDom(ctx.stage)
    await nextFrame()
    this.gal = buildGallery(FEATURED, REST, this.mobile)
    this.group.add(this.gal.root)
    const env = ctx.world.envMap
    if (env) {
      const mats = [...this.gal.blocks.map(b => b.glassMat), this.gal.plinth.material as THREE.MeshPhysicalMaterial, ...this.gal.cards.map(c => c.mat)]
      for (const m of mats) {
        m.envMap = env
        this.envMats.push(m)
      }
    }
    await nextFrame()
    window.addEventListener('resize', () => (this.layDirty = true))
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => (this.layDirty = true))
      for (const c of this.cards) ro.observe(c.root)
      ro.observe(this.list)
      ro.observe(this.intro)
      ro.observe(this.safe)
    }
    document.fonts?.ready.then(() => (this.layDirty = true))

    // screenshots: the first block now, the rest once the site is revealed
    const width = this.mobile ? 640 : (window.devicePixelRatio || 1) > 1.4 ? 1280 : 960
    const load = (k: number) =>
      loadScreenshot(workImage(FEATURED[k].id), { width })
        .then(tex => {
          tex.anisotropy = 8
          try {
            this.ctx.renderer.initTexture(tex)
          } catch {
            /* uploads on first use instead */
          }
          const m = this.gal.blocks[k].shotMat
          const old = m.map
          m.map = tex
          old?.dispose()
        })
        .catch(err => console.warn(`[work] missing screenshot for ${FEATURED[k].id}`, err))
    // the nine index cards show theirs only when risen (~a third of a block's size on screen)
    const cardWidth = this.mobile ? 640 : (window.devicePixelRatio || 1) > 1.4 ? 960 : 720
    const loadCard = (j: number) =>
      loadScreenshot(workImage(REST[j].id), { width: cardWidth })
        .then(tex => {
          tex.anisotropy = 4
          try {
            this.ctx.renderer.initTexture(tex)
          } catch {
            /* uploads on first use instead */
          }
          const m = this.gal.cards[j].shotMat
          const old = m.map
          m.map = tex
          old?.dispose()
        })
        .catch(err => console.warn(`[work] missing screenshot for ${REST[j].id}`, err))
    load(0)
    whenRevealed().then(async () => {
      for (let k = 1; k < NF; k++) {
        await load(k)
        await nextFrame()
      }
      for (let j = 0; j < NR; j++) {
        await loadCard(j)
        await nextFrame()
      }
    })
  }

  // ------------------------------------------------------------------ DOM

  private buildDom(stage: HTMLElement) {
    this.safe = el('div', 'wk-safe', undefined, stage)

    // intro
    this.intro = el('div', 'wk-intro', undefined, stage)
    el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, this.intro)
    const title = SECTIONS.work.title
    const cut = title.lastIndexOf(' ')
    this.introTitle = rise(
      el('h2', 'hud-h2 wk-title', undefined, this.intro),
      cut > 0 ? `${esc(title.slice(0, cut))} <em>${esc(title.slice(cut + 1))}</em>` : `<em>${esc(title)}</em>`,
    )
    const count = el('p', 'wk-count', undefined, this.intro)
    count.innerHTML = [`${WORK.length} sites`, `${NF} featured`, `${NR} more`].map(s => `<span>${esc(s)}</span>`).join('<i aria-hidden="true"></i>')

    // one frosted card per block, docked left (bottom on portrait)
    this.dock = el('div', 'wk-dock', undefined, stage)
    FEATURED.forEach((w, k) => this.cards.push(this.buildCard(this.dock, w, k)))

    // the other nine
    this.listDock = el('div', 'wk-dock wk-dock--list', undefined, stage)
    this.list = el('section', 'wk-list hud-panel hud-panel--strong', undefined, this.listDock)
    const meta = el('div', 'wk-meta', undefined, this.list)
    el('span', 'wk-num', `${pad(NF + 1)}–${pad(NF + NR)} / ${pad(WORK.length)}`, meta)
    el('span', 'hud-label wk-ind', 'More work', meta)
    const allLive = REST.every(w => !isPreview(w.url))
    const count9 = WORDS[NR] ?? String(NR)
    this.listTitle = rise(
      el('h3', 'hud-h2 wk-list-title', undefined, this.list),
      allLive ? `${esc(count9)} more, <em>all live.</em>` : `${esc(count9)} <em>more.</em>`,
    )
    const ol = el('ol', 'wk-rows', undefined, this.list)
    REST.forEach((w, j) => {
      const li = el('li', '', undefined, ol)
      const a = el('a', 'wk-row', undefined, li)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noopener'
      const pre = isPreview(w.url)
      a.innerHTML = `<span class="wk-no">${pad(NF + j + 1)}</span><span class="wk-rname">${esc(w.name)}${
        pre ? ' <small class="wk-pre">Preview</small>' : ''
      }</span><span class="wk-rind">${esc(w.industry)}</span><span class="wk-arrow" aria-hidden="true">↗</span>`
      const on = () => (this.hoverRow = j)
      const off = () => {
        if (this.hoverRow === j) this.hoverRow = -1
      }
      a.addEventListener('pointerenter', on)
      a.addEventListener('pointerleave', off)
      a.addEventListener('focus', on)
      a.addEventListener('blur', off)
      this.rows.push(a)
    })
    const cta = el('div', 'wk-cta', undefined, this.list)
    const hello = el('button', 'hud-btn', 'Say hello', cta)
    hello.type = 'button'
    hello.addEventListener('click', () => window.__hark?.land('contact'))
  }

  private buildCard(parent: HTMLElement, w: WorkItem, k: number): CardEl {
    const root = el('article', 'wk-card hud-panel hud-panel--strong', undefined, parent)
    const pre = isPreview(w.url)
    const meta = el('div', 'wk-meta', undefined, root)
    el('span', 'wk-num', `${pad(k + 1)} / ${pad(NF)}`, meta)
    el('span', 'hud-label wk-ind', w.industry, meta)
    if (pre) el('span', 'wk-badge', 'Preview', meta)
    const name = rise(el('h3', 'hud-h2 wk-name', undefined, root), emLast(w.name))
    el('p', 'hud-body wk-blurb', w.blurb, root)
    const tags = el('ul', 'hud-tags wk-tags', undefined, root)
    for (const t of w.tags) el('li', 'hud-tag', t, tags)
    const cta = el('div', 'wk-cta', undefined, root)
    const a = el('a', 'hud-btn hud-btn--ghost wk-visit', pre ? 'Preview site ↗' : 'Visit site ↗', cta)
    a.href = w.url
    a.target = '_blank'
    a.rel = 'noopener'
    el('span', 'hud-label wk-host', pre ? 'Pre-launch build' : hostOf(w.url), cta)
    return { root, name }
  }

  // ------------------------------------------------------------------ layout

  private ensureLayout(f: Frame): Layout {
    const key = `${f.width}x${f.height}`
    if (this.lay && this.lay.key === key && !this.layDirty) return this.lay
    this.layDirty = false
    const W = f.width
    const H = f.height
    const portrait = typeof matchMedia === 'function' ? matchMedia('(max-aspect-ratio: 10/9)').matches : W / H < 1.1
    const s = this.safe.getBoundingClientRect()
    const safe = s.width > 0 ? { x0: s.left, y0: s.top, x1: s.right, y1: s.bottom } : { x0: 24, y0: 90, x1: W - 24, y1: H - 90 }
    // offset* metrics ignore the reveal() translate on hidden cards / the list
    const dock = this.dock
    const ld = this.listDock
    const list = this.list
    const measured = dock.offsetWidth > 0
    this.lay = {
      key,
      W,
      H,
      portrait,
      safe,
      dockR: measured ? dock.offsetLeft + dock.offsetWidth : W * 0.38,
      cardTop: this.cards.map(c => (measured && c.root.offsetHeight > 0 ? dock.offsetTop + c.root.offsetTop : H * 0.55)),
      listR: list.offsetWidth > 0 ? ld.offsetLeft + list.offsetLeft + list.offsetWidth : W * 0.4,
      listTop: list.offsetHeight > 0 ? ld.offsetTop + list.offsetTop : H * 0.45,
      introB: this.intro.offsetHeight > 0 ? this.intro.offsetTop + this.intro.offsetHeight : H * 0.35,
    }
    return this.lay
  }

  private region(kind: 'item' | 'list' | 'intro', k: number): Region {
    const L = this.lay!
    const s = L.safe
    if (kind === 'intro') {
      if (L.portrait) return { x0: 0, x1: L.W, y0: Math.min(L.introB + 16, L.H * 0.55), y1: s.y1 }
      return { x0: L.W * 0.22, x1: L.W - L.W * 0.02, y0: Math.min(L.introB + L.H * 0.02, L.H * 0.5), y1: s.y1 + L.H * 0.05 }
    }
    if (L.portrait) {
      const top = kind === 'item' ? L.cardTop[k] : L.listTop
      return { x0: 4, x1: L.W - 4, y0: s.y0 + 6, y1: Math.max(s.y0 + 90, top - 14) }
    }
    const right = kind === 'item' ? L.dockR : L.listR
    return { x0: right + L.W * 0.035, x1: s.x1 + L.W * 0.005, y0: s.y0, y1: s.y1 }
  }

  // ------------------------------------------------------------------ shots

  private itemShot(k: number, drift: number, out: Shot) {
    const L = this.lay!
    const th = theta(k)
    arcNormal(th, _n)
    onArc(th, undefined, _c).addScaledVector(_n, 0.1)
    // block (1.16 tall, floating) + the plinth and its pool beneath
    _c.y = 0.56
    const yaw = -th + CAM_YAW + drift * 0.035
    const port = L.portrait
    frameTo(out, _c, BW + (port ? 0.2 : 0.8), port ? 1.6 : 1.9, yaw, CAM_PITCH, FOV, this.region('item', k), L.W, L.H, BW / 2)
    out.pos.lerp(out.tgt, drift * 0.035)
    return out
  }

  private introShot(u: number, out: Shot) {
    const L = this.lay!
    const port = L.portrait
    onArc(theta(port ? 0.9 : 2.1), undefined, _c)
    _c.y = 0.55
    const yaw = lerp(-0.62, -0.54, u)
    frameTo(out, _c, port ? 3.4 : 8.2, port ? 2.4 : 2.2, yaw, lerp(0.1, 0.085, u), FOV, this.region('intro', 0), L.W, L.H, 2.6)
    return out
  }

  /**
   * The file of cards, with room above it for the card that rises out.
   * `row` (0..1, continuous in scroll) eases the aim back along the file as
   * the risen card moves deeper; portrait frames just the risen card (the
   * file sits behind the list panel there), tilting up to it as the rows
   * begin (`up` 0..1).
   */
  private stackShot(drift: number, row: number, up: number, out: Shot) {
    const L = this.lay!
    const port = L.portrait
    arcNormal(STACK_THETA, _n)
    const depth = (NR - 1) * CARD_STEP_Z
    onArc(STACK_THETA, undefined, _c).addScaledVector(_n, port ? -0.1 - depth * row : -0.35 - depth * 0.35 * row)
    _c.y = port ? lerp(0.95, 1.52 + 0.2 * row, up) : 1.1 + 0.12 * row
    const yaw = -STACK_THETA - 0.16 + drift * 0.04
    if (port) frameTo(out, _c, CW + 0.14, lerp(1.8, 1.28, up), yaw, 0.13, FOV, this.region('list', 0), L.W, L.H, CW / 2 + 0.04)
    else frameTo(out, _c, CW + 0.7, 2.4, yaw, 0.15, FOV, this.region('list', 0), L.W, L.H, CW / 2 + 0.04)
    out.pos.lerp(out.tgt, drift * 0.03)
    return out
  }

  private outShot(out: Shot) {
    this.stackShot(1, 1, 1, out)
    this.tmp.subVectors(out.pos, out.tgt)
    out.pos.copy(out.tgt).addScaledVector(this.tmp, 1.28)
    out.pos.y += 0.35
    out.hw *= 0.8
    return out
  }

  private travel(a: Shot, b: Shot, t: number, pull: number, out: Shot) {
    const e = ease.inOutCubic(clamp(t))
    out.pos.lerpVectors(a.pos, b.pos, e)
    out.tgt.lerpVectors(a.tgt, b.tgt, e)
    out.fov = lerp(a.fov, b.fov, e)
    out.cx = lerp(a.cx, b.cx, e)
    out.cy = lerp(a.cy, b.cy, e)
    out.hw = lerp(a.hw, b.hw, e)
    const bump = Math.sin(Math.PI * clamp(t)) * pull
    this.tmp.subVectors(out.pos, out.tgt).normalize()
    out.pos.addScaledVector(this.tmp, bump)
    out.pos.y += bump * 0.18
    return out
  }

  private shotAt(l: number, out: Shot) {
    if (l < T0A) return this.introShot(l / T0A, out)
    if (l < T0B) return this.travel(this.introShot(1, this.sa), this.itemShot(0, 0, this.sb), (l - T0A) / (T0B - T0A), 0.25, out)
    const ph = phaseOf(l)
    if (ph.kind === 'item') {
      const k = ph.k
      if (k > 0 && ph.p < TRAVEL) return this.travel(this.itemShot(k - 1, 1, this.sa), this.itemShot(k, 0, this.sb), ph.p / TRAVEL, 0.55, out)
      const tr = k === 0 ? TRAVEL0 : TRAVEL
      return this.itemShot(k, clamp((ph.p - tr) / (1 - tr)), out)
    }
    const row = smoothstep(ROW0, ROW1, l)
    const up = smoothstep(LIST_IN - 0.012, ROW0 + 0.004, l)
    if (l < LIST_IN) return this.travel(this.itemShot(NF - 1, 1, this.sa), this.stackShot(0, 0, up, this.sb), (l - F1) / (LIST_IN - F1), 0.7, out)
    if (l < LIST_OUT) return this.stackShot((l - LIST_IN) / (LIST_OUT - LIST_IN), row, up, out)
    return this.travel(this.stackShot(1, 1, 1, this.sa), this.outShot(this.sb), (l - LIST_OUT) / (1 - LIST_OUT), 0, out)
  }

  // ------------------------------------------------------------------ light

  /**
   * The studio's rotation (world.params.envTurn): a slow pass along the row in
   * the intro, then one sweep across each block as it arrives (alternating
   * direction so the value stays continuous), then a slow drift for the list.
   */
  private turnAt(l: number) {
    const amp = this.reduced ? 0.2 : 0.38
    const center = (k: number) => TURN_C + k * TURN_STEP
    const startOf = (k: number) => center(k) - (k % 2 === 0 ? amp : -amp)
    const endOf = (k: number) => center(k) + (k % 2 === 0 ? amp : -amp)
    const I0 = center(0) - 1.35
    const I1 = startOf(0) - 0.1
    if (l < F0) return lerp(I0, I1, smoothstep(0, 1, l / F0))
    if (l < F1) {
      const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
      const p = clamp((l - itemStart(k)) / SPAN)
      const prev = k === 0 ? I1 : endOf(k - 1)
      if (p < SWEEP_A) return lerp(prev, startOf(k), smoothstep(0, SWEEP_A, p))
      return lerp(startOf(k), endOf(k), ease.inOutCubic(clamp((p - SWEEP_A) / (SWEEP_B - SWEEP_A))))
    }
    const e5 = endOf(NF - 1)
    return lerp(e5, e5 + LIST_TURN, smoothstep(F1, LIST_OUT, l))
  }

  // ------------------------------------------------------------------ frame

  update(local: number, frame: Frame, ctx: ChapterContext) {
    const l = clamp(local)
    const time = frame.time
    const dt = this.lastT < 0 ? 1 : Math.min(0.1, Math.max(0, time - this.lastT))
    this.lastT = time
    const reduced = this.reduced || frame.reducedMotion
    this.ensureLayout(frame)
    const ph = phaseOf(l)
    const gal = this.gal

    // ---- camera shot (camera() copies it)
    this.shotAt(l, this.cur)
    const s = this.cur

    // ---- world: a cool gallery (iris / aqua / blue), strips behind the subject
    const wp = ctx.world.params
    const kAct = ph.kind === 'item' ? ph.k : -1
    wp.a = G.iris
    wp.b = G.aqua
    wp.c = '#1b34a8'
    wp.d = kAct >= 0 ? ACCENTS[kAct % ACCENTS.length] : '#9dffd0'
    wp.base = '#04060b'
    wp.glow = 0.37
    wp.flow = reduced ? 0.25 : 0.7
    wp.strips = ph.kind === 'intro' ? 0.9 : 1
    wp.stripColor = '#e3ecff'
    // Strips: short softboxes. In the intro they glow behind the row (below
    // the headline); from the first glide on, only the outer pair, spread so
    // they stand just off the subject's sides (the glass edges catch them,
    // the screenshot face stays clean). The pair's midpoint sits 0.09·spread
    // right of focus, so focus shifts left by that much.
    const flank = smoothstep(T0A, T0B, l)
    const spreadIntro = clamp(s.hw * 1.8, 0.7, 1.5)
    const spreadFlank = clamp((s.hw + 0.07) / 0.43, 0.7, 2.2)
    const spread = lerp(spreadIntro, spreadFlank, flank)
    wp.spread = spread
    wp.stripHeight = lerp(0.36, 0.52 / spread, flank)
    wp.stripMask.set(1, 0.55 * (1 - flank), 1)
    // focus behind the subject, in the field's own coordinates (incl. its heading drift)
    _d.subVectors(s.tgt, s.pos).normalize()
    const yawW = Math.atan2(_d.x, -_d.z)
    const pitchW = Math.asin(clamp(_d.y, -1, 1))
    const aspect = frame.width / Math.max(1, frame.height)
    wp.focus.set(s.cx * aspect + Math.sin(yawW) * 0.35 - 0.09 * spread * flank, s.cy + pitchW * 0.3 + 0.05)
    wp.env = ENV
    wp.envTurn = this.turnAt(l)
    wp.key = 1.5
    wp.keyDir.set(-0.55, 0.75, 0.5)
    wp.fill = 0.3

    const scene = this.group.parent as THREE.Scene | null
    if (scene && (scene as THREE.Scene).isScene) for (const m of this.envMats) m.envMapRotation.copy(scene.environmentRotation)

    // ---- post: a brief focus pull on the way to the stack
    const pp = ctx.post.params
    const fp = clamp((l - F1) / (LIST_IN - F1 + 0.012))
    pp.frost = Math.sin(Math.PI * fp) * (reduced ? 0.12 : 0.22)
    pp.bloomStrength = 0.5
    // only the emerald, the light line and hard glints bloom — never a screenshot
    pp.bloomThreshold = 1.05
    pp.vignette = 0.32

    // ---- blocks
    const dimAll = smoothstep(F0, F0 + 0.25 * SPAN, l)
    const landscape = !this.lay!.portrait
    const floatA = reduced ? 0.004 : 0.012
    const floatF = reduced ? 0.25 : 0.8
    const inList = l > F1 + 0.3 * SPAN
    const pulse = (k: number) => {
      // intro: the light runs block to block
      if (ph.kind !== 'intro') return 0
      const c = 0.2 + k * 0.13
      const x = (ph.p - c) / 0.16
      return Math.exp(-x * x)
    }
    for (let k = 0; k < NF; k++) {
      const b = gal.blocks[k]
      const w = activeW(k, l)
      const d = dimAll * (1 - w)
      // on landscape a block the story has moved past rests where the card
      // docks: take its screenshot, plaque and inlay right down so no site
      // text sits beside the card's text
      const next = k < NF - 1 ? itemStart(k + 1) : F1
      const gone = landscape ? smoothstep(next, next + 0.3 * SPAN, l) : 0
      b.station.visible = !inList || k >= NF - 2
      const sway = reduced ? 0 : Math.sin(time * 0.35 + k) * 0.03 * w
      b.pivot.rotation.y = lerp(REST_YAW, ACTIVE_YAW, w) + sway
      b.pivot.position.z = lerp(-0.3 * d - 0.2 * gone, 0.14, w)
      b.pivot.position.y = LIFT + 0.02 * w + Math.sin(time * floatF + k * 1.3) * floatA
      const pu = pulse(k)
      const shotB = lerp(lerp(0.78, 0.34, d), 0.82, w) * (1 - gone)
      b.shotMat.color.setScalar(shotB)
      b.shot.visible = shotB > 0.003
      b.glassMat.envMapIntensity = (lerp(lerp(1, 0.66, d), 1.1, w) + pu * 0.45) * (1 - 0.3 * gone) * ENV
      b.gemMat.color.copy(b.gemColor).multiplyScalar((lerp(lerp(0.9, 0.35, d), 2.6, w) + pu * 1.4) * (1 - 0.9 * gone))
      b.plaque.material.opacity = lerp(lerp(0.5, 0.28, d), 0.8, w) * (1 - 0.85 * gone)
      b.rimMat.uniforms.uStrength.value = (lerp(lerp(0.35, 0.12, d), 0.75, w) + pu * 0.6) * (1 - 0.5 * gone)
      const pu2 = b.poolMat.uniforms
      pu2.uStrength.value = (lerp(lerp(0.26, 0.12, d), 0.5, w) + pu * 0.25) * (1 - 0.4 * gone)
      pu2.uTime.value = time * (reduced ? 0.08 : 0.35)
    }
    gal.lineMat.color.set('#9d92ff').multiplyScalar(lerp(1.4, 2.2, dimAll))

    // ---- the file of nine cards: the current row's card rises out of it
    const stackOn = l > F1 - 0.5 * SPAN
    gal.stack.visible = stackOn
    if (stackOn) {
      const fan = settle((l - (F1 + 0.008)) / (LIST_IN - F1 + 0.01))
      // from the first row on, one card is always out (the last stays up through the pull back)
      const inRows = l >= ROW0 - 0.006
      const scrollRow = clamp(Math.floor(((l - ROW0) / (ROW1 - ROW0)) * NR), 0, NR - 1)
      const selIdx = this.hoverRow >= 0 ? this.hoverRow : inRows ? scrollRow : -1
      const stepY = lerp(0.006, CARD_STEP_Y, fan)
      const stepZ = lerp(0.028, CARD_STEP_Z, fan)
      const kS = 1 - Math.exp(-7 * dt)
      const cy = 0.07 + (CH / 2) * Math.cos(CARD_LEAN)
      for (let j = 0; j < NR; j++) {
        const c = gal.cards[j]
        const target = j === selIdx ? 1 : 0
        this.sel[j] += (target - this.sel[j]) * kS
        if (Math.abs(target - this.sel[j]) < 1e-3) this.sel[j] = target
        const sv = this.sel[j]
        const up = sv * sv * (3 - 2 * sv)
        // front to back: 07 at the front
        c.root.position.set(0, cy + j * stepY, -j * stepZ)
        c.root.rotation.set(CARD_LEAN, 0, 0)
        // rise along the card's own lean (never into its neighbours), then a touch forward
        c.lift.position.set(0, up * CARD_RISE * fan, up * 0.05)
        c.mat.roughness = lerp(0.3, 0.16, sv)
        c.mat.envMapIntensity = lerp(0.9, 1.1, sv) * ENV
        const show = smoothstep(0.35, 0.9, sv)
        c.shotMat.opacity = show
        c.shot.visible = show > 0.004
        c.plaque.material.opacity = show * 0.78
        c.plaque.mesh.visible = show > 0.004
      }
      gal.stackPoolMat.uniforms.uStrength.value = 0.2 + 0.25 * fan
      gal.stackPoolMat.uniforms.uTime.value = time * (reduced ? 0.08 : 0.35)
      if (selIdx !== this.curRow) {
        this.rows.forEach((r, j) => r.classList.toggle('is-cur', j === selIdx))
        this.curRow = selIdx
      }
    }

    // ---- DOM
    const introV = 1 - smoothstep(F0 - 0.006, F0 + 0.008, l)
    reveal(this.intro, introV, 0)
    setRise(this.introTitle, l > 0.006 && l < F0 + 0.002)
    for (let k = 0; k < NF; k++) {
      let v = 0
      if (ph.kind === 'item' && ph.k === k) v = (k === 0 ? smoothstep(0.13, 0.21, ph.p) : smoothstep(0.17, 0.26, ph.p)) * (1 - smoothstep(0.95, 0.995, ph.p))
      reveal(this.cards[k].root, v, 10)
      setRise(this.cards[k].name, v > 0.35)
    }
    const listV = smoothstep(F1 + 0.028, LIST_IN + 0.002, l) * (1 - smoothstep(LIST_OUT - 0.002, LIST_OUT + 0.008, l))
    reveal(this.listDock, listV, 10)
    // a list that hides under a still cursor never gets its pointerleave
    if (listV <= 0.01) this.hoverRow = -1
    setRise(this.listTitle, listV > 0.35)
  }

  camera(_local: number, _frame: Frame, out: CameraPose) {
    out.position.copy(this.cur.pos)
    out.target.copy(this.cur.tgt)
    out.fov = this.cur.fov
    out.parallax = this.reduced ? 0 : 0.14
  }
}

/* the file of index cards: slot step (up, back) when fanned open, lean, and how far the current card rises */
const CARD_STEP_Y = 0.03
const CARD_STEP_Z = 0.14
const CARD_LEAN = -0.16
const CARD_RISE = 0.95

/* studio turn: the value where the tall key strip crosses block 0's face, and the step per block */
const TURN_C = -0.9
const TURN_STEP = -0.18
const LIST_TURN = 0.5

export default function create(): Chapter {
  return new Work()
}
