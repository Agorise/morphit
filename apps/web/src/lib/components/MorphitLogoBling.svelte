<!--
	MorphitLogoBling — wraps the Morphit wordmark with three orbiting
	particles that drift under soft mutual + logo-centroid gravity, a
	"3-body problem" feel rather than rigid circles.

	WHY THIS COMPONENT EXISTS (Part 122 cp115)

	The header logo had a subtle CSS hue-rotate on the wordmark itself,
	which Ken wanted upgraded to a more visible "always-on subtle motion"
	cue.  After surveying static SMIL options (orbiting circles on
	fixed ellipses) Ken specifically chose a non-deterministic feel:
	particles attract each other AND attract toward the logo center, so
	the visual is closer to a 3-body chaotic system than to a clockwork.

	IMPLEMENTATION

	Three Particle objects (mass = 1 each).  Each frame:
	  1. Compute force on every particle from every other particle
	     (Newton's 1/r^2, softened with a min-distance to avoid
	     singularities).
	  2. Compute attraction toward the wordmark's center (a stronger
	     constant pull that keeps particles bound to the logo).
	  3. Integrate velocity (semi-implicit Euler) with light damping
	     so the system doesn't explode after a few seconds.
	  4. Clamp position to the bling-box bounds so a runaway particle
	     can't drift off screen.

	BUDGET DISCIPLINE (priorities #4 + #3)

	  - One <canvas> at 2x DPR.  Zero DOM thrash per frame.
	  - requestAnimationFrame loop.  Browser pauses RAF automatically
	    when the tab is inactive (free win).
	  - IntersectionObserver also pauses the RAF when the header is
	    scrolled out of viewport — saves CPU on long pages.
	  - `prefers-reduced-motion: reduce` => particles drawn at
	    deterministic resting positions, no RAF loop at all.  This
	    serves both vestibular-disorder accessibility AND grandma-
	    friendliness (no jittery motion on low-end devices).
	  - Caching is implicit: this component lives inside the Svelte
	    bundle.  Vite fingerprints + emits `Cache-Control: public,
	    max-age=31536000, immutable` for hashed asset filenames.  No
	    extra network fetch after first paint, never re-downloaded
	    unless the component source changes.

	PARTICLE COLORS

	Match the brand gradient stops exactly: lime (#8EEF26), green
	(#00DA69), teal (#02A6B2).  Three is deliberate — it's the
	minimum N for the 3-body chaos visual.  Two particles would
	just orbit each other in stable ellipses; four would smear into
	an indistinct blur.

	ACCESSIBILITY

	  - aria-hidden="true" on the canvas (decorative; screen readers
	    skip it).
	  - The wordmark <img> retains its alt="Morphit" so screen-reader
	    output is unchanged from the previous header.
	  - prefers-reduced-motion honored as described above.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		/** Path to the wordmark SVG (defaults to bundled brand asset). */
		wordmarkSrc?: string;
		/** Display height of the wordmark in CSS pixels (matches Tailwind h-7 default). */
		heightPx?: number;
		/** Extra classes for the wrapping <a>-targetable container. */
		class?: string;
	}

	const {
		wordmarkSrc = '/brand/morphit-wordmark.svg',
		heightPx = 28,
		class: cls = ''
	}: Props = $props();

	// ────────────────────────────────────────────────────────────────
	// Canvas + RAF state
	// ────────────────────────────────────────────────────────────────

	let canvasEl: HTMLCanvasElement | null = $state(null);
	let containerEl: HTMLDivElement | null = $state(null);
	let rafId = 0;
	let visible = false;
	let reducedMotion = false;
	let io: IntersectionObserver | null = null;
	let mq: MediaQueryList | null = null;

	/** Each particle has position (px), velocity (px/frame),
	 *  and a color stop from the brand gradient. */
	interface Particle {
		x: number;
		y: number;
		vx: number;
		vy: number;
		color: string;
		radius: number;
	}

	const PARTICLES: Particle[] = [];

	// Tunables — a slow, BOUNDED three-body gravity dance. The famed
	// "three-body problem": three masses pulling on each other under
	// mutual gravity, whose motion is chaotic — never settling into tidy
	// repeating orbits. Tuned for the logo: gravity is the star of the
	// show, but the dance is confined to the wordmark box and kept calm.
	// (These are eyeball-tuned knobs — adjustable to taste.)
	//
	//   PARTICLE_PULL: mutual gravitational constant — each dot is pulled
	//     toward the other two (∝ 1/r²). They drift together, swing past,
	//     slingshot apart, get pulled back. This is the three-body core.
	//   CENTROID_PULL: a WEAK tether toward the wordmark centre — just
	//     enough to keep the dance roughly centred (and stop a dot being
	//     ejected for good) WITHOUT overpowering the mutual gravity. A
	//     strong well would turn the chaos into regular harmonic orbits.
	//   JITTER: a tiny per-frame perturbation. Two jobs — it keeps the
	//     system off any periodic orbit, and it replaces the sliver of
	//     energy DAMPING bleeds so the dots never spiral into a still
	//     cluster over a long session.
	//   DAMPING: light per-frame velocity bleed so close-encounter
	//     slingshots can't accelerate without bound.
	//   MIN_DIST: softening floor for the 1/r² force — a near-collision
	//     gives a gentle slingshot, not an infinite fling.
	//   MAX_VELOCITY: speed cap — keeps the whole dance slow (the earlier
	//     version felt too fast).
	//   EDGE_PAD: soft margin so the dots use nearly the full box and
	//     bounce back in rather than escaping.
	const PARTICLE_PULL = 6.0;
	const CENTROID_PULL = 0.0003;
	const JITTER = 0.008;
	const DAMPING = 0.99;
	const MIN_DIST = 10;
	const MAX_VELOCITY = 0.4;
	const EDGE_PAD = 0.04;

	function initParticles(boxW: number, boxH: number): void {
		PARTICLES.length = 0;
		const stops = ['#8EEF26', '#00DA69', '#02A6B2'];
		const r = Math.max(1.8, boxH * 0.085);
		// Deterministic but deliberately ASYMMETRIC starting state —
		// uneven positions spread across the width, and uneven velocities
		// that DON'T point at the common centre (so the system carries
		// angular momentum and the dots swing past each other instead of
		// collapsing radially). The asymmetry is what tips the mutual-
		// gravity system into chaos rather than the tidy symmetric
		// "choreography" orbit the old equilateral-triangle start produced
		// (which is why the dots looked like they were just circling). It
		// also spreads them across the wordmark on the first frame, and is
		// exactly what gets drawn in reduced-motion mode (no RAF).
		const seeds = [
			{ fx: 0.2, fy: 0.38, vx: 0.05, vy: 0.1 },
			{ fx: 0.56, fy: 0.62, vx: -0.08, vy: 0.04 },
			{ fx: 0.85, fy: 0.46, vx: 0.03, vy: -0.09 }
		];
		for (let i = 0; i < 3; i++) {
			const s = seeds[i]!;
			PARTICLES.push({
				x: boxW * s.fx,
				y: boxH * s.fy,
				vx: s.vx,
				vy: s.vy,
				color: stops[i] as string,
				radius: r
			});
		}
	}

	function step(boxW: number, boxH: number): void {
		const cx = boxW / 2;
		const cy = boxH / 2;
		const padX = boxW * EDGE_PAD;
		const padY = boxH * EDGE_PAD;
		// Forces (O(n²) — only 3 dots, so 9 iterations).
		for (let i = 0; i < PARTICLES.length; i++) {
			const p = PARTICLES[i]!;
			let fx = 0;
			let fy = 0;
			// Mutual gravitational ATTRACTION (the three-body core): each
			// dot is pulled toward the other two, ∝ 1/r² (softened by
			// MIN_DIST). Close approaches slingshot; this is what makes
			// the motion chaotic rather than a fixed loop.
			for (let j = 0; j < PARTICLES.length; j++) {
				if (j === i) continue;
				const q = PARTICLES[j]!;
				const dx = q.x - p.x;
				const dy = q.y - p.y;
				const distSq = Math.max(dx * dx + dy * dy, MIN_DIST * MIN_DIST);
				const force = PARTICLE_PULL / distSq;
				fx += dx * force;
				fy += dy * force;
			}
			// Weak tether toward the wordmark centre — keeps the dance
			// bound to the box without overpowering the mutual gravity.
			fx += (cx - p.x) * CENTROID_PULL;
			fy += (cy - p.y) * CENTROID_PULL;
			// Tiny perturbation (keeps it off any periodic orbit and
			// replaces the energy DAMPING bleeds, so it never collapses).
			fx += (Math.random() - 0.5) * JITTER;
			fy += (Math.random() - 0.5) * JITTER;
			// Integrate (semi-implicit Euler) with light damping.
			p.vx = (p.vx + fx) * DAMPING;
			p.vy = (p.vy + fy) * DAMPING;
			// Speed cap so slingshots stay slow.
			const vmag = Math.hypot(p.vx, p.vy);
			if (vmag > MAX_VELOCITY) {
				p.vx = (p.vx / vmag) * MAX_VELOCITY;
				p.vy = (p.vy / vmag) * MAX_VELOCITY;
			}
			p.x += p.vx;
			p.y += p.vy;
			// Soft-bounce off the box edges (with a margin) so a dot flung
			// outward by a close encounter is re-injected into the dance
			// rather than escaping — they use nearly the full box.
			if (p.x < padX + p.radius) {
				p.x = padX + p.radius;
				p.vx = Math.abs(p.vx) * 0.7;
			} else if (p.x > boxW - padX - p.radius) {
				p.x = boxW - padX - p.radius;
				p.vx = -Math.abs(p.vx) * 0.7;
			}
			if (p.y < padY + p.radius) {
				p.y = padY + p.radius;
				p.vy = Math.abs(p.vy) * 0.7;
			} else if (p.y > boxH - padY - p.radius) {
				p.y = boxH - padY - p.radius;
				p.vy = -Math.abs(p.vy) * 0.7;
			}
		}
	}

	function draw(ctx: CanvasRenderingContext2D, boxW: number, boxH: number, dpr: number): void {
		ctx.clearRect(0, 0, boxW * dpr, boxH * dpr);
		for (const p of PARTICLES) {
			ctx.beginPath();
			ctx.arc(p.x * dpr, p.y * dpr, p.radius * dpr, 0, Math.PI * 2);
			ctx.fillStyle = p.color;
			ctx.fill();
		}
	}

	function startLoop(): void {
		if (rafId !== 0) return; // Already running.
		if (!canvasEl || !containerEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const boxW = containerEl.clientWidth;
		const boxH = containerEl.clientHeight;
		if (boxW === 0 || boxH === 0) return;
		canvasEl.width = boxW * dpr;
		canvasEl.height = boxH * dpr;
		canvasEl.style.width = `${boxW}px`;
		canvasEl.style.height = `${boxH}px`;
		if (PARTICLES.length === 0) initParticles(boxW, boxH);
		const tick = (): void => {
			step(boxW, boxH);
			draw(ctx, boxW, boxH, dpr);
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
	}

	function stopLoop(): void {
		if (rafId !== 0) {
			cancelAnimationFrame(rafId);
			rafId = 0;
		}
	}

	function drawStaticFallback(): void {
		// Reduced-motion mode: draw the three particles at their
		// deterministic starting positions and don't animate.  Gives the
		// header a static decorative flourish without any motion.
		if (!canvasEl || !containerEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const boxW = containerEl.clientWidth;
		const boxH = containerEl.clientHeight;
		canvasEl.width = boxW * dpr;
		canvasEl.height = boxH * dpr;
		canvasEl.style.width = `${boxW}px`;
		canvasEl.style.height = `${boxH}px`;
		initParticles(boxW, boxH);
		draw(ctx, boxW, boxH, dpr);
	}

	onMount(() => {
		if (typeof window === 'undefined') return;
		mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		const onMqChange = (): void => {
			reducedMotion = mq!.matches;
			if (reducedMotion) {
				stopLoop();
				drawStaticFallback();
			} else if (visible) {
				startLoop();
			}
		};
		mq.addEventListener('change', onMqChange);

		if (reducedMotion) {
			drawStaticFallback();
		} else if (containerEl) {
			io = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						visible = entry.isIntersecting;
						if (visible && !reducedMotion) startLoop();
						else stopLoop();
					}
				},
				{ threshold: 0.01 }
			);
			io.observe(containerEl);
		}

		return () => {
			mq?.removeEventListener('change', onMqChange);
		};
	});

	onDestroy(() => {
		stopLoop();
		io?.disconnect();
	});
</script>

<div
	bind:this={containerEl}
	class={`morphit-logo-bling-host ${cls}`}
	style="height: {heightPx}px;"
>
	<canvas
		bind:this={canvasEl}
		class="morphit-logo-bling-canvas"
		aria-hidden="true"
	></canvas>
	<img
		src={wordmarkSrc}
		alt="Morphit"
		class="morphit-logo-bling-wordmark"
		style="height: {heightPx}px;"
		decoding="async"
	/>
</div>

<style>
	.morphit-logo-bling-host {
		position: relative;
		display: inline-block;
		line-height: 0;
		/* The canvas overflows slightly outside the wordmark bounds so
		 * particles near the edges aren't clipped.  Hidden by parent's
		 * overflow rules; pointer-events: none on the canvas means
		 * mouse hits still reach the wordmark <img>. */
	}
	.morphit-logo-bling-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		/* Stack the particles BEHIND the wordmark so they appear as a
		 * subtle backdrop sparkle rather than overlay-clutter on the
		 * letterforms.  z-index: 0 on canvas + z-index: 1 on wordmark. */
		z-index: 0;
	}
	.morphit-logo-bling-wordmark {
		position: relative;
		display: block;
		width: auto;
		z-index: 1;
	}
</style>
