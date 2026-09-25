import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights; `landing` is where nav jumps land (local progress, on settled
 * copy — keep it clear of the ~6% cut window at each end). Each chapter lives
 * in src/chapters/<id>/ and default-exports a factory returning a Chapter.
 *
 * THEME: rename the labels to fit the concept (Orbit "Signal/Orbit/…",
 * Press "Proof/Paste-up/…", Arcade "Title Screen/Arcade Hall/…"). The ids are
 * shared with src/core/srContent.ts and the chrome's business names.
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Lens', length: 2.6, landing: 0, intro: 0.8, load: () => import('./hero/index') },
  { id: 'work', label: 'Vitrine', length: 3.8, landing: 0.12, intro: 0.065, transmission: 1, load: () => import('./work/index') },
  { id: 'services', label: 'Facets', length: 3.8, landing: 0.08, intro: 0.065, load: () => import('./services/index') },
  { id: 'voices', label: 'Reflections', length: 3.0, landing: 0.08, intro: 0.07, load: () => import('./voices/index') },
  { id: 'shield', label: 'Tempered', length: 2.1, landing: 0.45, intro: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'Refraction', length: 2.2, landing: 0.17, intro: 0.12, load: () => import('./process/index') },
  { id: 'contact', label: 'Clear', length: 1.5, landing: 0.3, intro: 0.3, load: () => import('./contact/index') },
]
