<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Term — inline glossary-link with hover/tap tooltip.
	 *
	 * Renders the wrapped word with a dotted underline as a
	 * cue that hovering will reveal a definition; on hover
	 * (desktop) or tap (mobile), a small popover surfaces the
	 * `glossary.<key>.body` translation along with a deep
	 * link to `/glossary#<key>` for the full entry.
	 *
	 * After the FIRST appearance on a given route, subsequent
	 * `<Term key="fiat">…</Term>` instances on the same route
	 * render as plain text — the underline cue is only useful
	 * the first time per page; a long page peppered with
	 * dotted underlines on every "fiat" is visually noisy and
	 * trains the user to ignore them.
	 *
	 * Tracking lives in `$lib/stores/glossarySeen` (a writable
	 * store keyed by current route pathname), reset on
	 * navigation by the top-level layout's `$effect`.
	 *
	 * Accessibility notes:
	 *
	 *   - The trigger is a `<button>` so keyboard focus
	 *     reveals the tooltip the same way hover does (focus
	 *     event), and Enter/Space activate the
	 *     "open glossary" link via the popover's anchor.
	 *   - The visible cue is the dotted-underline trigger
	 *     itself, not a separate icon — adding a help-circle
	 *     icon next to every glossary word would be a much
	 *     louder visual change than the design wants.  The
	 *     dotted underline is a long-established convention
	 *     for "this word has a definition."
	 *   - `aria-describedby` points at the popover when open
	 *     so screen readers announce the description as part
	 *     of the focused word.
	 *   - Escape closes the popover and returns focus to the
	 *     button.
	 *
	 * Design decisions:
	 *
	 *   - The popover is small (~256px wide) and positioned
	 *     above the word.  On narrow viewports it shifts
	 *     horizontally to stay on-screen via the `max-w` +
	 *     CSS clamp pattern.
	 *   - The popover's deep link goes to `/glossary#<key>`,
	 *     not to a `/faq#…` entry, because the glossary
	 *     definitions are intentionally shorter and more
	 *     focused than the FAQ.  Users wanting FAQ depth can
	 *     navigate from the glossary page itself.
	 *   - This is NOT auto-applied — call sites have to
	 *     explicitly wrap the word.  Auto-detection over rendered
	 *     text would be brittle (false positives on user content,
	 *     hard to localize, hard to test).  Explicit wrapping
	 *     gives the writer full control over which appearance
	 *     gets the cue.
	 */
	import { onDestroy, untrack } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';
	import { markSeen } from '$stores/glossarySeen';

	interface Props {
		/** Glossary key — must match a `glossary.<key>.{title,body}`
		 *  entry in the locale JSONs.  Examples: `'fiat'`,
		 *  `'permlink'`, `'listing_fee'`. */
		key: string;
		/** The word(s) to render.  Use the {@render children}
		 *  snippet rather than text-via-prop so callers can
		 *  inflect ("fiat" / "fiat currencies" / "fiats" all
		 *  point at the same glossary entry). */
		children?: import('svelte').Snippet;
		/** When true, the dotted underline DISAPPEARS on hover/focus
		 *  (border goes transparent) instead of recolouring to emerald.
		 *  Ken asked for this specifically on the FAQ acronym tooltips;
		 *  default false preserves the recolour behaviour everywhere else. */
		hideUnderlineOnHover?: boolean;
	}

	let { key, children, hideUnderlineOnHover = false }: Props = $props();

	// One-time decision per instance: do we render with the
	// tooltip cue, or plain text?  Decided at mount time
	// against the seen-tracker store; subsequent reactive
	// reads of $page.url.pathname don't re-evaluate this —
	// the user shouldn't see the underline disappear mid-
	// route as scroll-induced re-renders happen.  `key` is
	// captured non-reactively via `untrack` because props
	// don't change for a given <Term> instance — each call
	// site like `<Term key="fiat">` makes a stable
	// instance — and re-evaluating on key changes would be
	// nonsensical (different glossary term entirely).
	const isFirstAppearance = untrack(() =>
		markSeen(get(page)?.url?.pathname ?? '', key)
	);

	let open = $state(false);
	let triggerEl: HTMLButtonElement | undefined = $state(undefined);
	let popoverEl: HTMLElement | undefined = $state(undefined);
	// Computed fixed-position style (flip + viewport clamp); `positioned`
	// keeps the popover invisible for the one measure frame so it never
	// paints at its pre-measured spot.
	let popStyle = $state('position: fixed;');
	let positioned = $state(false);

	// Hover-bridge: a brief close delay so moving the pointer from the
	// trigger into the popover (across the small gap) doesn't close it
	// before the user can click the "open glossary" link.  Entering
	// either the trigger or the popover cancels the pending close.
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelClose(): void {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}
	function openTooltip(): void {
		cancelClose();
		open = true;
	}
	function scheduleClose(): void {
		cancelClose();
		closeTimer = setTimeout(() => {
			open = false;
			closeTimer = null;
		}, 140);
	}
	function closeTooltip(): void {
		cancelClose();
		open = false;
	}

	// Place the popover in viewport coordinates: prefer above, flip
	// below when there isn't room (the first-paragraph terms sit near
	// the top of the page, so a fixed "above" placement ran off the top
	// of the screen), and clamp horizontally so an edge-of-line word's
	// popover stays fully on-screen.  `position: fixed` also escapes any
	// ancestor that would clip it.
	function reposition(): void {
		if (!triggerEl || !popoverEl) return;
		const t = triggerEl.getBoundingClientRect();
		const p = popoverEl.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const gap = 8;
		const margin = 8;
		let left = t.left + t.width / 2 - p.width / 2;
		left = Math.max(margin, Math.min(left, vw - p.width - margin));
		const roomAbove = t.top;
		const roomBelow = vh - t.bottom;
		let top: number;
		if (roomAbove >= p.height + gap || roomAbove >= roomBelow) {
			top = t.top - p.height - gap;
		} else {
			top = t.bottom + gap;
		}
		top = Math.max(margin, Math.min(top, vh - p.height - margin));
		popStyle = `position: fixed; left: ${Math.round(left)}px; top: ${Math.round(top)}px; right: auto; bottom: auto; margin: 0; transform: none;`;
		positioned = true;
	}

	$effect(() => {
		if (!open) {
			positioned = false;
			return;
		}
		// Measure after the popover has rendered; keep it pinned to the
		// trigger if the page scrolls or the window resizes while open.
		const raf = requestAnimationFrame(reposition);
		const onMove = (): void => reposition();
		window.addEventListener('scroll', onMove, true);
		window.addEventListener('resize', onMove);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('scroll', onMove, true);
			window.removeEventListener('resize', onMove);
		};
	});

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			closeTooltip();
			triggerEl?.focus();
		}
	}

	// Close on click-outside (mobile-friendly).  Listener is
	// attached only while the popover is open to avoid
	// always-on document listeners.
	let docClickHandler: ((_e: MouseEvent) => void) | null = null;
	$effect(() => {
		if (open) {
			docClickHandler = (e: MouseEvent) => {
				const target = e.target;
				if (
					triggerEl &&
					target instanceof Node &&
					!triggerEl.contains(target)
				) {
					// Also tolerate clicks inside the popover itself
					// (the deep-link anchor); browsers fire click on
					// document AFTER click on the anchor, so the
					// anchor's navigation has already been triggered.
					closeTooltip();
				}
			};
			document.addEventListener('click', docClickHandler);
		} else if (docClickHandler) {
			document.removeEventListener('click', docClickHandler);
			docClickHandler = null;
		}
	});

	onDestroy(() => {
		cancelClose();
		if (docClickHandler) {
			document.removeEventListener('click', docClickHandler);
			docClickHandler = null;
		}
	});

	const popoverId = $derived(`term-tip-${key}`);

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

{#if isFirstAppearance}
	<span class="relative inline-block">
		<button
			bind:this={triggerEl}
			type="button"
			class="cursor-help border-b border-dotted border-ink-400 text-ink-900 {hideUnderlineOnHover
				? 'hover:border-transparent'
				: 'hover:border-morphit-emerald'} hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-500 dark:text-ink-50 dark:hover:text-morphit-emerald-light"
			aria-describedby={open ? popoverId : undefined}
			aria-expanded={open}
			onmouseenter={openTooltip}
			onmouseleave={scheduleClose}
			onfocus={openTooltip}
			onblur={scheduleClose}
			onclick={(e) => {
				// On click (mobile / keyboard activation), toggle.
				// Don't navigate — the popover's deep-link is the
				// navigation target.
				e.preventDefault();
				open = !open;
			}}
			onkeydown={onKeyDown}
		>
			{#if children}{@render children()}{:else}{$_(`glossary.${key}.title`)}{/if}
		</button>

		{#if open}
			<span
				bind:this={popoverEl}
				id={popoverId}
				role="tooltip"
				style={popStyle}
				class="z-50 w-64 max-w-[min(16rem,calc(100vw-2rem))] rounded-xl border border-ink-200 bg-white p-3 text-sm shadow-morphit-card dark:border-ink-700 dark:bg-ink-900{positioned ? '' : ' invisible'}"
				onmouseenter={openTooltip}
				onmouseleave={scheduleClose}
			>
				<span class="block font-display text-base font-bold text-ink-900 dark:text-ink-50">
					{$_(`glossary.${key}.title`)}
				</span>
				<span class="mt-1 block text-ink-700 dark:text-ink-200">
					{$_(`glossary.${key}.body`)}
				</span>
				<a
					href={lp(`/glossary#${key}`)}
					class="mt-2 inline-block text-sm font-semibold text-morphit-emerald"
					onfocus={cancelClose}
					onblur={scheduleClose}
				>
					{$_('glossary.tooltip.open_full')}
					<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
				</a>
			</span>
		{/if}
	</span>
{:else}
	<!-- Subsequent appearance on this route — render plain text
	     with no cue.  The user has already seen the underline
	     once; further dotted-underlines would just add noise. -->
	{#if children}{@render children()}{:else}{$_(`glossary.${key}.title`)}{/if}
{/if}
