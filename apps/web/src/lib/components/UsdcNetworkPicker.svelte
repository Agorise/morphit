<!--
	UsdcNetworkPicker — a required-field radio picker for the
	four USDC networks Morphit supports (ERC-20, SPL, Base,
	Polygon).

	Why it's a separate component (parallel to UsdtNetworkPicker):
	  - Used in /post (when an order is being created) AND in
	    AddressShareModal (when an address is being shared).
	  - The "no default network" rule is enforced here in a
	    single place — every consumer gets the same safety
	    posture.
	  - The cross-network warning copy is grouped here so
	    translators have a single context window for these
	    related strings.
	  - USDC has its own quirk worth surfacing: ERC-20 + Base +
	    Polygon all use the EVM 0x[40 hex] address format, so an
	    address looks indistinguishable between those three at
	    the format level.  The picker is the ONLY place we can
	    disambiguate which chain the sender's wallet should
	    broadcast on.  The cross-network warning copy mentions
	    this explicitly.

	Per memory #23 + Part 122 cp30 design (mirror of Part 121
	USDT design): single USDC entry, network picked at trade
	time, no default.  The `network` prop binds two-way and
	starts as null; parent components check for null before
	allowing submit.

	Per Memory #19 (privacy is priority #1): we surface the
	cross-network warning ABOVE the picker, not below — users
	read top-down, the warning has to land before the choice.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { USDC_NETWORKS, type UsdcNetwork } from '$lib/assets/networks';

	interface Props {
		/** Currently-selected network, or null if user hasn't
		 *  picked yet.  Parent should treat null as "not
		 *  ready to submit". */
		network: UsdcNetwork | null;
		/** Set true to disable all options (e.g. while a
		 *  parent form is submitting). */
		disabled?: boolean;
	}

	let { network = $bindable(), disabled = false }: Props = $props();
</script>

<fieldset class="space-y-3" {disabled}>
	<legend class="text-sm font-semibold text-ink-100">
		{$_('assets.usdc.network.picker.label')}
	</legend>

	<!-- Required-hint + cross-network warning sit ABOVE the
	     picker so users see the gravity before they choose. -->
	<p class="text-xs text-ink-400">
		{$_('assets.usdc.network.picker.requiredHint')}
	</p>
	<p
		class="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-200"
		role="note"
	>
		{$_('assets.usdc.network.picker.crossNetworkWarning')}
	</p>

	<div class="grid gap-2">
		{#each USDC_NETWORKS as net (net)}
			<label
				class="flex cursor-pointer items-start gap-3 rounded-md border border-ink-700 bg-ink-900 p-3 transition hover:border-ink-500 has-[:checked]:border-morphit-emerald has-[:checked]:bg-morphit-emerald/5"
			>
				<input
					type="radio"
					name="usdc-network"
					value={net}
					bind:group={network}
					class="mt-1 flex-none accent-morphit-emerald"
					required
				/>
				<img
					src="/icons/networks/icon-network-{net}.svg"
					alt=""
					loading="lazy"
					decoding="async"
					class="h-6 w-6 flex-none"
					aria-hidden="true"
				/>
				<div class="flex-1">
					<div class="text-sm font-semibold text-ink-100">
						{$_(`assets.usdc.network.${net}.displayName`)}
					</div>
					<div class="text-xs text-ink-400">
						{$_(`assets.usdc.network.${net}.feeHint`)}
					</div>
				</div>
			</label>
		{/each}
	</div>
</fieldset>
