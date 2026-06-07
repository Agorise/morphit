<!--
	MorphitLogoBling — wraps the Morphit wordmark with three orbiting
	particles. The three are spring-coupled (so they always stay a
	visible distance apart) and slowly rotate about the wordmark centre,
	giving a soft organic drift rather than rigid clockwork circles.

	WHY THIS COMPONENT EXISTS (Part 122 cp115)

	The header logo had a subtle CSS hue-rotate on the wordmark itself,
	which Ken wanted upgraded to a more visible "always-on subtle motion"
	cue.  After surveying static SMIL options (orbiting circles on
	fixed ellipses) Ken specifically chose a non-deterministic feel:
	particles attract each other AND attract toward the logo center, so
	the visual is closer to a 3-body chaotic system than to a clockwork.

	IMPLEMENTATION

	Three Particle objects (mass = 1 each).  Each frame:
	  1. Pairwise SPRING force toward a fixed rest length, so every pair
	     settles a visible distance apart — the three can never collapse
	     onto each other into a single blob.
	  2. A gentle tangential push about the wordmark centre (rotation) so
	     the trio orbits slowly, plus a weak centripetal tether that keeps
	     the dance centred and bound to the logo.
	  3. Integrate velocity (semi-implicit Euler) with light damping and a
	     speed cap so the system stays slow and never explodes.
	  4. Clamp / soft-bounce position at the bling-box bounds so a particle
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
	(#00DA69), teal (#02A6B2).  Three is deliberate — one dot per
	gradient stop.  Two would read as a pair; four would smear into
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
		/** Responsive height via Tailwind classes (e.g. "h-11 sm:h-16 lg:h-24").
		 *  When set, this WINS over heightPx — the wordmark + canvas size from
		 *  these classes instead of the inline pixel height, so the logo can
		 *  scale across breakpoints (used by the homepage hero). The canvas
		 *  measures its rendered box on mount, so the particles adapt. */
		heightClass?: string;
		/** Extra classes for the wrapping <a>-targetable container. */
		class?: string;
	}

	const {
		wordmarkSrc = '/brand/morphit-wordmark.svg',
		heightPx = 28,
		heightClass = '',
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

	// Tunables — a slow, BOUNDED dance of three mutually-sprung dots that
	// also orbit the wordmark centre. The earlier build used pure mutual
	// gravity, but under damping the three masses collapse onto their common
	// centre and overlap into a single visible blob (which is why only one
	// dot appeared to fly around). A spring with a fixed rest length keeps
	// the three a visible distance apart at all times, while a gentle
	// rotation keeps them perpetually "flying around". (Eyeball-tuned knobs
	// — adjustable to taste.)
	//
	//   SPRING_K: pairwise spring stiffness. Each dot is pulled toward / pushed
	//     away from the others so every pair settles near `sep` apart — this is
	//     what guarantees all three stay separated and never merge.
	//   ROT_K: a small tangential (perpendicular-to-radius) push about the
	//     centroid. Spins the trio so the dots orbit slowly instead of freezing
	//     into a static triangle — the "flying around" motion.
	//   CENTROID_PULL: a weak tether toward the wordmark centre; the centripetal
	//     pull that keeps the rotating trio roughly centred and bound.
	//   JITTER: a tiny per-frame perturbation — keeps the motion organic (off
	//     any clean periodic orbit) and tops up the energy DAMPING bleeds.
	//   DAMPING: light per-frame velocity bleed so the dance can't accelerate
	//     without bound.
	//   MIN_DIST: softening floor for the spring direction — a near-collision
	//     still resolves to a finite push, never a divide-by-zero.
	//   MAX_VELOCITY: speed cap — keeps the whole dance slow and calm.
	//   EDGE_PAD: soft margin so the dots use nearly the full box and bounce
	//     back in rather than escaping.
	// `sep` (the spring rest length) is computed from the box height in
	// initParticles so the spacing scales with the logo size.
	const SPRING_K = 0.004;
	const ROT_K = 0.0013;
	const CENTROID_PULL = 0.0012;
	const JITTER = 0.018;
	const DAMPING = 0.99;
	const MIN_DIST = 10;
	const MAX_VELOCITY = 0.5;
	const EDGE_PAD = 0.04;
	let sep = 0;

	function initParticles(boxW: number, boxH: number): void {
		PARTICLES.length = 0;
		// Spring rest length — scales with the logo height so the three dots
		// stay proportionally separated at any size (header 32px → hero ~96px).
		sep = boxH * 0.9;
		const stops = ['#8EEF26', '#00DA69', '#02A6B2'];
		const r = Math.max(1.8, boxH * 0.085);
		// Deterministic but deliberately ASYMMETRIC starting state —
		// uneven positions spread across the width and uneven velocities, so
		// the spring-coupled trio starts mid-motion (already drifting and
		// rotating) rather than snapping out from a tidy symmetric triangle.
		// This is also exactly what gets drawn in reduced-motion mode (no
		// RAF): three dots at rest, visibly spread across the wordmark.
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
			// Pairwise SPRING toward a fixed rest length `sep`: pulls a pair
			// together when they drift past `sep`, pushes them apart when they
			// close inside `sep`. This is what keeps all three dots a visible
			// distance apart — they can never collapse into a single blob.
			for (let j = 0; j < PARTICLES.length; j++) {
				if (j === i) continue;
				const q = PARTICLES[j]!;
				const dx = q.x - p.x;
				const dy = q.y - p.y;
				const distSq = Math.max(dx * dx + dy * dy, MIN_DIST * MIN_DIST);
				const dist = Math.sqrt(distSq);
				const f = SPRING_K * (dist - sep);
				fx += (dx / dist) * f;
				fy += (dy / dist) * f;
			}
			// Gentle ROTATION about the centroid (tangential to the radius) so
			// the trio orbits slowly instead of settling into a static triangle
			// — this is the perpetual "flying around" motion.
			fx += -(p.y - cy) * ROT_K;
			fy += (p.x - cx) * ROT_K;
			// Weak tether toward the wordmark centre — the centripetal pull
			// that keeps the rotating trio roughly centred in the box.
			fx += (cx - p.x) * CENTROID_PULL;
			fy += (cy - p.y) * CENTROID_PULL;
			// Tiny perturbation — keeps the motion organic (off any clean
			// periodic orbit) and tops up the energy DAMPING bleeds.
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
	class={`morphit-logo-bling-host ${heightClass} ${cls}`}
	style={heightClass ? '' : `height: ${heightPx}px;`}
>
	<canvas
		bind:this={canvasEl}
		class="morphit-logo-bling-canvas"
		aria-hidden="true"
	></canvas>
	<img
		src={wordmarkSrc}
		alt="Morphit"
		class={`morphit-logo-bling-wordmark ${heightClass}`}
		style={heightClass ? '' : `height: ${heightPx}px;`}
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
