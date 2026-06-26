<!--
	apps/web/src/routes/[lang]/admin/setup-wizard/+page.svelte
	cp116 — operator setup wizard, V1.

	WHAT THIS PAGE IS

	A guided UI for instance operators to generate the config-file
	lines and CLI commands they need to (1) disable specific assets
	on their instance, and (2) add a custom payment method.  This
	page does NOT mutate server state — it's a config-generator.
	Operators paste the output into their morphit.env file or
	terminal.  This preserves the existing operator architecture
	(env-file-configured + Docker compose + ops-cli) without
	requiring the web tier to gain filesystem-write or service-
	restart privileges.

	WHY READ-ONLY

	The "manually editing a text file sucks" pain (per memory rule
	cp115) is real, but solving it by giving the web tier mutation
	capability would (a) require a major new auth-gated mutation
	endpoint, (b) add filesystem-write attack surface on every
	Morphit instance, (c) need a service-restart trigger.  All three
	are sharp departures from current architecture.  A config-line
	generator preserves the architecture and removes the worst pain
	(typo-prone manual editing).

	V1 SCOPE

	  Section 1: Asset enable/disable
	    - Renders one checkbox per tradable asset
	    - BTC, XMR, BLURT are locked enabled (memory rule:
	      operators cannot disable the core three)
	    - Outputs the MORPHIT_INDEXER_DISABLED_ASSETS=...
	      line to paste into morphit.env
	    - Copy button + clear instructions

	  Section 2: Payment-method add
	    - Form: key, name, category, optional URL
	    - Outputs the `morphit-ops payment-method add ...`
	      shell command line
	    - Key collisions with canonical RESERVED_KEYS surface
	      a warning before generating the command

	NOT IN V1 (filed for follow-up)
	  - Payment-method remove UI (mirror of add)
	  - Live preview of the operator's current settings (would
	    require a read-only endpoint to fetch current env state)
	  - Auth-gating (V1 has no mutation, so no need)
	  - Re-ordering payment methods
	  - Validation against canonical RESERVED_KEYS (just shows
	    a warning, doesn't hard-block — operator may know
	    something we don't)

	ACCESSIBILITY
	  - All inputs labeled
	  - Asset list is a fieldset+legend
	  - Output regions have aria-live="polite" so screen-reader
	    users hear the env-var change as they toggle checkboxes
	  - Copy buttons have aria-label
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { ASSETS } from '$lib/assets/registry';
	import { PAYMENT_METHODS } from '$lib/payments/registry';
	import Head from '$components/Head.svelte';
	import { instance } from '$lib/stores/instance';
	import { instanceAdditions } from '$lib/stores/instanceAdditions';

	// The core three (memory rule cp115): operators cannot disable
	// these — they're load-bearing for the federation protocol.
	// BTC + XMR + BLURT comprise the listing-fee payment options;
	// disabling any of them would break the fee-payment path for
	// orders posted in those assets.
	const LOCKED_ASSETS = new Set(['BTC', 'XMR', 'BLURT']);

	// Build the asset list once.  Stable across the page lifecycle —
	// the asset registry is build-time-constant.
	const tradable = ASSETS.filter((a) => a.canBeTraded);

	// Operator's intended-disabled set.  Defaults to empty (all
	// enabled).  The UI checkbox state is INVERTED: checked = enabled,
	// unchecked = disabled.  Reads more naturally to operators ("which
	// coins do you want listed?") than the env-var-shape ("which do
	// you want disabled?").
	let disabledTickers = $state<Set<string>>(new Set());

	// Canonical payment-method disable set (cp208) — the payment-method
	// analogue of disabledTickers.  Same inverted UI convention:
	// checked = offered, unchecked = disabled.  Hydrated from
	// $instance.disabled_payment_methods alongside disabled_assets.
	let disabledMethods = $state<Set<string>>(new Set());

	// cp117 V3 #1: live config preview.  On mount, hydrate the
	// asset-disable state from the indexer's `/v1/instance` response
	// (already exposed as `disabled_assets`).  Operators see their
	// CURRENT state pre-populated, then they edit and see the diff
	// emit live in the env-var line.  This is the "I forgot what
	// I set last time" workflow.
	//
	// The instance store may not have hydrated yet on first mount;
	// subscribe and wait.  The store's `disabled_assets` field is
	// readonly string[]; we copy it into a new Set so subsequent
	// user toggles don't mutate the store state.
	//
	// Hydration runs ONCE: after the first non-default value arrives,
	// further store updates are ignored so the operator's in-progress
	// edits aren't blown away by a background refetch.  This is the
	// right tradeoff for an admin config-generator (the operator owns
	// the page state once they start interacting); a "reload current
	// state" button could be added later for the rare case the
	// operator does want to discard their edits.
	let hydrated = $state(false);

	onMount(() => {
		const unsubscribe = instance.subscribe((state) => {
			if (hydrated) return;
			// `disabled_assets` is always an array (default []); we
			// treat the initial unsubscribed state ([]) as "not yet
			// loaded" only if the store itself reports loading.  In
			// practice the store hydrates from the API fetch within
			// ~100ms; we accept the first emission whatever it is.
			//
			// Edge case: if the operator's instance genuinely has
			// zero disabled assets, the initial state and the
			// hydrated state are both empty — visually indistinguishable.
			// That's fine: empty=empty produces the same env line.
			if (state.disabled_assets) {
				disabledTickers = new Set(state.disabled_assets);
				disabledMethods = new Set(state.disabled_payment_methods ?? []);
				hydrated = true;
			}
		});
		return unsubscribe;
	});

	function toggleAsset(ticker: string): void {
		if (LOCKED_ASSETS.has(ticker)) return;
		const next = new Set(disabledTickers);
		if (next.has(ticker)) next.delete(ticker);
		else next.add(ticker);
		disabledTickers = next;
	}

	// Format the env var line.  Empty when nothing is disabled
	// (signals "all enabled" cleanly).
	const envLine = $derived.by(() => {
		const sorted = [...disabledTickers].sort();
		if (sorted.length === 0) {
			return 'MORPHIT_INDEXER_DISABLED_ASSETS=';
		}
		return `MORPHIT_INDEXER_DISABLED_ASSETS=${sorted.join(',')}`;
	});

	function toggleMethod(key: string): void {
		const next = new Set(disabledMethods);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		disabledMethods = next;
	}

	// Format the payment-method env var line (cp208).  Empty when
	// nothing is disabled (signals "all offered" cleanly).
	const methodEnvLine = $derived.by(() => {
		const sorted = [...disabledMethods].sort();
		if (sorted.length === 0) {
			return 'MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=';
		}
		return `MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=${sorted.join(',')}`;
	});

	// Payment-method form state.
	let pmKey = $state('');
	let pmName = $state('');
	let pmCategory = $state<'online' | 'in_person' | 'by_mail' | 'crypto'>('online');
	let pmUrl = $state('');
	let pmDescription = $state('');

	// Canonical reserved keys.  Drift is caught by the
	// reserved-keys-parity-smoke; keep this list in sync with
	// apps/ops-cli/src/commands/paymentMethod.ts when adding new
	// canonical methods.  If a future cp adds Visa+Mastercard
	// rails this list grows.
	const RESERVED_KEYS = new Set([
		'pay_btc', 'pay_blurt', 'pay_xmr', 'barter_goods', 'cash_in_person',
		'cash_by_mail', 'precious_metals', 'airwallex', 'alipay', 'amazon_pay',
		'apple_pay', 'bancontact', 'bitso', 'bizum', 'blik', 'cash_app',
		'gcash', 'google_pay', 'ideal', 'interac_etransfer', 'klarna', 'mpesa',
		'mercado_pago', 'mir', 'mtn_momo', 'oxxo_pay', 'payoneer',
		'paypal', 'paytm', 'payu', 'pix', 'przelewy24', 'revolut',
		'shaparak', 'shebapay', 'sofort', 'spei', 'square_cash',
		'unionpay', 'venmo', 'wechat_pay', 'wise', 'zelle'
	]);

	// Key validation — same rules as ops-cli + indexer.  ([a-z0-9_]+,
	// ≤32 chars, not a canonical reserved key).  Mirrors the same
	// rules in apps/ops-cli/src/commands/paymentMethod.ts so we
	// catch issues client-side before the operator spends a chain op.
	const KEY_PATTERN = /^[a-z0-9_]+$/;
	const keyError = $derived.by((): string | null => {
		const k = pmKey.trim();
		if (k.length === 0) return null;
		if (k.length > 32) return $_('admin.setup_wizard.payment.key_error_too_long');
		if (!KEY_PATTERN.test(k)) return $_('admin.setup_wizard.payment.key_error_format');
		if (RESERVED_KEYS.has(k)) return $_('admin.setup_wizard.payment.key_error_reserved');
		return null;
	});

	// URL validation — only https:// + bare-host pattern accepted,
	// matches the indexer's stricter rule.  Empty is fine (URL is
	// optional).
	const urlError = $derived.by((): string | null => {
		const u = pmUrl.trim();
		if (u.length === 0) return null;
		if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(u)) {
			return $_('admin.setup_wizard.payment.url_error_format');
		}
		return null;
	});

	// Whether the form is ready to emit a command.
	const pmReady = $derived(
		pmKey.trim().length > 0 &&
		pmName.trim().length > 0 &&
		pmDescription.trim().length > 0 &&
		keyError === null &&
		urlError === null
	);

	// Format the shell command for the operator to paste into
	// their terminal.  Each arg is single-quoted; single-quote
	// chars inside the input are escaped via '"'"' (POSIX-safe).
	function shellEscape(s: string): string {
		return `'${s.replace(/'/g, `'"'"'`)}'`;
	}

	const cliCommand = $derived.by(() => {
		if (!pmReady) return '';
		const parts = [
			'morphit-ops payment-method add',
			shellEscape(pmKey.trim()),
			`--name ${shellEscape(pmName.trim())}`,
			`--description ${shellEscape(pmDescription.trim())}`,
			`--category ${pmCategory}`
		];
		if (pmUrl.trim()) {
			parts.push(`--url ${shellEscape(pmUrl.trim())}`);
		}
		return parts.join(' \\\n  ');
	});

	// ─── Section 3: payment-method REMOVE (cp117) ──────────────
	// Mirror of the add form but minimal — only a key is needed for
	// the chain op.  Validation uses the same KEY_PATTERN as add,
	// but does NOT block RESERVED_KEYS at the UI level: canonical
	// keys aren't removable via the per-instance mechanism (the
	// indexer rejects them), but the operator may want to surface
	// the attempted command anyway to see the indexer's rejection
	// message — we don't second-guess.
	let pmRemoveKey = $state('');

	const removeKeyError = $derived.by((): string | null => {
		const k = pmRemoveKey.trim();
		if (k.length === 0) return null;
		if (k.length > 32) return $_('admin.setup_wizard.payment.key_error_too_long');
		if (!KEY_PATTERN.test(k)) return $_('admin.setup_wizard.payment.key_error_format');
		// Distinct error: not "reserved" (add-only); instead, warn
		// that removing a canonical key won't work.
		if (RESERVED_KEYS.has(k)) return $_('admin.setup_wizard.payment.remove_key_error_canonical');
		return null;
	});

	const removeReady = $derived(
		pmRemoveKey.trim().length > 0 && removeKeyError === null
	);

	const removeCliCommand = $derived.by(() => {
		if (!removeReady) return '';
		return `morphit-ops payment-method remove ${shellEscape(pmRemoveKey.trim())}`;
	});

	let removeCopied = $state(false);
	async function copyRemove(): Promise<void> {
		try {
			await navigator.clipboard.writeText(removeCliCommand);
			removeCopied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { removeCopied = false; }, 2000);
		} catch {
			// Fallback: textarea selectable manually.
		}
	}

	// Copy-to-clipboard utility.  Falls back to manual-select if
	// clipboard API is unavailable (e.g. older browsers, embedded
	// webviews).
	let envCopied = $state(false);
	let cliCopied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyEnv(): Promise<void> {
		try {
			await navigator.clipboard.writeText(envLine);
			envCopied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { envCopied = false; }, 2000);
		} catch {
			// Clipboard API blocked or unavailable.  The textarea
			// is still selectable manually.
		}
	}

	let methodEnvCopied = $state(false);
	async function copyMethodEnv(): Promise<void> {
		try {
			await navigator.clipboard.writeText(methodEnvLine);
			methodEnvCopied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { methodEnvCopied = false; }, 2000);
		} catch {
			// Clipboard blocked — the code block is selectable manually.
		}
	}

	async function copyCli(): Promise<void> {
		try {
			await navigator.clipboard.writeText(cliCommand);
			cliCopied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { cliCopied = false; }, 2000);
		} catch {
			// Same fallback as above.
		}
	}
</script>

<Head routeKey="admin_setup_wizard" />

<div class="mx-auto max-w-3xl px-4 py-12 md:py-16">
	<header class="mb-10">
		<p class="text-xs font-semibold uppercase tracking-widest text-ink-500">
			{$_('admin.setup_wizard.eyebrow')}
		</p>
		<h1 class="mt-2 font-display text-3xl font-bold leading-tight md:text-4xl">
			{$_('admin.setup_wizard.heading')}
		</h1>
		<p class="mt-4 text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.intro')}
		</p>
	</header>

	<!-- ─── Section 1: Asset enable/disable ─────────────────── -->
	<section class="mb-12 rounded-2xl border border-ink-100 bg-white p-6 md:p-8 dark:border-ink-800 dark:bg-ink-900">
		<h2 class="font-display text-xl font-bold">
			{$_('admin.setup_wizard.assets.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.assets.intro')}
		</p>

		<!-- cp117 V3 #1: live config preview.  Shows the instance's
		     CURRENTLY-configured disabled assets so operators can
		     see what's already in effect before they edit. -->
		<div
			class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-700 dark:bg-ink-950"
			aria-live="polite"
		>
			<span class="font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.assets.current_state_label')}
			</span>
			{#if !hydrated}
				<span class="ml-1 text-ink-500">{$_('admin.setup_wizard.assets.current_state_loading')}</span>
			{:else if $instance.disabled_assets.length === 0}
				<span class="ml-1 text-ink-600 dark:text-ink-300">
					{$_('admin.setup_wizard.assets.current_state_all_enabled')}
				</span>
			{:else}
				<span class="ml-1 font-mono text-ink-600 dark:text-ink-300">
					{$instance.disabled_assets.join(', ')}
				</span>
				<span class="ml-1 text-ink-500">
					{$_('admin.setup_wizard.assets.current_state_count', {
						values: { count: $instance.disabled_assets.length }
					})}
				</span>
			{/if}
		</div>

		<fieldset class="mt-6">
			<legend class="sr-only">{$_('admin.setup_wizard.assets.legend_sr')}</legend>
			<ul class="grid gap-2 sm:grid-cols-2">
				{#each tradable as a (a.displayTicker)}
					{@const locked = LOCKED_ASSETS.has(a.displayTicker)}
					{@const enabled = !disabledTickers.has(a.displayTicker)}
					<li>
						<label
							class="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-100 px-4 py-3 dark:border-ink-800
								{enabled ? '' : 'opacity-60'}
								{locked ? 'cursor-not-allowed' : 'hover:border-morphit-emerald'}"
						>
							<input
								type="checkbox"
								checked={enabled}
								disabled={locked}
								onchange={() => toggleAsset(a.displayTicker)}
								class="h-4 w-4 rounded text-morphit-emerald focus:ring-morphit-emerald"
							/>
							<img
								src={a.logoSvgPath}
								alt=""
								loading="lazy"
								width="24"
								height="24"
								class="h-6 w-6"
							/>
							<span class="font-semibold">{a.displayTicker}</span>
							<span class="text-sm text-ink-600 dark:text-ink-300">{a.displayName}</span>
							{#if locked}
								<span class="ml-auto text-xs font-semibold text-ink-500" title={$_('admin.setup_wizard.assets.locked_title')}>
									{$_('admin.setup_wizard.assets.locked_label')}
								</span>
							{/if}
						</label>
					</li>
				{/each}
			</ul>
		</fieldset>

		<div class="mt-6">
			<p class="text-sm font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.assets.output_heading')}
			</p>
			<p class="mt-1 text-xs text-ink-500">
				{$_('admin.setup_wizard.assets.output_subtitle')}
			</p>
			<div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
				<code
					class="flex-1 rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-sm break-all dark:border-ink-700 dark:bg-ink-950"
					aria-live="polite"
				>{envLine}</code>
				<button
					type="button"
					onclick={copyEnv}
					class="btn-secondary whitespace-nowrap"
					aria-label={$_('admin.setup_wizard.copy_button_aria')}
				>
					{envCopied ? $_('admin.setup_wizard.copied') : $_('admin.setup_wizard.copy_button')}
				</button>
			</div>
		</div>
	</section>

	<!-- ─── Section 2: Payment-method enable/disable (cp208) ── -->
	<section class="mb-12 rounded-2xl border border-ink-100 bg-white p-6 md:p-8 dark:border-ink-800 dark:bg-ink-900">
		<h2 class="font-display text-xl font-bold">
			{$_('admin.setup_wizard.payment_disable.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.payment_disable.intro')}
		</p>

		<!-- live config preview — current disabled payment methods -->
		<div
			class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-700 dark:bg-ink-950"
			aria-live="polite"
		>
			<span class="font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.assets.current_state_label')}
			</span>
			{#if !hydrated}
				<span class="ml-1 text-ink-500">{$_('admin.setup_wizard.assets.current_state_loading')}</span>
			{:else if $instance.disabled_payment_methods.length === 0}
				<span class="ml-1 text-ink-600 dark:text-ink-300">
					{$_('admin.setup_wizard.payment_disable.current_state_all_enabled')}
				</span>
			{:else}
				<span class="ml-1 font-mono text-ink-600 dark:text-ink-300">
					{$instance.disabled_payment_methods.join(', ')}
				</span>
				<span class="ml-1 text-ink-500">
					{$_('admin.setup_wizard.assets.current_state_count', {
						values: { count: $instance.disabled_payment_methods.length }
					})}
				</span>
			{/if}
		</div>

		<fieldset class="mt-6">
			<legend class="sr-only">{$_('admin.setup_wizard.payment_disable.legend_sr')}</legend>
			<ul class="grid gap-2 sm:grid-cols-2">
				{#each PAYMENT_METHODS as m (m.key)}
					{@const offered = !disabledMethods.has(m.key)}
					<li>
						<label
							class="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-100 px-4 py-3 hover:border-morphit-emerald dark:border-ink-800
								{offered ? '' : 'opacity-60'}"
						>
							<input
								type="checkbox"
								checked={offered}
								onchange={() => toggleMethod(m.key)}
								class="h-4 w-4 rounded text-morphit-emerald focus:ring-morphit-emerald"
							/>
							<span class="font-semibold">{m.name}</span>
							<span class="ml-auto font-mono text-xs text-ink-500">{m.key}</span>
						</label>
					</li>
				{/each}
			</ul>
		</fieldset>

		<div class="mt-6">
			<p class="text-sm font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.assets.output_heading')}
			</p>
			<p class="mt-1 text-xs text-ink-500">
				{$_('admin.setup_wizard.assets.output_subtitle')}
			</p>
			<div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
				<code
					class="flex-1 rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-sm break-all dark:border-ink-700 dark:bg-ink-950"
					aria-live="polite"
				>{methodEnvLine}</code>
				<button
					type="button"
					onclick={copyMethodEnv}
					class="btn-secondary whitespace-nowrap"
					aria-label={$_('admin.setup_wizard.copy_button_aria')}
				>
					{methodEnvCopied ? $_('admin.setup_wizard.copied') : $_('admin.setup_wizard.copy_button')}
				</button>
			</div>
		</div>
	</section>

	<!-- ─── Section 3: Payment-method add ───────────────────── -->
	<section class="rounded-2xl border border-ink-100 bg-white p-6 md:p-8 dark:border-ink-800 dark:bg-ink-900">
		<h2 class="font-display text-xl font-bold">
			{$_('admin.setup_wizard.payment.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.payment.intro')}
		</p>

		<!-- cp117 V3 #1: live config preview for payment methods. -->
		<div
			class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-700 dark:bg-ink-950"
			aria-live="polite"
		>
			<span class="font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.payment.current_state_label')}
			</span>
			{#if $instanceAdditions.length === 0}
				<span class="ml-1 text-ink-600 dark:text-ink-300">
					{$_('admin.setup_wizard.payment.current_state_none')}
				</span>
			{:else}
				<ul class="mt-2 space-y-1">
					{#each $instanceAdditions as a (a.key)}
						<li class="flex items-baseline gap-2">
							<code class="font-mono">{a.key}</code>
							<span class="text-ink-600 dark:text-ink-300">{a.name}</span>
							<span class="text-ink-400">·</span>
							<span class="text-ink-500">{a.category}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="mt-6 grid gap-4">
			<div>
				<label for="pm-key" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('admin.setup_wizard.payment.key_label')}
				</label>
				<p class="text-xs text-ink-500">{$_('admin.setup_wizard.payment.key_help')}</p>
				<input
					id="pm-key"
					type="text"
					bind:value={pmKey}
					maxlength="32"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-950"
					placeholder="my_local_method"
				/>
				{#if keyError}
					<p class="mt-1 text-xs text-morphit-coral" aria-live="polite">{keyError}</p>
				{/if}
			</div>

			<div>
				<label for="pm-name" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('admin.setup_wizard.payment.name_label')}
				</label>
				<p class="text-xs text-ink-500">{$_('admin.setup_wizard.payment.name_help')}</p>
				<input
					id="pm-name"
					type="text"
					bind:value={pmName}
					maxlength="80"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
					placeholder="My Local Method"
				/>
			</div>

			<div>
				<label for="pm-description" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('admin.setup_wizard.payment.description_label')}
				</label>
				<p class="text-xs text-ink-500">{$_('admin.setup_wizard.payment.description_help')}</p>
				<textarea
					id="pm-description"
					bind:value={pmDescription}
					maxlength="280"
					rows="2"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				></textarea>
			</div>

			<div>
				<label for="pm-category" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('admin.setup_wizard.payment.category_label')}
				</label>
				<select
					id="pm-category"
					bind:value={pmCategory}
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				>
					<option value="online">{$_('admin.setup_wizard.payment.category_online')}</option>
					<option value="in_person">{$_('admin.setup_wizard.payment.category_in_person')}</option>
					<option value="by_mail">{$_('admin.setup_wizard.payment.category_by_mail')}</option>
					<option value="crypto">{$_('admin.setup_wizard.payment.category_crypto')}</option>
				</select>
			</div>

			<div>
				<label for="pm-url" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('admin.setup_wizard.payment.url_label')}
				</label>
				<p class="text-xs text-ink-500">{$_('admin.setup_wizard.payment.url_help')}</p>
				<input
					id="pm-url"
					type="url"
					bind:value={pmUrl}
					maxlength="512"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-950"
					placeholder="https://example.com"
				/>
				{#if urlError}
					<p class="mt-1 text-xs text-morphit-coral" aria-live="polite">{urlError}</p>
				{/if}
			</div>
		</div>

		<div class="mt-6">
			<p class="text-sm font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.payment.output_heading')}
			</p>
			<p class="mt-1 text-xs text-ink-500">
				{$_('admin.setup_wizard.payment.output_subtitle')}
			</p>
			{#if pmReady}
				<div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
					<pre
						class="flex-1 overflow-x-auto rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs dark:border-ink-700 dark:bg-ink-950"
						aria-live="polite"
					>{cliCommand}</pre>
					<button
						type="button"
						onclick={copyCli}
						class="btn-secondary whitespace-nowrap"
						aria-label={$_('admin.setup_wizard.copy_button_aria')}
					>
						{cliCopied ? $_('admin.setup_wizard.copied') : $_('admin.setup_wizard.copy_button')}
					</button>
				</div>
			{:else}
				<p class="mt-2 rounded-lg border border-dashed border-ink-300 p-3 text-sm text-ink-500 dark:border-ink-700">
					{$_('admin.setup_wizard.payment.output_pending')}
				</p>
			{/if}
		</div>
	</section>

	<!-- ─── Section 3 (cp117): Payment-method REMOVE ───────────── -->
	<section class="mt-8 rounded-2xl border border-ink-100 bg-white p-6 md:p-8 dark:border-ink-800 dark:bg-ink-900">
		<h2 class="font-display text-xl font-bold">
			{$_('admin.setup_wizard.payment_remove.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.payment_remove.intro')}
		</p>

		<div class="mt-6">
			<label for="pm-remove-key" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.payment_remove.key_label')}
			</label>
			<p class="text-xs text-ink-500">{$_('admin.setup_wizard.payment_remove.key_help')}</p>
			<input
				id="pm-remove-key"
				type="text"
				bind:value={pmRemoveKey}
				maxlength="32"
				class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-950"
				placeholder="my_local_method"
			/>
			{#if removeKeyError}
				<p class="mt-1 text-xs text-morphit-coral" aria-live="polite">{removeKeyError}</p>
			{/if}
		</div>

		<div class="mt-6">
			<p class="text-sm font-semibold text-ink-700 dark:text-ink-200">
				{$_('admin.setup_wizard.payment_remove.output_heading')}
			</p>
			<p class="mt-1 text-xs text-ink-500">
				{$_('admin.setup_wizard.payment_remove.output_subtitle')}
			</p>
			{#if removeReady}
				<div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
					<pre
						class="flex-1 overflow-x-auto rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs dark:border-ink-700 dark:bg-ink-950"
						aria-live="polite"
					>{removeCliCommand}</pre>
					<button
						type="button"
						onclick={copyRemove}
						class="btn-secondary whitespace-nowrap"
						aria-label={$_('admin.setup_wizard.copy_button_aria')}
					>
						{removeCopied ? $_('admin.setup_wizard.copied') : $_('admin.setup_wizard.copy_button')}
					</button>
				</div>
			{:else}
				<p class="mt-2 rounded-lg border border-dashed border-ink-300 p-3 text-sm text-ink-500 dark:border-ink-700">
					{$_('admin.setup_wizard.payment_remove.output_pending')}
				</p>
			{/if}
		</div>

		<!-- Honest aside: remove doesn't break in-flight orders -->
		<div class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-950 dark:text-ink-300">
			ℹ️ {$_('admin.setup_wizard.payment_remove.orders_safety')}
		</div>
	</section>

	<!-- Honest disclosure: V1 capabilities -->
	<aside class="mt-10 rounded-2xl border border-ink-100 bg-ink-50 p-6 dark:border-ink-800 dark:bg-ink-950">
		<h2 class="text-sm font-bold uppercase tracking-widest text-ink-600 dark:text-ink-300">
			{$_('admin.setup_wizard.disclosure.heading')}
		</h2>
		<ul class="mt-3 space-y-2 text-sm text-ink-600 dark:text-ink-300">
			<li>• {$_('admin.setup_wizard.disclosure.read_only')}</li>
			<li>• {$_('admin.setup_wizard.disclosure.no_auth')}</li>
			<li>• {$_('admin.setup_wizard.disclosure.restart_required')}</li>
		</ul>
	</aside>
</div>
