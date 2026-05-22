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

	// Tunables — physical constants for the 3-body simulation.
	//
	//   PARTICLE_PULL: gravitational constant between particles.  Too
	//     low → particles drift apart and clamp on bounds; too high →
	//     they collapse into a single point.  This value was hand-
	//     tuned to give visible 3-body chaos without runaway.
	//   CENTROID_PULL: how strongly particles fall toward the
	//     wordmark's geometric center.  Acts as a soft potential well
	//     that keeps the system bound near the logo.
	//   DAMPING: per-frame velocity multiplier <1 to prevent energy
	//     accumulation over long sessions.  0.998 lets the chaotic
	//     dance continue indefinitely; <0.99 visibly slows the system.
	//   MIN_DIST: minimum inter-particle distance for force calc, in
	//     px.  Avoids 1/r^2 singularity when two particles overlap.
	//   MAX_VELOCITY: hard cap so a chance close encounter doesn't
	//     fling a particle off-canvas before damping catches up.
	const PARTICLE_PULL = 0.08;
	const CENTROID_PULL = 0.0012;
	const DAMPING = 0.998;
	const MIN_DIST = 6;
	const MAX_VELOCITY = 0.9;

	function initParticles(boxW: number, boxH: number): void {
		PARTICLES.length = 0;
		const cx = boxW / 2;
		const cy = boxH / 2;
		// Place the three particles in a triangle around the centroid
		// with a small tangential kick each, so the initial state has
		// non-zero angular momentum — the system starts moving.
		const radius = Math.min(boxW, boxH) * 0.35;
		const stops = ['#8EEF26', '#00DA69', '#02A6B2'];
		for (let i = 0; i < 3; i++) {
			const angle = (i / 3) * Math.PI * 2;
			PARTICLES.push({
				x: cx + Math.cos(angle) * radius,
				y: cy + Math.sin(angle) * radius * 0.5, // squashed orbits look better on a wide wordmark
				vx: -Math.sin(angle) * 0.4,
				vy: Math.cos(angle) * 0.2,
				color: stops[i] as string,
				radius: 2.2
			});
		}
	}

	function step(boxW: number, boxH: number): void {
		const cx = boxW / 2;
		const cy = boxH / 2;
		// Compute forces (O(n²) — only 3 particles, so 9 iterations).
		for (let i = 0; i < PARTICLES.length; i++) {
			const p = PARTICLES[i]!;
			let fx = 0;
			let fy = 0;
			// Mutual particle attraction.
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
			// Centroid pull (always toward the wordmark's center).
			fx += (cx - p.x) * CENTROID_PULL;
			fy += (cy - p.y) * CENTROID_PULL;
			// Integrate.
			p.vx = (p.vx + fx) * DAMPING;
			p.vy = (p.vy + fy) * DAMPING;
			// Clamp velocity.
			const vmag = Math.hypot(p.vx, p.vy);
			if (vmag > MAX_VELOCITY) {
				p.vx = (p.vx / vmag) * MAX_VELOCITY;
				p.vy = (p.vy / vmag) * MAX_VELOCITY;
			}
			p.x += p.vx;
			p.y += p.vy;
			// Clamp to bounds with a tiny bounce so a particle near the
			// edge isn't pinned indefinitely.
			if (p.x < p.radius) {
				p.x = p.radius;
				p.vx = -p.vx * 0.6;
			} else if (p.x > boxW - p.radius) {
				p.x = boxW - p.radius;
				p.vx = -p.vx * 0.6;
			}
			if (p.y < p.radius) {
				p.y = p.radius;
				p.vy = -p.vy * 0.6;
			} else if (p.y > boxH - p.radius) {
				p.y = boxH - p.radius;
				p.vy = -p.vy * 0.6;
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
