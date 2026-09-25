import { holdInert, releaseInert } from './inert'
import { holdScene, releaseScene } from './scene'
import { markSvg } from './mark'

/*
 * Phone-landscape suggestion: a frosted glass card over the (paused, blurred)
 * scene. Hark Glass is framed in portrait on phones, so a short, touch-first
 * landscape viewport is offered "Turn your phone upright" with a glass phone
 * that turns upright once, plus "Continue anyway". Tablets and laptops in
 * landscape are taller than 500px and never see it.
 *
 * It is a suggestion, never a lock (WCAG 1.3.4): "Continue anyway" releases
 * the gate for the rest of the session, and while the card shows, the skip
 * link and the linear copy layer in #track stay reachable for keyboards and
 * screen readers (only the chrome, the stages and the loader behind it are
 * inert).
 *
 * Visibility is pure CSS (the same query, in ui.css) so it is right on the
 * very first paint; JS makes the covered layers inert while it shows,
 * announces it, and pauses the hidden scene (scene.ts).
 *
 * API: mountRotateGate(onChange?) / unmountRotateGate(). Safe to call more
 * than once: later calls just add their onChange listener.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

const DISMISS_KEY = 'hark-glass:rotate-ok'
const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
const rememberDismissed = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* private mode / blocked storage: the choice lasts until reload */
  }
}

const PHONE = `<svg class="rot-phone" viewBox="0 0 60 100" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="rotg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="#9dffd0" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#b3abff" stop-opacity="0.8"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="54" height="94" rx="12" fill="rgba(255,255,255,0.06)" stroke="url(#rotg)" stroke-width="2"/>
  <rect x="23" y="9" width="14" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/>
  <path d="M8 16 L20 8" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round"/>
</svg>`

let gate: {
  el: HTMLElement
  mq: MediaQueryList
  sync: () => void
  listeners: ((shown: boolean) => void)[]
  on: () => boolean
} | null = null

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.on())
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  let dismissed = wasDismissed()
  const el = document.createElement('div')
  el.className = dismissed ? 'rot is-dismissed' : 'rot'
  // non-modal: the copy layer behind it stays in reach
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <div class="rot-card">
      <div class="rot-art" aria-hidden="true">
        ${PHONE}
        <span class="rot-gem">${markSvg('rot-mark', { glass: true })}</span>
      </div>
      <div class="rot-text">
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright.</em></h2>
        <p class="rot-sub" id="rot-sub">Hark Glass is framed for portrait.</p>
        <p class="rot-actions"><button class="hud-btn hud-btn--ghost rot-go" type="button">Continue anyway</button></p>
      </div>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  // right after the skip link: Tab goes skip link -> this card -> the copy layer
  const skip = document.querySelector('.skip-link')
  if (skip && skip.parentNode === document.body) skip.after(el)
  else document.body.prepend(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const go = el.querySelector<HTMLButtonElement>('.rot-go')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  const sync = () => {
    const want = mq.matches && !dismissed
    if (want === on) return
    on = want
    el.classList.toggle('is-on', on)
    document.documentElement.classList.toggle('is-rotate', on)
    if (on) {
      holdScene('rotate')
      // only the layers the card hides; the skip link and #track stay reachable
      holdInert('rotate', ['chrome', 'stages', 'loader'].map(id => document.getElementById(id)))
      // focus stranded in a now-inert layer (or on <body>) comes to the card;
      // a reader already in the copy layer or on the skip link stays put
      const a = document.activeElement
      const keep = a instanceof HTMLElement && a !== document.body && (a.closest('#track') || a.matches('.skip-link'))
      if (!keep) el.focus({ preventScroll: true })
      // a live region only speaks when its text changes after it is shown
      requestAnimationFrame(() => {
        if (on) live.textContent = 'Turn your phone upright. Hark Glass is framed for portrait.'
      })
    } else {
      releaseInert('rotate')
      releaseScene('rotate')
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }

  go.addEventListener('click', () => {
    const hadFocus = el.contains(document.activeElement)
    dismissed = true
    rememberDismissed()
    el.classList.add('is-dismissed')
    sync()
    if (!hadFocus) return
    // the card is gone: hand focus to the story, like the skip link does
    const main = document.getElementById('track')
    if (main && !main.closest('[inert], [aria-hidden="true"]')) main.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur?.()
  })

  mq.addEventListener?.('change', sync)
  gate = { el, mq, sync, listeners, on: () => on }
  sync()
}

/** The plain HTML fallback reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.el.remove()
  document.documentElement.classList.remove('is-rotate')
  releaseInert('rotate')
  releaseScene('rotate')
  gate = null
}
