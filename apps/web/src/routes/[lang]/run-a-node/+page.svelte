<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import Term from '$components/Term.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { liveIdentity, isPairedReadOnly, hasAnySession } from '$stores/identity';
	import {
		broadcastOperatorRegister,
		validateTag,
		validateOperatorDisplayName,
		validateContactUrl,
		TAG_MAX,
		DISPLAY_NAME_MAX
	} from '$lib/blurt/ops/operatorRegister';
	import { BroadcastError } from '$lib/blurt/ops/profile';

	// Form state for the claim-your-tag section.
	let tag = $state('');
	let displayName = $state('');
	let contactUrl = $state('');
	let submitting = $state(false);
	let result: { kind: 'ok'; trxId: string } | { kind: 'err'; reason: string } | null = $state(null);

	// Live validation feedback. We surface the FIRST failing check
	// rather than all of them, to avoid wall-of-red on a partially-typed
	// form. The Register button disables until the form is submission-ready.
	const tagCheck = $derived(tag.length > 0 ? validateTag(tag) : null);
	const nameCheck = $derived(
		displayName.length > 0 ? validateOperatorDisplayName(displayName) : null
	);
	const urlCheck = $derived(
		contactUrl.trim().length > 0 ? validateContactUrl(contactUrl.trim()) : null
	);
	const canSubmit = $derived(
		tag.length > 0 &&
			displayName.length > 0 &&
			(!tagCheck || tagCheck.ok) &&
			(!nameCheck || nameCheck.ok) &&
			(!urlCheck || urlCheck.ok) &&
			$liveIdentity !== null &&
			!submitting
	);

	async function register(): Promise<void> {
		if (!$liveIdentity || submitting) return;
		submitting = true;
		result = null;
		try {
			const res = await broadcastOperatorRegister($liveIdentity, {
				tag,
				display_name: displayName,
				contact_url: contactUrl.trim() || undefined
			});
			result = { kind: 'ok', trxId: res.trx_id };
			// Clear form on success — user can't re-register with
			// the same account anyway.
			tag = '';
			displayName = '';
			contactUrl = '';
		} catch (err) {
			if (err instanceof BroadcastError && err.code === 'no_account') {
				result = { kind: 'err', reason: 'no_account' };
			} else if (err instanceof Error) {
				// Client-side validators throw with the reason slug
				// as message; also catches chain-rejection errors
				// surfaced by broadcastCustomJson.
				result = { kind: 'err', reason: err.message };
			} else {
				result = { kind: 'err', reason: 'unknown' };
			}
		} finally {
			submitting = false;
		}
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="run_a_node" />

<section class="mx-auto max-w-4xl px-4 py-12 md:px-6 md:py-16">
	<header class="text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('run_a_node.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-2xl text-ink-700 dark:text-ink-300">
			{$_('run_a_node.subtitle')}
		</p>
	</header>

	<!-- Tier 1.4 follow-up (Part 90): inline glossary cues for the
	     handful of jargon words this page leans on heavily.  The
	     <Term> component renders each as dotted-underline +
	     hover/tap tooltip, with the underline cue suppressed on
	     subsequent appearances on the same route. -->
	<aside
		class="mt-6 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700 dark:border-ink-800 dark:bg-ink-950/50 dark:text-ink-300"
		aria-label={$_('run_a_node.key_terms.aria')}
	>
		<p class="font-semibold text-ink-900 dark:text-ink-50">
			{$_('run_a_node.key_terms.heading')}
		</p>
		<p class="mt-1">
			{$_('run_a_node.key_terms.intro_1')}
			<Term key="operator">{$_('run_a_node.key_terms.term_operator')}</Term>
			{$_('run_a_node.key_terms.intro_2')}
			<Term key="indexer">{$_('run_a_node.key_terms.term_indexer')}</Term>{$_('run_a_node.key_terms.and')}<Term
				key="relay">{$_('run_a_node.key_terms.term_relay')}</Term>{$_('run_a_node.key_terms.intro_3')}
			<Term key="federation">{$_('run_a_node.key_terms.term_federation')}</Term>{$_('run_a_node.key_terms.intro_4')}
		</p>
	</aside>

	<!-- Operator registration — ADR-0013 Q1.1 ratified.
	     Any signed-in account can broadcast a `morphit_operator_register_v1`
	     op to claim an operator tag. First-come-first-served. -->
	<section class="mt-8" aria-labelledby="register-heading">
		<div class="card border border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-950/50">
			<h2 id="register-heading" class="font-display text-2xl font-bold">
				{$_('run_a_node.register.heading')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.register.explain')}</p>

			{#if !$hasAnySession}
				<!-- Part 116: only "no session at all" sees the sign-in
				     CTA.  Paired-readonly users have a session but no
				     local signing key, so they need an affordance, not
				     a misleading "please sign in" prompt. -->
				<div class="mt-4">
					<StatusLine kind="idle">
						{$_('run_a_node.register.need_signin')}
					</StatusLine>
					<a href={lp('/login')} class="btn-primary btn-shine mt-4 inline-flex">
						{$_('run_a_node.register.signin_cta')}
					</a>
				</div>
			{:else if $isPairedReadOnly}
				<!-- Part 116: paired-readonly users get an affordance
				     pointing them at /run-a-node on their phone where
				     they can complete the registration with their
				     locally-held posting key. -->
				<div class="mt-4">
					<WriteBlockedReadOnly variant="operator_register" />
				</div>
			{:else if result?.kind === 'ok'}
				<div class="mt-4">
					<StatusLine kind="ok">
						{$_('run_a_node.register.success')}
					</StatusLine>
					<p class="mt-3 break-all font-mono text-xs text-ink-600 dark:text-ink-400">
						trx_id: {result.trxId}
					</p>
					<a href={lp('/operators')} class="btn-secondary mt-4 inline-flex">
						{$_('run_a_node.register.view_directory')}
					</a>
				</div>
			{:else}
				<form
					class="mt-5 space-y-4"
					onsubmit={(e) => {
						e.preventDefault();
						void register();
					}}
				>
					<div>
						<label for="op-tag" class="mb-1 block text-sm font-semibold">
							{$_('run_a_node.register.tag_label')}
						</label>
						<input
							id="op-tag"
							type="text"
							bind:value={tag}
							autocomplete="off"
							autocapitalize="none"
							spellcheck="false"
							maxlength={TAG_MAX}
							placeholder={$_('run_a_node.register.tag_placeholder')}
							class="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 font-mono focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
						<p class="mt-1 text-xs text-ink-500">
							{$_('run_a_node.register.tag_help')}
						</p>
						{#if tagCheck && !tagCheck.ok}
							<p class="mt-1 text-xs text-red-400">
								{$_(`run_a_node.register.err_${tagCheck.reason}`)}
							</p>
						{/if}
					</div>

					<div>
						<label for="op-name" class="mb-1 block text-sm font-semibold">
							{$_('run_a_node.register.display_name_label')}
						</label>
						<input
							id="op-name"
							type="text"
							bind:value={displayName}
							maxlength={DISPLAY_NAME_MAX}
							placeholder={$_('run_a_node.register.display_name_placeholder')}
							class="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
						<p class="mt-1 text-xs text-ink-500">
							{$_('run_a_node.register.display_name_help')}
						</p>
						{#if nameCheck && !nameCheck.ok}
							<p class="mt-1 text-xs text-red-400">
								{$_(`run_a_node.register.err_${nameCheck.reason}`)}
							</p>
						{/if}
					</div>

					<div>
						<label for="op-url" class="mb-1 block text-sm font-semibold">
							{$_('run_a_node.register.contact_url_label')}
						</label>
						<input
							id="op-url"
							type="url"
							bind:value={contactUrl}
							maxlength="512"
							autocomplete="url"
							placeholder="https://"
							class="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
						<p class="mt-1 text-xs text-ink-500">
							{$_('run_a_node.register.contact_url_help')}
						</p>
						{#if urlCheck && !urlCheck.ok}
							<p class="mt-1 text-xs text-red-400">
								{$_(`run_a_node.register.err_${urlCheck.reason}`)}
							</p>
						{/if}
					</div>

					{#if result?.kind === 'err'}
						<StatusLine kind="error">
							{$_(`run_a_node.register.err_${result.reason}`, {
								default: $_('run_a_node.register.err_generic')
							})}
						</StatusLine>
					{/if}

					<BusyButton
						variant="primary"
						busy={submitting}
						disabled={!canSubmit}
						busyLabel={$_('common.broadcasting')}
						onclick={register}
					>
						{$_('run_a_node.register.submit')}
					</BusyButton>
				</form>
			{/if}
		</div>
	</section>

	<!-- Why: the motivations for third-party operators. Ordered by
		 strength — censorship resistance first, earnings second,
		 because putting money first attracts the wrong kind of
		 operator. -->
	<section class="mt-12">
		<h2 class="font-display text-2xl font-bold">{$_('run_a_node.why_heading')}</h2>
		<ul class="mt-6 grid gap-5 md:grid-cols-2">
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_uncensor_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_uncensor_body')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_community_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_community_body')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_privacy_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_privacy_body')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_earn_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_earn_body')}</p>
			</li>
		</ul>
	</section>

	<!-- How: a linear walkthrough of setup, pointing readers at the
		 OPERATIONS.md runbook for full detail. This page is the
		 marketing onramp; OPERATIONS.md is the operations manual. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">{$_('run_a_node.how_heading')}</h2>
		<ol class="mt-6 space-y-4">
			{#each [1, 2, 3, 4] as n (n)}
				<li
					class="flex gap-4 rounded-2xl border border-ink-200 bg-white p-5 dark:border-ink-800 dark:bg-ink-900"
				>
					<span
						class="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-morphit-gradient font-display text-sm font-bold text-ink-950"
					>
						{n}
					</span>
					<div>
						<h3 class="font-display text-lg font-bold">
							{$_(`run_a_node.step${n}_title`)}
						</h3>
						<p class="mt-1 text-ink-700 dark:text-ink-300">{$_(`run_a_node.step${n}_body`)}</p>
					</div>
				</li>
			{/each}
		</ol>

		<p class="mt-6 text-base text-ink-800 dark:text-ink-200">
			<strong>{$_('run_a_node.beginner_label')}</strong>
			{$_('run_a_node.beginner_pointer')}
			<!-- Sally finding RAN2 (Part 69): the project's git server
			     is Forgejo (git.agorise.net), which uses /src/branch/
			     URL syntax — NOT GitLab's /-/blob/.  These two doc
			     links 404'd until Part 69.  See also docs/PLAN.md
			     and docs/SECURITY.md links elsewhere in the app
			     which already use the correct Forgejo form. -->
			<a
				href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/RUN-A-MORPHIT-NODE.md"
				target="_blank" rel="noopener noreferrer"
				class="text-morphit-emerald hover:underline"
			>
				RUN-A-MORPHIT-NODE.md
			</a>.
		</p>

		<p class="mt-3 text-sm text-ink-600 dark:text-ink-400">
			{$_('run_a_node.runbook_pointer')}
			<a
				href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/OPERATIONS.md"
				target="_blank" rel="noopener noreferrer"
				class="text-morphit-emerald hover:underline"
			>
				OPERATIONS.md
			</a>.
		</p>
	</section>

	<!-- Item 3 / Part 121 cp6 — operator-stance surfacing.
	     A prospective operator reading this page should know that
	     asset-policy specialization is a degree of freedom they
	     have (Memory #25 + REVISIT §A): every new tradable asset
	     ships default-ON instance-wide; operators opt OUT via
	     MORPHIT_INDEXER_DISABLED_ASSETS.  Federation note: peer
	     instances' orders still appear regardless — the gate is
	     only on new orders posted from THIS operator's instance. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">
			{$_('run_a_node.asset_policy_heading')}
		</h2>
		<p class="mt-4 text-ink-700 dark:text-ink-300">
			{$_('run_a_node.asset_policy_body')}
		</p>
		<ul class="mt-4 space-y-3 text-ink-700 dark:text-ink-300">
			<li class="flex gap-3">
				<span class="text-morphit-emerald" aria-hidden="true">✓</span>
				<span>
					<strong>{$_('run_a_node.asset_policy_default_label')}</strong>
					{$_('run_a_node.asset_policy_default_body')}
				</span>
			</li>
			<li class="flex gap-3">
				<span class="text-morphit-emerald" aria-hidden="true">✓</span>
				<span>
					<strong>{$_('run_a_node.asset_policy_opt_out_label')}</strong>
					{$_('run_a_node.asset_policy_opt_out_body')}
				</span>
			</li>
			<li class="flex gap-3">
				<span class="text-morphit-emerald" aria-hidden="true">✓</span>
				<span>
					<strong>{$_('run_a_node.asset_policy_federation_label')}</strong>
					{$_('run_a_node.asset_policy_federation_body')}
				</span>
			</li>
		</ul>
		<p class="mt-4 text-sm text-ink-600 dark:text-ink-400">
			{$_('run_a_node.asset_policy_doc_pointer')}
			<a
				href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/OPERATIONS.md"
				target="_blank" rel="noopener noreferrer"
				class="text-morphit-emerald hover:underline"
			>
				OPERATIONS.md
			</a>
			{$_('run_a_node.asset_policy_doc_pointer_suffix')}
		</p>
	</section>

	<!-- Requirements: hardware floor + networking. Written to be
		 honest rather than aspirational; a would-be operator
		 should know what they're signing up for. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">
			{$_('run_a_node.requirements_heading')}
		</h2>
		<dl class="mt-6 grid gap-4 md:grid-cols-3">
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_hw_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_hw_value')}
				</dd>
			</div>
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_network_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_network_value')}
				</dd>
			</div>
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_time_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_time_value')}
				</dd>
			</div>
		</dl>
	</section>

	<section
		class="mt-14 flex flex-wrap items-center justify-center gap-3 rounded-3xl border border-ink-200 bg-white p-8 text-center dark:border-ink-800 dark:bg-ink-900"
	>
		<div class="w-full">
			<h2 class="font-display text-2xl font-bold">
				{$_('run_a_node.cta_heading')}
			</h2>
			<p class="mt-3 text-ink-700 dark:text-ink-300">{$_('run_a_node.cta_body')}</p>
		</div>
		<a href="https://git.agorise.net/agorise/morphit" target="_blank" rel="noopener noreferrer" class="btn-primary btn-shine">
			{$_('run_a_node.cta_repo')}
		</a>
		<a
			href={lp('/operators')}
			class="rounded-xl border border-ink-300 px-5 py-3 font-semibold text-ink-800 hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:text-ink-200"
		>
			{$_('run_a_node.cta_directory')}
		</a>
	</section>
</section>
