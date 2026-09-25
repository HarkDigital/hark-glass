import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'
import { CHAPTERS } from '../chapters/index'

/*
 * Hark Glass sound: a glass harmonica in a quiet studio (WebAudio, no files).
 *
 *   pad      a soft, sustained chord of pure sines (each voice a detuned pair,
 *            like a wet finger on a spinning glass bowl), low-passed, each
 *            voice breathing on its own slow swell. Two banks crossfade when
 *            the chord changes, so a new chapter "rings in" over ~2 s.
 *   bells    now and then a glass bell: inharmonic partials (1, 2.76, 5.40,
 *            8.93) with a fast attack and a long decay, a whisper of strike
 *            noise, pentatonic, panned a little, into a soft glass room.
 *   modes    every chapter has its own key and colour:
 *              hero      Lens         D, open and bright
 *              work      Vitrine      A, calm gallery
 *              services  Facets       E, brighter, busier sparkle
 *              voices    Reflections  F major 7, warmer and lower, slower bells
 *              shield    Tempered     tense (quartal + b9, minor bells) that
 *                                     RESOLVES to D major as the chapter settles
 *              process   Refraction   G, steady
 *              contact   Clear        C, high and clear
 *   cut()    a soft glass swell: filtered noise sweeping up, then a chime in
 *            the new chapter's key
 *   blip()   a tiny glass tick (nav, buttons), pitched up the pentatonic scale
 *   tone()   a pure sine a chapter may ask for (also via 'hark:tone' events)
 *   meter()  four band levels for the chrome's sound bars
 *
 * Off by default. Sound only ever starts from a user gesture: the toggle's
 * own click / tap / Enter / Space. A remembered "on" (localStorage) waits for
 * the first real activation (a click or tap, or Enter / Space on a control;
 * never Tab, Shift, arrows or scrolling). Faded out and suspended while the
 * tab is hidden. On iOS the session is switched to "playback" so the silent
 * switch doesn't swallow it. Everything is kept low: the master sits well
 * under full scale and a gentle compressor glues it.
 */

export const STORE_KEY = 'hark-glass:audio'

/** The remembered choice: true (on), false (off), or null when never set. */
export function storedAudio(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'
const MASTER_LEVEL = 0.9
const TONE_MAX = 0.05
const PARTIALS = [1, 2.76, 5.4, 8.93]
const PARTIAL_GAIN = [1, 0.42, 0.2, 0.09]
const PARTIAL_DECAY = [1, 0.62, 0.36, 0.2]

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

const MAJOR = [0, 2, 4, 7, 9]
const MINOR = [0, 3, 5, 7, 10]

interface Mode {
  /** MIDI root of the pad */
  root: number
  /** pad chord, semitones from root (four voices) */
  pad: number[]
  /** pentatonic scale for the bells */
  scale: number[]
  /** bells start this many semitones above the pad root */
  bellOct: number
  /** seconds between bells [min, max] */
  every: [number, number]
  /** pad low-pass cutoff (Hz) */
  cutoff: number
  /** pad level multiplier */
  level: number
}

const MODES: Record<string, Mode> = {
  hero: { root: 62, pad: [0, 7, 14, 16], scale: MAJOR, bellOct: 12, every: [3.2, 6.5], cutoff: 1500, level: 1 },
  work: { root: 57, pad: [0, 7, 14, 16], scale: MAJOR, bellOct: 24, every: [3.6, 7], cutoff: 1300, level: 0.95 },
  services: { root: 64, pad: [0, 7, 11, 14], scale: MAJOR, bellOct: 12, every: [2.2, 4.6], cutoff: 1800, level: 0.9 },
  voices: { root: 53, pad: [0, 7, 11, 16], scale: MAJOR, bellOct: 12, every: [4.6, 9], cutoff: 900, level: 1.15 },
  shield: { root: 62, pad: [0, 5, 10, 13], scale: MINOR, bellOct: 12, every: [4.5, 8.5], cutoff: 1100, level: 1 },
  process: { root: 55, pad: [0, 7, 14, 16], scale: MAJOR, bellOct: 24, every: [3, 6], cutoff: 1400, level: 1 },
  contact: { root: 60, pad: [0, 7, 14, 16], scale: MAJOR, bellOct: 24, every: [2.8, 5.5], cutoff: 2100, level: 0.9 },
}
/** Tempered, once it settles: the tension resolves to D major (add 9) */
const SHIELD_RESOLVED: Mode = { ...MODES.shield, pad: [0, 4, 7, 14], scale: MAJOR, every: [3, 6], cutoff: 1500 }

interface Bank {
  out: GainNode
  voices: { a: OscillatorNode; b: OscillatorNode }[]
}

function setAudioSession(type: 'playback' | 'auto') {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = type
  } catch {
    /* not supported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private dry!: GainNode
  private wet!: GainNode
  private padBus!: GainNode
  private padFilter!: BiquadFilterNode
  private banks: Bank[] = []
  private bankOn = 0
  private analyser!: AnalyserNode
  private bins = new Uint8Array(128)
  private noise!: AudioBuffer
  private toneOsc!: OscillatorNode
  private toneGain!: GainNode

  // story state
  private chapter = 'hero'
  private mode: Mode = MODES.hero
  private modeKey = ''
  private resolved = false
  private cutoff = 1500
  private lastFilterAt = 0

  private bellTimer = 0
  private nextBell = 0
  private lastDegree = -1
  private lastCut = 0
  private lastBlip = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" preference waiting for the first user gesture */
  private armed = false
  private gestureBound = false

  // requested pure tone (kept even while muted so it applies the moment sound starts)
  private toneHz = 440
  private toneLevel = 0

  constructor() {
    this.armed = storedAudio() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
  }

  /** was sound on last visit? (it still needs a gesture to start) */
  get remembered() {
    return storedAudio() === true
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    this.persist(this.enabled)
  }

  /** Follow the story: which chapter is playing, and where Tempered is in its arc. */
  update(frame: Frame, state: EngineState) {
    const slot = state.slots[state.index]
    if (!slot) return
    const id = slot.def.id
    if (id !== this.chapter) this.chapter = id
    // Tempered: hold the tension, then resolve once the chapter settles (with hysteresis)
    if (id === 'shield') {
      if (!this.resolved && state.local > 0.62) this.resolved = true
      else if (this.resolved && state.local < 0.5) this.resolved = false
    } else this.resolved = false
    const ctx = this.live()
    if (!ctx) return
    const key = id === 'shield' && this.resolved ? 'shield+' : id
    if (key !== this.modeKey) this.setMode(key, ctx)
    // moving through the story opens the glass a touch (brighter pad), then it settles
    const now = ctx.currentTime
    if (now - this.lastFilterAt > 0.12) {
      this.lastFilterAt = now
      const v = Math.min(2, Math.abs(frame.velocity || 0))
      const target = this.mode.cutoff * (1 + v * 0.35)
      if (Math.abs(target - this.cutoff) > 12) {
        this.cutoff = target
        this.padFilter.frequency.setTargetAtTime(target, now, 0.35)
      }
    }
  }

  /** The frosted pane sweeping across: a soft glass swell and a chime in the new key. */
  cut(_from: number, to: number) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastCut < 0.6) return
    this.lastCut = now
    // filtered noise swell
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.4
    bp.frequency.setValueAtTime(420, now)
    bp.frequency.exponentialRampToValueAtTime(2600, now + 0.7)
    bp.frequency.exponentialRampToValueAtTime(1400, now + 1.4)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.42)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.45)
    src.connect(bp).connect(g)
    g.connect(this.dry)
    const send = ctx.createGain()
    send.gain.value = 1.4
    g.connect(send).connect(this.wet)
    src.start(now)
    src.stop(now + 1.5)
    // the chime, in the key of the chapter we're arriving in
    const m = MODES[CHAPTERS[to]?.id ?? ''] ?? this.mode
    this.bell(ctx, now + 0.34, m.root + 24, 0.55, 2.6, 0.25)
    this.bell(ctx, now + 0.52, m.root + 31, 0.3, 2.2, -0.2)
  }

  /** A tiny glass tick (nav, buttons). `pitch` steps up the pentatonic scale. No-op while off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.06) return
    this.lastBlip = now
    const p = Math.max(0, Math.round(pitch))
    const deg = MAJOR[p % 5] + 12 * Math.floor(p / 5)
    this.bell(ctx, now, this.mode.root + 31 + deg, 0.32, 0.35, 0, 0.5)
  }

  /** A pure sine a chapter may ask for: level 0..1 (0 releases it). */
  tone(hz: number, level: number) {
    if (Number.isFinite(hz) && hz > 20 && hz < 12000) this.toneHz = hz
    this.toneLevel = clamp01(Number.isFinite(level) ? level : 0)
    this.applyTone()
  }

  /** Four band levels 0..1 (low → high) for a level meter; false while silent. */
  meter(out: number[]): boolean {
    const ctx = this.live()
    if (!ctx || !this.analyser) return false
    this.analyser.getByteFrequencyData(this.bins)
    const b = this.bins
    const band = (a: number, z: number) => {
      let m = 0
      for (let i = a; i <= z; i++) m = Math.max(m, b[i])
      return m / 255
    }
    out[0] = band(0, 2)
    out[1] = band(3, 5)
    out[2] = band(6, 14)
    out[3] = band(15, 45)
    return true
  }

  /* ------------------------------------------------------------ internals */

  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private persist(on: boolean) {
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) {
      try {
        this.ensureGraph()
      } catch (err) {
        console.warn('[hark] audio unavailable', err)
      }
    }
    this.applyRunning(true)
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, based on enabled/hidden. */
  private applyRunning(greet = false) {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    window.clearInterval(this.bellTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.6)
          this.modeKey = ''
          this.setMode(this.chapter === 'shield' && this.resolved ? 'shield+' : this.chapter, ctx)
          this.applyTone()
          if (greet) {
            // "on": three glass notes, rising
            const r = this.mode.root + this.mode.bellOct + 12
            this.bell(ctx, t + 0.05, r, 0.5, 2.2, -0.25)
            this.bell(ctx, t + 0.2, r + 7, 0.42, 2.2, 0.05)
            this.bell(ctx, t + 0.36, r + 14, 0.36, 2.6, 0.3)
            this.nextBell = t + 4
          } else this.nextBell = t + 1.2
          this.bellTimer = window.setInterval(this.tickBells, 200)
        })
        .catch(() => this.waitForGesture())
    } else {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.18)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1000,
      )
    }
  }

  /** Start audio on the first real gesture (remembered preference / blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    let sx = 0
    let sy = 0
    const events = ['click', 'keydown', 'touchstart', 'touchend'] as const
    const handler = (e: Event) => {
      if (e.type === 'touchstart') {
        const t = (e as TouchEvent).touches[0]
        if (t) {
          sx = t.clientX
          sy = t.clientY
        }
        return
      }
      if (e.type === 'touchend') {
        // a tap, not a scroll or a swipe
        const t = (e as TouchEvent).changedTouches[0]
        if (!t || Math.hypot(t.clientX - sx, t.clientY - sy) > 12) return
      }
      // keyboard: only Enter / Space aimed at a control counts as "play"; Tab,
      // Shift+Tab, arrows, PageDown and Space-to-scroll are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, { capture: true, passive: true })
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx

    // master -> high-pass -> gentle glue compression -> out (+ a meter tap)
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 60
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.01
    comp.release.value = 0.3
    this.master.connect(hp)
    hp.connect(comp)
    comp.connect(ctx.destination)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.8
    this.analyser.minDecibels = -84
    this.analyser.maxDecibels = -26
    comp.connect(this.analyser)

    // a soft glass room: a generated stereo impulse, dark and ~3 s long
    this.dry = ctx.createGain()
    this.dry.connect(this.master)
    const verb = ctx.createConvolver()
    verb.buffer = roomImpulse(ctx, 3.2)
    this.wet = ctx.createGain()
    this.wet.gain.value = 0.55
    this.wet.connect(verb)
    verb.connect(this.master)

    this.noise = noiseBuffer(ctx, 1.6)

    // pad: two banks of four voices, crossfaded on chord changes
    this.padFilter = ctx.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = this.cutoff
    this.padFilter.Q.value = 0.4
    this.padBus = ctx.createGain()
    this.padBus.gain.value = 0.9
    this.padBus.connect(this.padFilter)
    this.padFilter.connect(this.dry)
    const padSend = ctx.createGain()
    padSend.gain.value = 0.45
    this.padFilter.connect(padSend).connect(this.wet)

    const now = ctx.currentTime
    for (let b = 0; b < 2; b++) {
      const out = ctx.createGain()
      out.gain.value = 0
      out.connect(this.padBus)
      const voices: Bank['voices'] = []
      for (let v = 0; v < 4; v++) {
        const vg = ctx.createGain()
        const base = [0.026, 0.02, 0.016, 0.012][v]
        vg.gain.value = base
        // each voice breathes on its own slow swell
        const lfo = ctx.createOscillator()
        lfo.frequency.value = 0.05 + v * 0.023 + b * 0.011
        const depth = ctx.createGain()
        depth.gain.value = base * 0.55
        lfo.connect(depth).connect(vg.gain)
        lfo.start(now + v * 0.7)
        const a = ctx.createOscillator()
        const c = ctx.createOscillator()
        a.type = 'sine'
        c.type = 'sine'
        a.detune.value = -4
        c.detune.value = 5
        a.frequency.value = 220
        c.frequency.value = 220
        const mix = ctx.createGain()
        mix.gain.value = 0.5
        a.connect(mix)
        c.connect(mix)
        mix.connect(vg)
        vg.connect(out)
        a.start(now)
        c.start(now)
        voices.push({ a, b: c })
      }
      this.banks.push({ out, voices })
    }

    // requested pure tone
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain).connect(this.dry)
    this.toneOsc.start(now)
  }

  /** Load a chapter's chord into the idle bank and crossfade to it. */
  private setMode(key: string, ctx: AudioContext) {
    this.modeKey = key
    const m = key === 'shield+' ? SHIELD_RESOLVED : (MODES[key] ?? MODES.hero)
    this.mode = m
    if (!this.banks.length) return
    const now = ctx.currentTime
    const incoming = this.banks[1 - this.bankOn]
    const outgoing = this.banks[this.bankOn]
    this.bankOn = 1 - this.bankOn
    incoming.voices.forEach((v, i) => {
      const f = mtof(m.root + m.pad[i])
      // the idle bank is (nearly) silent: a short glide hides any retune
      for (const o of [v.a, v.b]) {
        o.frequency.cancelScheduledValues(now)
        o.frequency.setTargetAtTime(f, now, 0.04)
      }
    })
    incoming.out.gain.cancelScheduledValues(now)
    incoming.out.gain.setValueAtTime(incoming.out.gain.value, now)
    incoming.out.gain.setTargetAtTime(m.level, now + 0.08, 0.9)
    outgoing.out.gain.cancelScheduledValues(now)
    outgoing.out.gain.setValueAtTime(outgoing.out.gain.value, now)
    outgoing.out.gain.setTargetAtTime(0, now, 0.7)
    this.cutoff = m.cutoff
    this.padFilter.frequency.setTargetAtTime(m.cutoff, now, 0.8)
  }

  private tickBells = () => {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now < this.nextBell) return
    const m = this.mode
    const [lo, hi] = m.every
    this.nextBell = now + lo + Math.random() * (hi - lo)
    // a gentle melodic walk around the pentatonic scale (no big leaps)
    const n = m.scale.length * 2
    let d = this.lastDegree < 0 ? Math.floor(Math.random() * n) : this.lastDegree + Math.round((Math.random() - 0.5) * 4)
    d = Math.max(0, Math.min(n - 1, d))
    this.lastDegree = d
    const midi = m.root + m.bellOct + m.scale[d % m.scale.length] + 12 * Math.floor(d / m.scale.length)
    const vel = 0.45 + Math.random() * 0.4
    const pan = (Math.random() - 0.5) * 0.9
    this.bell(ctx, now + 0.02, midi, vel, 3.4, pan)
    // sometimes a second glass answers a third or a fifth above
    if (Math.random() < 0.28) {
      const up = m.scale[(d + 2) % m.scale.length] - m.scale[d % m.scale.length]
      this.bell(ctx, now + 0.34 + Math.random() * 0.2, midi + ((up + 12) % 12 || 7), vel * 0.6, 2.8, -pan * 0.6)
    }
  }

  /**
   * One glass bell: inharmonic partials with a fast attack and long decay, a
   * tiny bright strike, panned, half dry and half into the room.
   */
  private bell(ctx: AudioContext, t: number, midi: number, vel: number, decay: number, pan = 0, strike = 1) {
    const f0 = mtof(midi)
    const out = ctx.createGain()
    out.gain.value = 0.06 * vel
    let dest: AudioNode = out
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, pan))
      out.connect(p)
      dest = p
    }
    dest.connect(this.dry)
    const send = ctx.createGain()
    send.gain.value = 0.9
    dest.connect(send).connect(this.wet)
    // higher bells ring shorter
    const reg = Math.max(0.45, Math.min(1.2, 900 / f0))
    let end = t
    PARTIALS.forEach((r, i) => {
      const f = f0 * r
      if (f > 14000) return
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      o.detune.value = (Math.random() - 0.5) * 6
      const g = ctx.createGain()
      const d = Math.max(0.08, decay * PARTIAL_DECAY[i] * reg)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(PARTIAL_GAIN[i], t + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, t + d)
      o.connect(g).connect(out)
      o.start(t)
      o.stop(t + d + 0.05)
      end = Math.max(end, t + d + 0.05)
    })
    if (strike > 0) {
      const s = ctx.createBufferSource()
      s.buffer = this.noise
      const hp = ctx.createBiquadFilter()
      hp.type = 'bandpass'
      hp.frequency.value = Math.min(9000, f0 * 6)
      hp.Q.value = 2
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18 * strike, t + 0.002)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
      s.connect(hp).connect(g).connect(out)
      s.start(t, Math.random() * 1.2, 0.05)
    }
    // tidy up the little graph once it has rung out
    window.setTimeout(() => out.disconnect(), (end - ctx.currentTime + 0.3) * 1000)
  }

  private applyTone() {
    const ctx = this.ctx
    if (!ctx || !this.toneOsc) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.05)
    this.toneGain.gain.setTargetAtTime(this.enabled ? this.toneLevel * TONE_MAX : 0, now, 0.12)
  }
}

/* ----------------------------------------------------------------- buffers */

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}

/** A dark, smooth stereo room tail: decaying noise through a one-pole low-pass. */
function roomImpulse(ctx: AudioContext, seconds: number) {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, len, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / len
      // the tail darkens as it decays, like a real room
      const k = 0.55 - 0.4 * t
      lp += (Math.random() * 2 - 1 - lp) * k
      const pre = i < rate * 0.012 ? i / (rate * 0.012) : 1
      d[i] = lp * pre * Math.pow(1 - t, 2.6)
    }
  }
  return buf
}
