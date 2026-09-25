import { BRAND, CONTACT } from '../content'
import { CHAPTER_COPY_IDS, buildChapterCopy } from '../core/srContent'
import { CHAPTERS } from '../chapters/index'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'

/*
 * Plain HTML version for browsers without WebGL2 (and the last resort if
 * boot fails): every chapter's copy, in story order, visible, as a quiet
 * typographic page made of the same frosted glass as the live site. A dark
 * studio backdrop with soft pools of light (pure CSS), the brand and the
 * primary nav in glass capsules, and one frosted card per chapter. Same copy
 * as the live site, verbatim, from srContent (buildChapterCopy). Styled by
 * the .fb-* rules in ui.css.
 *
 * Landmarks: the banner <header> sits just before <main id="track">, so
 * "Skip to content" (#track) lands on the story itself, past the navigation.
 */

const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const pad = (n: number) => String(n).padStart(2, '0')

export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  unmountRotateGate()
  // boot can fail while the loader still holds the page inert: let go of it
  releaseInert('loader')
  releaseInert('menu')
  document.getElementById('loader')?.remove()
  root.style.pointerEvents = 'auto'

  // the studio backdrop (decorative) and the banner, around <main>
  document.querySelector('.fb-bg')?.remove()
  document.getElementById('fb-head')?.remove()
  const bg = document.createElement('div')
  bg.className = 'fb-bg'
  bg.setAttribute('aria-hidden', 'true')
  bg.innerHTML = '<i></i><i></i><i></i>'
  document.body.prepend(bg)

  const header = document.createElement('header')
  header.className = 'fb-head'
  header.id = 'fb-head'
  header.innerHTML = `
    <a class="fb-brand fb-glass" href="#hero" aria-label="${BRAND.name}, top of page">
      <span class="fb-lens" aria-hidden="true">${markSvg('fb-mark', { glass: true })}</span>
      <span class="fb-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>
    </a>
    <nav class="fb-nav fb-glass" aria-label="Primary">
      <a class="fb-link" href="#work">Work</a>
      <a class="fb-link" href="#services">Services</a>
      <a class="fb-link" href="#contact">Contact</a>
      <a class="hud-btn fb-cta" href="${CONTACT.href}">Start a project</a>
    </nav>`
  root.parentNode?.insertBefore(header, root)

  root.innerHTML = ''
  root.classList.add('fb')
  const order = CHAPTERS.map(c => c.id).filter(id => CHAPTER_COPY_IDS.includes(id))
  for (const id of CHAPTER_COPY_IDS) if (!order.includes(id)) order.push(id)
  order.forEach((id, i) => {
    const copy = buildChapterCopy(id, true)
    // heading Tab stops only drive the live story
    copy?.querySelectorAll('h1[tabindex], h2[tabindex]').forEach(h => h.removeAttribute('tabindex'))
    if (!copy) return
    // item "stops" only steer the live story; here they're just headings
    copy.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]:not([data-land])').forEach(a => {
      const span = document.createElement('span')
      span.textContent = a.textContent
      a.replaceWith(span)
    })
    const label = CHAPTERS.find(c => c.id === id)?.label ?? ''
    const sec = document.createElement('section')
    sec.className = `fb-sec fb-sec--${id}`
    sec.id = id
    const heading = copy.querySelector<HTMLElement>('h1, h2')
    if (heading) {
      heading.id = `fb-${id}-title`
      sec.setAttribute('aria-labelledby', heading.id)
    }
    const kicker = document.createElement('p')
    kicker.className = 'fb-k'
    kicker.setAttribute('aria-hidden', 'true')
    kicker.innerHTML = `<span class="fb-k-n">${pad(i + 1)}</span><span class="fb-k-l">${label}</span><span class="fb-k-b">${BUSINESS[id] ?? ''}</span>`
    const card = document.createElement('div')
    card.className = id === 'hero' ? 'fb-hero' : 'fb-card'
    card.appendChild(copy)
    sec.append(kicker, card)
    root.appendChild(sec)
  })
}
