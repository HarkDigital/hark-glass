import { BRAND } from '../content'
import { holdInert, releaseInert } from './inert'
import { markLines } from './mark'
import { mountRotateGate } from './rotate'

/*
 * Boot screen: "coming into focus".
 *
 * A full-screen pane of frosted glass (a real backdrop blur over a dark
 * studio gradient, soft pools of iris and signal light, three faint backlight
 * strips) with the Hark mark drawn in thin light lines inside a thin glass
 * ring. As progress() rises the ring fills with a signal → mint gradient and
 * the mark sharpens from soft focus to crisp; a tiny mono percentage counts.
 *
 * finish(): the ring completes and the diamond lights emerald, then the
 * frost CLEARS — the backdrop blur and the gradient ease out over ~0.9 s,
 * revealing the live scene behind it like a lens pulling focus. finish()
 * resolves as the clearing starts (main.ts then fires 'hark:reveal', so the
 * hero's words come into focus with the scene), and the node removes itself
 * once the glass is gone.
 *
 * Rules: shows at least ~1.2 s, never hangs (every wait is a timer, never an
 * animation or a frame callback, so a background tab still finishes), the
 * page behind is inert while it's up, and skip (?nointro) removes it at once.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 */

const MIN_MS = 1250
/** how long the ring takes to close once finish() is called */
const CLOSE_MS = 520
/** the frost clearing (keep in step with ui.css) */
const CLEAR_MS = 950

const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  // phones held sideways get the rotate card from the very first frame
  mountRotateGate()
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  root.innerHTML = `
  <div class="ld${reduced ? ' is-reduced' : ''}">
    <div class="ld-frost" aria-hidden="true"></div>
    <div class="ld-tint" aria-hidden="true"><i class="ld-strips"></i></div>
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-core" aria-hidden="true">
      <div class="ld-lens">
        <svg class="ld-ring" viewBox="0 0 200 200">
          <defs>
            <linearGradient id="ld-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#9dffd0"/>
              <stop offset="0.5" stop-color="#3dffa6"/>
              <stop offset="1" stop-color="#00ff85"/>
            </linearGradient>
            <linearGradient id="ld-rim" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
              <stop offset="0.4" stop-color="#ffffff" stop-opacity="0.08"/>
              <stop offset="0.7" stop-color="#ffffff" stop-opacity="0.05"/>
              <stop offset="1" stop-color="#9dffd0" stop-opacity="0.35"/>
            </linearGradient>
          </defs>
          <circle class="ld-ring-body" cx="100" cy="100" r="88"/>
          <circle class="ld-ring-rim" cx="100" cy="100" r="94"/>
          <circle class="ld-ring-rim ld-ring-rim--in" cx="100" cy="100" r="82"/>
          <circle class="ld-ring-arc" cx="100" cy="100" r="88" pathLength="1" transform="rotate(-90 100 100)"/>
          <path class="ld-ring-glint" d="M 37.8 37.8 A 88 88 0 0 1 100 12"/>
        </svg>
        <div class="ld-mark">${markLines('ld-mark-svg')}</div>
      </div>
      <p class="ld-pct"><span class="ld-num">0</span><span class="ld-unit">%</span></p>
    </div>
  </div>`
  holdInert('loader', [
    document.getElementById('track'),
    document.getElementById('stages'),
    document.getElementById('chrome'),
    document.querySelector<HTMLElement>('.skip-link'),
  ])

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const num = root.querySelector<HTMLElement>('.ld-num')!
  const arc = root.querySelector<SVGCircleElement>('.ld-ring-arc')!
  const mark = root.querySelector<HTMLElement>('.ld-mark')!
  const start = performance.now()
  let target = 0
  let shown = 0
  let finishing = false
  let raf = 0
  let lastPct = -1
  let lastT = start

  const paint = (v: number) => {
    // the ring fills; the mark pulls from soft focus to sharp
    arc.style.strokeDashoffset = (1 - v).toFixed(4)
    arc.style.opacity = v > 0.004 ? '1' : '0'
    mark.style.filter = reduced || v > 0.985 ? 'none' : `blur(${((1 - v) * 4.5).toFixed(2)}px)`
    const pct = Math.round(v * 100)
    if (pct !== lastPct) {
      lastPct = pct
      num.textContent = String(pct)
    }
  }

  // Cosmetic easing toward the real progress. Before finish() the ring may
  // only creep toward ~92% at the pace of the minimum display time, so the
  // mark always has time to draw and 100 always means "done".
  const step = (ms: number) => {
    raf = 0
    const dt = Math.min(0.1, Math.max(0, (ms - lastT) / 1000))
    lastT = ms
    const cap = finishing ? 1 : Math.min(0.92, ((ms - start) / MIN_MS) * 0.92)
    const goal = Math.min(finishing ? 1 : target, cap)
    shown += (goal - shown) * (1 - Math.exp(-dt * (finishing ? 9 : 4.5)))
    if (goal - shown < 0.002) shown = goal
    paint(shown)
    if (!(finishing && shown >= 1)) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)

  return {
    progress(p: number) {
      const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
      target = Math.max(target, v)
    },
    async finish(): Promise<void> {
      const left = MIN_MS - (performance.now() - start)
      if (left > 0) await wait(left)
      // close the ring, light the gem
      finishing = true
      target = 1
      wrap.classList.add('is-done')
      if (!raf) raf = requestAnimationFrame(step)
      await wait(reduced ? 160 : CLOSE_MS)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      paint(1)
      // the frost clears: the page wakes up as the glass starts to clear
      wrap.classList.add('is-clear')
      releaseInert('loader')
      window.setTimeout(() => root.remove(), (reduced ? 420 : CLEAR_MS) + 120)
      // hand over a beat into the clearing, so the scene's own reveal rides it
      await wait(reduced ? 60 : 200)
    },
  }
}
