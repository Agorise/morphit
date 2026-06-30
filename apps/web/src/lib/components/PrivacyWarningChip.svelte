<!--
	PrivacyWarningChip — surfaces a non-blocking but visually
	prominent privacy/decentralization warning for assets that
	don't meet Morphit's priority-#1 stance (privacy first).

	Used wherever an asset is being CHOSEN or its address is
	being SHARED.  The chip is dismissible per-session but
	NOT persistent — re-shown on every page mount because
	users rotate through orders and each one deserves the
	reminder.

	Driven by the asset registry's `privacyWarningKey` field
	(or `assets.privacy_warnings.<key>` in the i18n bundle).
	Assets with privacyWarningKey === null render nothing.

	Per Memory #19 (privacy is priority #1): the warning is
	required, not optional, for any asset that fails the
	privacy bar.

	Usage:
		<PrivacyWarningChip privacyWarningKey={asset.privacyWarningKey} />

	The component intentionally has no "dismiss permanently"
	option — operators who want users to never see this
	again must disable the asset entirely via
	`MORPHIT_INDEXER_DISABLED_ASSETS`.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';

	interface Props {
		/** i18n key under `assets.privacy_warnings.*`.  Null
		 *  renders nothing (the common case for private assets
		 *  like XMR or decentralized ones like BTC). */
		privacyWarningKey: string | null;
		/** Compact mode — render as a small icon-only badge
		 *  rather than the full body-text chip.  Used in
		 *  orderbook rows where space is constrained.  Tap
		 *  expands; on hover (desktop) the body text is
		 *  surfaced in a tooltip via title=. */
		compact?: boolean;
	}

	let { privacyWarningKey, compact = false }: Props = $props();

	let dismissed = $state(false);

	const fullText = $derived(
		privacyWarningKey ? ($_(`assets.privacy_warnings.${privacyWarningKey}`) as string) : ''
	);
</script>

{#if privacyWarningKey && !dismissed}
	{#if compact}
		<button
			type="button"
			class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-400/20 text-red-400 hover:bg-red-400/30"
			title={fullText}
			aria-label={fullText}
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				dismissed = false; /* keep visible — compact mode toggles tooltip via title */
			}}
		>
			<!-- Warning glyph (filled triangle).  Tiny on purpose
			     — chips next to other order metadata should not
			     dominate. -->
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 16 16"
				fill="currentColor"
				class="h-3 w-3"
				aria-hidden="true"
			>
				<path
					d="M8 1.5L15 14H1L8 1.5zm0 4.5v4m0 2.5v.01"
					stroke="currentColor"
					stroke-width="1.5"
					fill="none"
					stroke-linecap="round"
				/>
			</svg>
		</button>
	{:else}
		<aside
			class="my-3 flex gap-3 rounded-lg border border-red-400/30 bg-red-400/5 p-4 text-sm"
			role="note"
			aria-live="polite"
		>
			<!-- Warning glyph, larger -->
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="mt-0.5 h-5 w-5 flex-none text-red-400"
				aria-hidden="true"
			>
				<path
					d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
				/>
				<line x1="12" y1="9" x2="12" y2="13" />
				<line x1="12" y1="17" x2="12.01" y2="17" />
			</svg>
			<div class="flex-1 text-ink-200">
				{fullText}
			</div>
			<button
				type="button"
				class="flex-none text-ink-400 hover:text-ink-100"
				aria-label="Dismiss for this session"
				onclick={() => (dismissed = true)}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="h-4 w-4"
					aria-hidden="true"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		</aside>
	{/if}
{/if}
