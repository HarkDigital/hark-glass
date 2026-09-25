import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'
import { bindScene, holdScene, releaseScene, sceneHeld } from './scene'

/*
 * Persistent chrome, in frosted glass.
 *
 *   top-left      a glass capsule: the Hark mark in a small glass lens (lit
 *                 loops, an emerald diamond), the real "Hark.Digital"
 *                 wordmark (its dot is a lit emerald bead) and a small
 *                 "Concept · Glass" tag (-> back to the start)
 *   top-right     one frosted capsule holding Work · Services · Contact and a
 *                 polished green glass "Start a project" pill. A clear glass
 *                 lozenge glides under the link you point at (or the chapter
 *                 you're in). <= 720px: a "Menu" glass pill opens a
 *                 full-screen frosted sheet (a real modal dialog: focus trap,
 *                 Escape, inert background, focus returns to Menu)
 *   bottom-left   Sound: a glass pill with four level bars that follow the
 *                 actual audio while it plays (aria-pressed)
 *   bottom-right  the readout "03 / 07 · Facets · Services" over seven glass
 *                 beads threaded on a thin glass rod; the current bead is lit
 *                 emerald and the rod fills with light as the story goes on
 *                 (each bead's stretch of rod is its chapter)
 *
 * Every text sits on a frosted fill dark enough for >= 4.5:1 over the
 * brightest light the world can put behind it. Short-landscape phones get a
 * compact single-row version (ui.css).
 *
 * API used by main.ts: createChrome(root, engine, sound) → { update(frame, state) }.
 * Navigation always uses engine.land(id) (lands on settled copy; long jumps cut).
 */

/** Plain business names beside each chapter's poetic label. */
const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const NAV = ['work', 'services', 'contact']
const MENU_QUERY = '(max-width: 720px)'
const pad = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const biz = (id: string, fallback = '') => BUSINESS[id] ?? fallback
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  // the rotate card and the menu sheet both freeze the frame behind their glass
  bindScene(engine)
  mountRotateGate(shown => (engine.paused = shown || sceneHeld()))
  // dev-only handle for audio checks in headless tests
  if (import.meta.env.DEV) (window as unknown as { __harkSound?: Sound }).__harkSound = sound

  // ---------------------------------------------------------------- markup

  const brandInner = `<span class="ch-lens" aria-hidden="true">${markSvg('ch-mark-svg', { glass: true })}</span>
      <span class="ch-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>`

  const links = NAV.filter(id => indexOf(id) >= 0)
    .map(id => `<li><a class="ch-link" href="#${id}" data-go="${id}">${biz(id)}</a></li>`)
    .join('')

  const pips = slots
    .map(
      (s, i) =>
        `<li><button class="ch-pip" type="button" data-go="${s.def.id}" data-i="${i}" aria-label="${esc(biz(s.def.id, s.def.label))}: chapter ${i + 1} of ${total}, ${esc(s.def.label)}"><i aria-hidden="true"></i></button></li>`,
    )
    .join('')

  const menuItems = slots
    .map(
      (s, i) =>
        `<li style="--i:${i}"><a class="ch-ml" href="#${s.def.id}" data-go="${s.def.id}" aria-label="${esc(biz(s.def.id, s.def.label))}, chapter ${i + 1} of ${total}: ${esc(s.def.label)}">
          <span class="ch-ml-n" aria-hidden="true">${pad(i + 1)}</span>
          <span class="ch-ml-name" aria-hidden="true">${esc(biz(s.def.id, s.def.label))}</span>
          <span class="ch-ml-lab" aria-hidden="true">${esc(s.def.label)}</span>
        </a></li>`,
    )
    .join('')

  const soundInner = `<span class="ch-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="ch-sound-k">${MICROCOPY.audio}</span><span class="ch-sound-st" aria-hidden="true">${MICROCOPY.audioOff}</span>`

  root.innerHTML = `
  <div class="chr">
    <header class="ch-top">
      <a class="ch-brand ch-glass" href="#hero" data-go="hero" aria-label="${esc(BRAND.name)}, back to the start">
        ${brandInner}
      </a>
      <nav class="ch-nav ch-glass" aria-label="Primary">
        <div class="ch-links-wrap"><span class="ch-nav-lens" aria-hidden="true"></span><ul class="ch-links">${links}</ul></div>
        <a class="hud-btn ch-cta" href="#contact" data-go="contact" data-focus>Start a project</a>
      </nav>
      <button class="ch-menu-btn ch-glass" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-t">Menu</span><span class="ch-menu-ic" aria-hidden="true"><i></i><i></i></span>
      </button>
    </header>

    <div class="ch-bottom">
      <button class="ch-sound ch-glass" type="button" data-sound-toggle aria-pressed="false">${soundInner}</button>
      <div class="ch-prog ch-glass">
        <p class="ch-read" aria-hidden="true"><span class="ch-read-n"></span><span class="ch-read-l"></span><span class="ch-read-b"></span></p>
        <nav class="ch-pips" aria-label="Chapters">
          <span class="ch-rod" aria-hidden="true"><i class="ch-rod-fill"></i></span>
          <ol>${pips}</ol>
        </nav>
      </div>
    </div>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-labelledby="ch-menu-title" data-lenis-prevent hidden>
      <div class="ch-menu-top">
        <span class="ch-brand ch-glass ch-menu-brand" aria-hidden="true">${brandInner}</span>
        <button class="ch-menu-btn ch-menu-close ch-glass" type="button">
          <span class="ch-menu-t">Close</span><span class="ch-menu-ic is-x" aria-hidden="true"><i></i><i></i></span>
        </button>
      </div>
      <div class="ch-menu-body">
        <p class="hud-eyebrow ch-menu-eyebrow" id="ch-menu-title">Menu</p>
        <nav class="ch-menu-nav" aria-label="Chapters"><ol class="ch-menu-list">${menuItems}</ol></nav>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="#contact" data-go="contact">Start a project</a>
          <button class="ch-sound ch-glass ch-menu-sound" type="button" data-sound-toggle aria-pressed="false">${soundInner}</button>
        </div>
        <p class="ch-menu-mail"><a href="mailto:${BRAND.email}">${BRAND.email}</a></p>
      </div>
    </div>
  </div>`

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chr = $('.chr')
  const top = $('.ch-top')
  const bottom = $('.ch-bottom')
  const menu = $('.ch-menu')
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const linkList = $('.ch-links-wrap')
  const lens = $('.ch-nav-lens')
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]
  const pipEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-pip')]
  const menuLinks = [...root.querySelectorAll<HTMLAnchorElement>('.ch-ml')]
  const soundBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-sound-toggle]')]
  const bars = [...root.querySelectorAll<HTMLElement>('.ch-sound:not(.ch-menu-sound) .ch-bars i')]
  const readN = $('.ch-read-n')
  const readL = $('.ch-read-l')
  const readB = $('.ch-read-b')
  const rodFill = $('.ch-rod-fill')
  const prog = $('.ch-prog')
  const readEl = $('.ch-read')

  // header-first tab order: the chrome comes before the active chapter's content
  const stagesEl = document.getElementById('stages')
  if (stagesEl && stagesEl.parentNode === root.parentNode && root.compareDocumentPosition(stagesEl) & Node.DOCUMENT_POSITION_PRECEDING) {
    stagesEl.parentNode!.insertBefore(root, stagesEl)
  }

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    if (indexOf(id) >= 0) engine.land(id)
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-go]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.go!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    sound.blip(a.matches('.ch-cta, .ch-menu-cta') ? 5 : Math.max(0, indexOf(id)))
    go(id)
    // menu links always hand focus on (the sheet they lived in is gone); the top
    // nav, CTA, brand and pips do it for keyboard activation (click.detail 0)
    if (fromMenu || (e.detail === 0 && (a.matches('.ch-link, .ch-pip, .ch-brand') || a.hasAttribute('data-focus'))))
      engine.focusChapter(id)
  })

  // ------------------------------------------------------- the nav glass lozenge

  let activeId = ''
  let hoverLink: HTMLElement | null = null
  let lensPlaced = false
  const placeLens = () => {
    const el = hoverLink ?? navEls.find(a => a.dataset.go === activeId) ?? null
    if (!el || !el.offsetWidth) {
      lens.classList.remove('is-on')
      return
    }
    lens.style.width = `${el.offsetWidth}px`
    lens.style.transform = `translate3d(${el.offsetLeft}px, 0, 0)`
    if (!lensPlaced) {
      // first placement: appear in place, no slide in from the left
      lensPlaced = true
      lens.classList.add('is-instant')
      void lens.offsetWidth
      lens.classList.remove('is-instant')
    }
    lens.classList.add('is-on')
  }
  navEls.forEach(a => {
    a.addEventListener('pointerenter', () => {
      hoverLink = a
      placeLens()
    })
    a.addEventListener('focus', () => {
      hoverLink = a
      placeLens()
    })
    a.addEventListener('blur', () => {
      if (hoverLink === a) hoverLink = null
      placeLens()
    })
  })
  linkList.addEventListener('pointerleave', () => {
    hoverLink = null
    placeLens()
  })
  window.addEventListener('resize', placeLens)
  document.fonts?.ready.then(placeLens).catch(() => {})

  // ------------------------------------------------------------- the readout

  let lastIndex = -1
  let cueIndex = -1
  const showReadout = (i: number, cue = false) => {
    const s = slots[i]
    if (!s) return
    readN.textContent = cue ? `Go to ${pad(i + 1)}` : `${pad(i + 1)} / ${pad(total)}`
    readL.textContent = s.def.label
    readB.textContent = biz(s.def.id, s.def.label)
    chr.classList.toggle('is-cue', cue)
  }
  pipEls.forEach((b, i) => {
    b.addEventListener('pointerenter', e => {
      if ((e as PointerEvent).pointerType === 'touch') return
      cueIndex = i
      showReadout(i, i !== lastIndex)
    })
    b.addEventListener('focus', () => {
      cueIndex = i
      showReadout(i, i !== lastIndex)
    })
    const uncue = () => {
      if (cueIndex !== i) return
      cueIndex = -1
      if (lastIndex >= 0) showReadout(lastIndex)
    }
    b.addEventListener('pointerleave', uncue)
    b.addEventListener('blur', uncue)
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    for (const b of soundBtns) {
      b.setAttribute('aria-pressed', String(on))
      const st = b.querySelector('.ch-sound-st')
      if (st) st.textContent = on ? MICROCOPY.audioOn : MICROCOPY.audioOff
    }
    chr.classList.toggle('is-sound', on)
    if (!on) for (const b of bars) b.style.transform = ''
  }
  for (const b of soundBtns) b.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // --------------------------------------------------------------- menu sheet

  let menuOpen = false
  let hideTimer = 0
  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    menu.hidden = false
    // flush the closed state so the entrance runs
    void menu.offsetWidth
    chr.classList.add('is-menu')
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      top,
      bottom,
    ])
    engine.lenis.stop()
    // freeze the frame once the frost is up (the sheet blurs a still image)
    hideTimer = window.setTimeout(() => {
      if (menuOpen) holdScene('menu')
    }, reduced ? 0 : 420)
    menu.scrollTop = 0
    const now = menuLinks[lastIndex] ?? menuLinks[0]
    now?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    clearTimeout(hideTimer)
    chr.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    releaseScene('menu')
    engine.lenis.start()
    hideTimer = window.setTimeout(
      () => {
        if (!menuOpen) menu.hidden = true
      },
      reduced ? 20 : 360,
    )
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  // capture: the dialog's own trap runs ahead of the no-`inert` fallback in inert.ts
  window.addEventListener(
    'keydown',
    e => {
      if (!menuOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
      } else if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        const i = f.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
        e.preventDefault()
        f[next].focus()
      }
    },
    true,
  )
  const wide = matchMedia(MENU_QUERY)
  wide.addEventListener?.('change', e => {
    if (!e.matches) closeMenu(false)
    placeLens()
  })

  // -------------------------------------------------------------------- update

  let lastFill = -1
  const lv = [0, 0, 0, 0]
  const shape = [0.34, 0.62, 0.5, 0.28]

  return {
    update(frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      if (state.index !== lastIndex) {
        const first = lastIndex < 0
        lastIndex = state.index
        if (cueIndex < 0) showReadout(state.index)
        if (!first && !reduced) {
          // a new chapter: a light sweep runs across the readout's glass and
          // the new name pulls into focus
          prog.classList.remove('is-sweep')
          void prog.offsetWidth
          prog.classList.add('is-sweep')
          if (typeof readEl.animate === 'function')
            readEl.animate([{ filter: 'blur(4px)', opacity: 0.25 }, { filter: 'blur(0px)', opacity: 1 }], {
              duration: 650,
              easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            })
        }
        pipEls.forEach((p, i) => {
          p.classList.toggle('is-on', i === state.index)
          p.classList.toggle('is-past', i < state.index)
          if (i === state.index) p.setAttribute('aria-current', 'step')
          else p.removeAttribute('aria-current')
        })
        activeId = slot.def.id
        navEls.forEach(a => {
          const on = a.dataset.go === activeId
          a.classList.toggle('is-active', on)
          if (on) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        menuLinks.forEach((a, i) => {
          a.classList.toggle('is-now', i === state.index)
          if (i === state.index) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        chr.dataset.chapter = activeId
        placeLens()
      }

      // the rod: each bead owns an equal stretch; it fills through that stretch
      // as its chapter plays, so the light reaches a bead half-way through it
      const fill = Math.round(((state.index + Math.min(1, Math.max(0, state.local))) / total) * 1000) / 1000
      if (fill !== lastFill) {
        lastFill = fill
        rodFill.style.transform = `scaleX(${fill})`
      }

      // sound bars follow the real signal (a calm fixed shape under reduced motion)
      if (sound.enabled && bars.length) {
        if (!reduced && sound.meter(lv)) {
          for (let i = 0; i < 4; i++) {
            const idle = 0.5 + 0.5 * Math.sin(frame.time * (1.1 + i * 0.37) + i * 1.7)
            const v = Math.min(1, 0.36 + shape[i] * 0.3 * idle + lv[i] * lv[i] * 0.6)
            bars[i].style.transform = `scaleY(${v.toFixed(3)})`
          }
        } else for (let i = 0; i < 4; i++) bars[i].style.transform = `scaleY(${(0.3 + shape[i]).toFixed(2)})`
      }
    },
  }
}
