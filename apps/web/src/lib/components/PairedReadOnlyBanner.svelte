<script lang="ts">
	/**
	 * PairedReadOnlyBanner — slim global bar shown when the current
	 * session is paired-readonly (ADR-0022 QR-pair).
	 *
	 * Purpose: keep the user constantly aware that this device is
	 * signed in but cannot SIGN.  Without this banner, Bob would
	 * be surprised every time he hit a write action and the UI
	 * said "open Morphit on your phone."  With the banner, the
	 * read-only state is part of the chrome — visible on every
	 * page, not just at the moment of friction.
	 *
	 * Rendered globally from +layout.svelte, immediately below the
	 * sticky header so it sits inside the normal page rhythm
	 * without blocking interactive elements.
	 *
	 * Hidden when:
	 *   - $isPairedReadOnly is false (locked OR unlocked normally)
	 *
	 * Visible when:
	 *   - $isPairedReadOnly is true (Bob paired from his phone)
	 *
	 * Sizing + styling:
	 *   - Same height (~36px) as other notice banners (e.g. stale-
	 *     build banner) so it composes cleanly.
	 *   - Brand-emerald palette to feel positive ("you ARE signed in")
	 *     not warning ("something is broken"); read-only is by design,
	 *     not an error state.
	 *   - Avoids the global content-width container; stretches edge
	 *     to edge, the way the other system banners do.
	 *
	 * A11y:
	 *   - role="status" — informational, not interrupting
	 *   - The banner text is the entire reason it exists; no aria-
	 *     hidden trickery.
	 */
	import { _ } from 'svelte-i18n';
	import { isPairedReadOnly, pairedReadOnly } from '$stores/identity';
</script>

{#if $isPairedReadOnly && $pairedReadOnly !== null}
	<div
		class="border-b border-morphit-emerald/30 bg-morphit-emerald/10 text-morphit-teal dark:text-morphit-emerald"
		role="status"
	>
		<div
			class="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-xs md:text-sm"
		>
			<span aria-hidden="true">
				<!-- Phone-with-key glyph drawn as inline SVG to avoid
				     emoji rendering variance across OSes. -->
				<svg
					class="inline-block h-4 w-4 align-text-bottom"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect x="6" y="2" width="12" height="20" rx="2" />
					<line x1="12" y1="18" x2="12" y2="18" />
				</svg>
			</span>
			<span class="font-semibold">
				{$_('paired_readonly.banner_heading', {
					values: { account: $pairedReadOnly.account }
				})}
			</span>
			<span class="text-ink-700 dark:text-ink-200">
				{$_('paired_readonly.banner_body')}
			</span>
		</div>
	</div>
{/if}
