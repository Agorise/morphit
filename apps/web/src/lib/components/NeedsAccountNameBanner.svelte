<script lang="ts">
	/**
	 * NeedsAccountNameBanner — slim global bar shown when the current
	 * session is fully unlocked (real signing keys in hand) but no Blurt
	 * account name has been set yet.
	 *
	 * Why this exists (cp355): a user can finish the first three signup
	 * steps (generate keys → back up the seed → confirm it), at which
	 * point the session is BOOTED, and then skip the final "claim a name"
	 * step (register-name) — which is deliberately skippable so signup
	 * survives a relay that's temporarily out of liquid BLURT, and so the
	 * user can look around before committing. The same accountless-but-
	 * unlocked state also arises when a seed/keyfile import can't auto-
	 * resolve the name (ambiguous key / an RPC without get_key_references /
	 * a rotated key) and the user wanders off before completing the
	 * Settings account-name card.
	 *
	 * Without a constant signal, that state reads as a BUG: you're "signed
	 * in" yet every order is gated and the per-row Message buttons are
	 * invisible, with no global explanation. This bar makes the state part
	 * of the chrome — present on every page until a name is set — so it
	 * never feels broken. It mirrors PairedReadOnlyBanner, the analogous
	 * "signed in but can't write" persistent bar.
	 *
	 * The CTA points at /onboarding/register-name (claim a new name — the
	 * common signup-skip case). That page carries an "already have a Blurt
	 * account?" link to the Settings verify card for import users, so this
	 * single CTA serves both populations.
	 *
	 * Hidden when:
	 *   - not fully unlocked (signed out, locked, or paired-readonly — the
	 *     latter has its own banner and always carries an account name)
	 *   - a Blurt account name is set ($blurtAccountName !== null)
	 *   - already ON a setup route (/onboarding/* or /settings) — the
	 *     finish-setup affordance lives there, so the bar would be circular
	 *
	 * Styling: brand-emerald (positive — "you ARE signed in", not an error),
	 * slim, edge to edge, matching PairedReadOnlyBanner.
	 *
	 * A11y: role="status" — informational, not interrupting.
	 */
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { isUnlocked } from '$stores/identity';
	import { blurtAccountName } from '$blurt/ops/profile';

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const pathname = $derived($page.url.pathname);
	// Suppress on the routes that ARE the finish-setup affordance, so the
	// bar never points a user back to the page they're already on.
	const onSetupRoute = $derived(
		pathname.includes('/onboarding/') || /\/settings(\/|$)/.test(pathname)
	);
	const show = $derived($isUnlocked && $blurtAccountName === null && !onSetupRoute);
</script>

{#if show}
	<div
		class="border-b border-morphit-emerald/30 bg-morphit-emerald/10 text-morphit-teal dark:text-morphit-emerald"
		role="status"
	>
		<div
			class="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-xs md:text-sm"
		>
			<span aria-hidden="true">
				<!-- ID-card glyph drawn inline to avoid emoji rendering
				     variance across OSes. -->
				<svg
					class="inline-block h-4 w-4 align-text-bottom"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect x="3" y="5" width="18" height="14" rx="2" />
					<circle cx="8.5" cy="11" r="2" />
					<line x1="13" y1="10" x2="18" y2="10" />
					<line x1="13" y1="14" x2="16" y2="14" />
				</svg>
			</span>
			<span class="font-semibold">{$_('needs_account_name.heading')}</span>
			<span class="text-ink-700 dark:text-ink-200">{$_('needs_account_name.body')}</span>
			<a
				href={localePath('/onboarding/register-name', currentLang)}
				class="font-semibold underline underline-offset-2 hover:no-underline"
			>
				{$_('needs_account_name.cta')}
			</a>
		</div>
	</div>
{/if}
