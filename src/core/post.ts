import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * Post-processing for Hark Glass: Render → Sanitize (NaN guard) → Bloom →
 * Output → FINAL.
 *
 * The FINAL pass is a clean lens: faint radial chromatic aberration, a soft
 * vignette, fine grain, flash and fade, plus two glass effects:
 *
 *  - FROST (params.frost 0..1): the whole frame seen through frosted glass —
 *    a grainy spiral blur with a pale sheen. Chapters use it for depth moments.
 *  - THE PANE (the chapter cut): a vast sheet of frosted glass sweeps across
 *    the screen on a shallow diagonal. Its leading edge is a thick bevel that
 *    bends the image and splits it into colour; behind it, everything is
 *    frosted. At the boundary (uTransition = 1) the pane covers the whole
 *    frame, frosted deepest, which hides the swap; after it, the pane carries
 *    on and leaves by the far edge (uCutSide tells the shader which half of
 *    the sweep it is in).
 *
 * Keep the Post API (params / resetParams / setSize / render / compileAsync /
 * setFadeTone / cutSide) and the uTransition / uFade / uFlash / uGlitch
 * uniforms — the engine drives them.
 */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** 0..1, peaks exactly at a chapter boundary (engine-driven) */
    uTransition: { value: 0 },
    /** -1 approaching the boundary, +1 leaving it */
    uCutSide: { value: 1 },
    /** 0..1 heat-shimmer refraction a chapter can add */
    uGlitch: { value: 0 },
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.022 },
    uVignette: { value: 0.28 },
    /** 0..1 wash to white */
    uFlash: { value: 0 },
    /** 0..1 fade to uFadeColor (reduced-motion cuts) */
    uFade: { value: 0 },
    /** 0..1 whole-frame frosted glass */
    uFrost: { value: 0 },
    /** the pane's glass tint */
    uTint: { value: new THREE.Color('#dff7ee') },
    uFadeColor: { value: new THREE.Color('#0b1017') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDpr, uTransition, uCutSide, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade, uFrost;
    uniform vec2 uResolution;
    uniform vec3 uTint, uFadeColor;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

    // grainy spiral blur: frosted glass scatters, so per-pixel jitter is the look
    vec3 frosted(vec2 uv, float radiusPx) {
      vec2 px = 1.0 / uResolution;
      float a0 = hash(gl_FragCoord.xy) * 6.2831853;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 14; i++) {
        float fi = float(i);
        float r = sqrt((fi + 0.5) / 14.0) * radiusPx;
        float a = a0 + fi * 2.3999632;
        acc += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * r * px).rgb;
      }
      return acc / 14.0;
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 c = uv - 0.5;

      // heat shimmer (chapters: e.g. the breach in 'Tempered')
      float g = clamp(uGlitch, 0.0, 1.0);
      uv += g * 0.006 * vec2(sin(uv.y * 38.0 + uTime * 5.0), cos(uv.x * 31.0 - uTime * 4.0));

      // lens: faint radial chromatic aberration
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * uAberration).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * uAberration).b;

      float blurPx = 26.0 * uDpr;

      // ---- THE PANE (chapter cut)
      float paneIn = 0.0;
      float t = clamp(uTransition, 0.0, 1.0);
      if (t > 0.001) {
        vec2 dir = normalize(vec2(1.0, 0.32));
        vec2 pa = vec2(c.x * aspect, c.y);
        float span = 0.5 * (aspect * abs(dir.x) + abs(dir.y));
        float u = (dot(pa, dir) + span) / (2.0 * span);          // 0 at the first corner, 1 at the last
        float ease = t * t * (3.0 - 2.0 * t);
        float s = uCutSide < 0.0 ? 0.5 * ease : 1.0 - 0.5 * ease;   // 0 → 0.5 at the boundary → 1
        float lead = s * 2.0 + 0.04;
        float trail = s * 2.0 - 1.04;
        float bevel = 0.05;
        float inside = step(trail, u) * step(u, lead);
        paneIn = inside;
        if (inside > 0.5) {
          // distance to the nearest edge (in sweep units) → bevel profile
          float dLead = lead - u;
          float dTrail = u - trail;
          float dEdge = min(dLead, dTrail);
          float bev = 1.0 - smoothstep(0.0, bevel, dEdge);       // 1 at the edge, 0 in the body
          float sgn = dLead < dTrail ? 1.0 : -1.0;
          // the bevel bends the image along the sweep and splits colour
          vec2 bend = vec2(dir.x / aspect, dir.y) * sgn * bev * bev * 0.06;
          vec2 body = vec2(dir.x / aspect, dir.y) * 0.012;       // the slab's own offset
          vec2 suv = uv + body + bend;
          float depth = mix(0.55, 1.0, t);                        // frost deepens toward the boundary
          vec3 f = frosted(suv, blurPx * depth);
          vec3 disp = vec3(
            texture2D(tDiffuse, suv + bend * 0.9).r,
            texture2D(tDiffuse, suv).g,
            texture2D(tDiffuse, suv - bend * 0.9).b
          );
          vec3 pane = mix(f, disp, bev * 0.85);
          // pale glass body, a soft diagonal sheen, a crisp highlight on each edge
          float sheen = 0.5 + 0.5 * sin((u - s * 2.0) * 9.0);
          pane = mix(pane, uTint, 0.12 + 0.18 * t) + (0.025 + 0.05 * t) * sheen;
          pane += vec3(0.9, 1.0, 0.95) * exp(-dEdge * dEdge / 0.00002) * 0.55;
          pane += vec3(1.0) * exp(-(dEdge - 0.012) * (dEdge - 0.012) / 0.00006) * bev * 0.12;
          col = pane;
        }
      }

      // whole-frame frost — only where the pane isn't already frosting
      float fr = clamp(uFrost, 0.0, 1.0);
      if (fr > 0.002 && paneIn < 0.5) {
        vec3 f = frosted(uv, blurPx * fr * 1.4);
        f = mix(f, uTint, 0.1 * fr) + 0.03 * fr;
        col = mix(col, f, smoothstep(0.0, 0.35, fr));
      }

      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      float v = 1.0 - smoothstep(0.35, 1.05, length(c * vec2(1.0, 0.9)) * 1.4);
      col *= mix(1.0, 0.6 + 0.4 * v, uVignette);
      col += (hash(vUv * uResolution + fract(uTime * 7.13) * 91.0) - 0.5) * uGrain;
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  /** heat shimmer 0..1 */
  glitch: number
  /** white wash 0..1 */
  flash: number
  exposure: number
  /** whole-frame frosted glass 0..1 */
  frost: number
}

/** Bloom catches only HDR: studio reflections on glass, lit edges, emissive cores. */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.42,
  bloomRadius: 0.55,
  bloomThreshold: 0.92,
  aberration: 0.0012,
  grain: 0.022,
  vignette: 0.28,
  glitch: 0,
  flash: 0,
  exposure: 1,
  frost: 0,
}

/** minimum seconds between two white-flash onsets (WCAG 2.3.1) */
const FLASH_GAP = 0.4

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through bloom.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  /**
   * Chapters write targets here every frame (the engine resets them to
   * defaults first); values are damped so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  /** -1 while approaching a chapter boundary, +1 after it (engine-driven) */
  cutSide = 1
  fade = 0
  private lastFlashAt = -1e9
  private flashLive = false
  private flashOk = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    /** skip MSAA (retina / mobile: already supersampled; MSAA half-float targets are huge) */
    noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: noMsaa ? 0 : 4,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.composer.addPass(new RenderPass(scene, camera))
    this.composer.addPass(new ShaderPass(SanitizeShader))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.42, 0.55, 0.92)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  /** Colour the reduced-motion fade passes through. */
  setCutColor(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uFadeColor.value as THREE.Color).set(color)
  }

  /** Tint of the sweeping pane (defaults to a pale mint glass). */
  setPaneTint(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uTint.value as THREE.Color).set(color)
  }

  /** Engine hook (kept for compatibility). */
  setFadeTone(_tone: number) {}

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /**
   * Compile every post-processing shader in parallel so the first composer
   * render doesn't block on synchronous links.
   */
  compileAsync(): Promise<unknown> {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const b = this.bloom as unknown as Record<string, unknown>
    const mats: THREE.Material[] = []
    const add = (m: unknown) => {
      if (m && (m as THREE.Material).isMaterial) mats.push(m as THREE.Material)
    }
    for (const pass of this.composer.passes) add((pass as unknown as { material?: unknown }).material)
    for (const m of (b.separableBlurMaterials as unknown[]) ?? []) add(m)
    add(b.compositeMaterial)
    add(b.blendMaterial)
    add(b.materialHighPassFilter)
    add(b.copyMaterial)
    return Promise.all(mats.map(m => this.renderer.compileAsync(new THREE.Mesh(quad.geometry, m), cam).catch(() => {})))
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    // flash budget: a new flash that starts within FLASH_GAP of the last one
    // is dropped for its whole duration
    if (c.flash > 0.02) {
      if (!this.flashLive) {
        this.flashLive = true
        this.flashOk = time - this.lastFlashAt >= FLASH_GAP
        if (this.flashOk) this.lastFlashAt = time
      }
      if (!this.flashOk) c.flash = 0
    } else this.flashLive = false
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uCutSide.value = this.cutSide
    u.uGlitch.value = c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFrost.value = c.frost
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
