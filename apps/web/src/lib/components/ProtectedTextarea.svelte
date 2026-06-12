<script lang="ts">
	/**
	 * ProtectedTextarea — textarea with inline highlighting of any
	 * detected private-key material in the user's input.
	 *
	 * Used by feedback / reply / chat compose flows to protect users
	 * from pasting a private key and sending it to a counterparty.
	 *
	 * UX layers:
	 *   1. Detection on input (150ms debounced) + on blur.
	 *   2. Matched substrings are wrapped in <mark> and rendered in
	 *      bright red so the user can SEE what's being flagged.
	 *   3. The parent is notified via onDetect(matches) — it shows
	 *      a warning modal the first time a match appears.
	 *   4. The parent is also responsible for calling
	 *      redactPrivateKeys() on the outgoing payload before
	 *      broadcast, so that even if the warning is dismissed
	 *      the truncated form is what actually ships.
	 *
	 * Rendering technique: a transparent-text textarea sits on top
	 * of a positioned backing div whose innerHTML mirrors the text
	 * with highlight spans. scrollTop/scrollLeft are mirrored so
	 * everything stays aligned as the user scrolls.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { detectPrivateKeys, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';

	interface Props {
		value: string;
		/** Called any time detection runs and the set of matches
		 *  changes. Empty array means "no matches found" (or
		 *  they've all been removed). Parent decides whether to
		 *  open the warning modal. */
		onDetect?: (matches: PrivateKeyMatch[]) => void;
		/** Key event passthrough. Used by the chat composer to
		 *  implement Enter-to-send / Shift+Enter-for-newline
		 *  without bypassing the private-key overlay. The parent
		 *  handler may call event.preventDefault() to suppress the
		 *  default textarea behavior. */
		onkeydown?: (event: KeyboardEvent) => void;
		placeholder?: string;
		rows?: number;
		/** Hard UTF-16 character ceiling. Enforced by the browser
		 *  — characters past this point cannot be typed. Use as a
		 *  defense-in-depth cap against enormous pastes. If you
		 *  want a codepoint-based soft limit for emoji-heavy user
		 *  text (256 codepoints of emoji can be up to 1024 UTF-16
		 *  units), set `counterLimit` to the codepoint cap and
		 *  this `maxlength` to a larger UTF-16 ceiling. */
		maxlength?: number;
		disabled?: boolean;
		ariaLabel?: string;
		/** Extra classes applied to the wrapping element. */
		class?: string;
		/** Show the inline character counter in the bottom-right of
		 *  the textarea. The counter is invisible below 75% of the
		 *  limit, fades in gently between 75-89%, turns amber at
		 *  90-99%, and red at/above 100%. Defaults to false so
		 *  existing call sites are unaffected. */
		showCounter?: boolean;
		/** How the counter computes "length":
		 *  - 'codepoint' counts emoji and combined characters as 1
		 *    each. Use this when the real limit is codepoint-based
		 *    (feedback, chat — matches the indexer's validation).
		 *  - 'utf16' uses `.length` directly. Use this when the
		 *    indexer validates `.length` (e.g. order terms). */
		counterMode?: 'codepoint' | 'utf16';
		/** The soft limit shown to the user. If omitted, defaults
		 *  to `maxlength`. When the user hits this limit the
		 *  counter turns red — it's the practical cap. Can differ
		 *  from `maxlength` when using codepoint counting with a
		 *  larger UTF-16 defense ceiling. */
		counterLimit?: number;
	}

	let {
		value = $bindable(''),
		onDetect,
		onkeydown,
		placeholder = '',
		rows = 3,
		maxlength,
		disabled = false,
		ariaLabel,
		class: cls = '',
		showCounter = false,
		counterMode = 'utf16',
		counterLimit
	}: Props = $props();

	let textareaEl: HTMLTextAreaElement;
	let overlayEl: HTMLDivElement;
	let matches = $state<PrivateKeyMatch[]>([]);

	// Previous match signature — so we only fire onDetect when the
	// match set actually changes, not on every keystroke.
	let prevSignature = '';

	let debounceHandle: ReturnType<typeof setTimeout> | null = null;

	function scan(): void {
		const next = detectPrivateKeys(value);
		matches = next;
		const sig = next.map((m) => `${m.start}-${m.end}:${m.kind}`).join('|');
		if (sig !== prevSignature) {
			prevSignature = sig;
			onDetect?.(next);
		}
	}

	function onInput(): void {
		if (debounceHandle) clearTimeout(debounceHandle);
		debounceHandle = setTimeout(scan, 150);
	}

	function onBlur(): void {
		// Flush any pending debounce so a user-hit-blur doesn't
		// race the scan.
		if (debounceHandle) clearTimeout(debounceHandle);
		scan();
	}

	function onScroll(): void {
		if (!overlayEl || !textareaEl) return;
		overlayEl.scrollTop = textareaEl.scrollTop;
		overlayEl.scrollLeft = textareaEl.scrollLeft;
	}

	onMount(() => {
		// Initial scan so a pre-populated textarea (e.g. edit flow)
		// gets checked on mount.
		scan();
	});

	// Part 74: clear pending debounce on unmount.  Without this,
	// a user who types and immediately navigates leaves a
	// setTimeout running that fires `scan()` against a stale
	// component state.  Svelte 5's reactive runtime tolerates the
	// stale write but it's a minor leak that's cheap to plug.
	onDestroy(() => {
		if (debounceHandle !== null) {
			clearTimeout(debounceHandle);
			debounceHandle = null;
		}
	});

	/** Build the overlay HTML: a flat string with <mark class="pk-match">
	 *  wraps around every match, with surrounding text html-escaped.
	 *  Newlines preserved via white-space: pre-wrap on the container. */
	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	const overlayHtml = $derived.by(() => {
		if (matches.length === 0) return escapeHtml(value);
		const parts: string[] = [];
		let cursor = 0;
		for (const m of matches) {
			parts.push(escapeHtml(value.slice(cursor, m.start)));
			parts.push(
				`<mark class="pk-match" data-kind="${m.kind}">${escapeHtml(
					value.slice(m.start, m.end)
				)}</mark>`
			);
			cursor = m.end;
		}
		parts.push(escapeHtml(value.slice(cursor)));
		// Append a trailing space to ensure the last character is
		// fully represented even if value ends mid-highlight (prevents
		// a subtle off-by-one where the last newline doesn't push a
		// blank line in the overlay).
		return parts.join('') + ' ';
	});

	// ─── Counter state ─────────────────────────────────────────────
	// The counter shows N/L in the bottom-right of the textarea when
	// showCounter is true and the user is approaching the limit.
	// Invisible below 75%, faint 75-89%, amber 90-99%, red at/above
	// 100%. The threshold model means users well below the limit
	// never have to look at a number they don't care about.

	/** Current "length" in the counter's counting mode. Codepoint
	 *  mode spreads the string — emoji and combined characters count
	 *  as 1 each, matching the indexer's validators for chat/feedback.
	 *  UTF-16 mode uses .length directly, matching validators that
	 *  compare against raw .length (order terms). */
	const currentLength = $derived(counterMode === 'codepoint' ? [...value].length : value.length);

	/** The soft limit shown to the user. Prefer the explicit
	 *  counterLimit; fall back to maxlength so simple call sites
	 *  (like order terms with a single cap) don't need to pass
	 *  both. */
	const effectiveLimit = $derived(counterLimit ?? maxlength ?? 0);

	/** Ratio used for tier thresholds. Zero-safe — an unset limit
	 *  produces a 0 ratio which pins the counter to the hidden tier
	 *  so we never divide by zero visually. */
	const ratio = $derived(effectiveLimit > 0 ? currentLength / effectiveLimit : 0);

	/** Tier drives both visibility and color. Tiers are thresholds
	 *  not percentages so the rendering is stable during IME
	 *  composition or paste bursts. */
	const counterTier = $derived.by<'hidden' | 'faint' | 'amber' | 'red'>(() => {
		if (!showCounter || effectiveLimit <= 0) return 'hidden';
		if (ratio >= 1) return 'red';
		if (ratio >= 0.9) return 'amber';
		if (ratio >= 0.75) return 'faint';
		return 'hidden';
	});

	/** aria-live only announces the counter when it actually matters.
	 *  A polite live-region on every keystroke is noise for screen
	 *  reader users — we keep quiet until the user is close to or
	 *  past the limit. */
	const counterLive = $derived(counterTier === 'amber' || counterTier === 'red' ? 'polite' : 'off');
</script>

<div class="protected-textarea relative {cls}">
	<!-- Backing overlay: positioned absolutely, same text as the
	     textarea, with <mark> spans around detected keys. Transparent
	     color so only the highlighted regions show through. -->
	<div bind:this={overlayEl} class="pk-overlay" aria-hidden="true">{@html overlayHtml}</div>

	<textarea
		bind:this={textareaEl}
		bind:value
		oninput={onInput}
		onblur={onBlur}
		onscroll={onScroll}
		{onkeydown}
		{rows}
		{maxlength}
		{placeholder}
		{disabled}
		aria-label={ariaLabel}
		class="pk-textarea w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
	></textarea>

	<!-- Inline character counter. Absolute-positioned bottom-right
	     inside the textarea padding. Visibility tied to counterTier
	     so users below 75% of the limit see nothing. pointer-events:
	     none so it never intercepts clicks, text selection, or the
	     native resize grip. -->
	{#if showCounter}
		<span
			class="pk-counter"
			class:pk-counter-faint={counterTier === 'faint'}
			class:pk-counter-amber={counterTier === 'amber'}
			class:pk-counter-red={counterTier === 'red'}
			class:pk-counter-hidden={counterTier === 'hidden'}
			aria-live={counterLive}
			aria-hidden={counterTier === 'hidden' ? 'true' : undefined}
		>
			{currentLength}/{effectiveLimit}
		</span>
	{/if}
</div>

<style>
	.protected-textarea {
		/* Create a positioning context for the overlay. */
		position: relative;
	}

	.pk-overlay {
		/* Match the textarea's geometry exactly so the highlights
		   align on top of the user's text. The textarea's padding,
		   border, font, and line-height must match between the two. */
		position: absolute;
		inset: 0;
		overflow: hidden;
		padding: 0.5rem 0.75rem; /* must match textarea py-2 px-3 */
		border: 2px solid transparent; /* must match textarea border width */
		border-radius: 0.75rem; /* matches rounded-xl */
		font-size: 0.875rem;
		line-height: 1.25rem;
		font-family: inherit;
		white-space: pre-wrap;
		word-wrap: break-word;
		overflow-wrap: break-word;
		/* The overlay text is invisible — we only want the <mark>
		   backgrounds to show through. */
		color: transparent;
		pointer-events: none;
		user-select: none;
	}

	.pk-overlay :global(mark.pk-match) {
		/* The alert state: bright red, bold, obvious. The user
		   should see this and FEEL the alarm. */
		background-color: #fee2e2; /* red-100 */
		color: #991b1b; /* red-800 — color still matters because
		                   the textarea text above is also red, so
		                   this sets the underlay colour */
		font-weight: 700;
		padding: 0 1px;
		border-radius: 2px;
		box-shadow: 0 0 0 2px #ef4444; /* red-500 ring */
	}

	:global(.dark) .pk-overlay :global(mark.pk-match) {
		background-color: #7f1d1d; /* red-900 */
		color: #fecaca; /* red-200 */
		box-shadow: 0 0 0 2px #f87171; /* red-400 ring */
	}

	.pk-textarea {
		/* Sit on top of the overlay. */
		position: relative;
		background-color: transparent;
		/* Match the overlay metrics so characters line up. */
		line-height: 1.25rem;
		resize: vertical;
	}

	/* When matches exist, tint the textarea text itself red so the
	   user sees the warning even if the overlay alignment drifts
	   by a pixel or two in certain browsers. We use a parent-state
	   :global selector since Svelte can't see through to the
	   textarea — `mark.pk-match` is only injected via {@html} into
	   the sibling overlay, so the static analyzer can't prove the
	   `:has` relationship; full :global tells it to trust us. */
	:global(.protected-textarea:has(mark.pk-match) .pk-textarea) {
		color: #b91c1c; /* red-700 */
		font-weight: 600;
	}

	:global(.dark.protected-textarea:has(mark.pk-match) .pk-textarea),
	:global(.dark .protected-textarea:has(mark.pk-match) .pk-textarea) {
		color: #fecaca; /* red-200 */
	}

	/* ─── Inline character counter ─────────────────────────────────
	   Sits in the bottom-right corner, above the textarea (but the
	   textarea's native resize grip — if any — is at `bottom: 0;
	   right: 0;` and is a small triangle. We inset the counter by
	   1rem from the right so it never collides with the grip.
	   pointer-events: none means it doesn't block clicks, text
	   selection, or the resize grip even where they overlap.
	   tabular-nums keeps the "1234/2048" width stable so the label
	   doesn't jitter as you type. */
	.pk-counter {
		position: absolute;
		right: 1rem;
		bottom: 0.5rem;
		padding: 0.125rem 0.375rem;
		border-radius: 0.375rem;
		font-size: 0.6875rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		font-weight: 500;
		letter-spacing: 0.025em;
		pointer-events: none;
		user-select: none;
		transition:
			opacity 180ms ease-out,
			color 180ms ease-out,
			background-color 180ms ease-out;
		/* Backdrop tints the counter so it reads legibly against
		   the textarea's content, but at low opacity so it doesn't
		   look like a solid pill. */
		background-color: rgb(255 255 255 / 0.78);
		color: #64748b; /* slate-500 */
	}
	:global(.dark) .pk-counter {
		background-color: rgb(15 20 28 / 0.78); /* ink-900 at 78% */
		color: #94a3b8; /* slate-400 */
	}

	.pk-counter-hidden {
		opacity: 0;
	}
	.pk-counter-faint {
		opacity: 0.55;
	}
	.pk-counter-amber {
		opacity: 1;
		color: #b45309; /* amber-700 */
		font-weight: 600;
	}
	:global(.dark) .pk-counter-amber {
		color: #fbbf24; /* amber-400 */
	}
	.pk-counter-red {
		opacity: 1;
		color: #b91c1c; /* red-700 */
		font-weight: 600;
	}
	:global(.dark) .pk-counter-red {
		color: #fca5a5; /* red-300 */
	}

	@media (prefers-reduced-motion: reduce) {
		.pk-counter {
			transition: none;
		}
	}
</style>
