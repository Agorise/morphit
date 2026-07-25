<!--
	ReciprocityPill — the suspicious-reciprocity trust pill.

	Green "No mutual-review flags" when the account appears in no
	suspicious_reciprocity pair (Signal B); amber "Mutual-review flag"
	when it does. Extracted (v1.8.15, t.txt #5) from the profile
	Reputation card so the order DETAIL page's "POSTED BY" card shows the
	IDENTICAL pill — one markup, one pair of localized strings
	(profile.reciprocity_clean_pill / profile.reciprocity_flagged_pill),
	both of which already ship in every locale.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';

	interface Props {
		/** True iff the account is in a suspicious_reciprocity pair. */
		flagged: boolean;
	}

	let { flagged }: Props = $props();
</script>

{#if flagged}
	<span
		class="inline-flex flex-none items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
	>
		<svg
			aria-hidden="true"
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
			<path d="M12 9v4" />
			<path d="M12 17h.01" />
		</svg>
		{$_('profile.reciprocity_flagged_pill')}
	</span>
{:else}
	<span
		class="inline-flex flex-none items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/10 px-2.5 py-0.5 text-xs font-semibold text-morphit-emerald"
	>
		<svg
			aria-hidden="true"
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M20 6 9 17l-5-5" />
		</svg>
		{$_('profile.reciprocity_clean_pill')}
	</span>
{/if}
