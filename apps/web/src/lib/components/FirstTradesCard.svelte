<script lang="ts">
	/**
	 * FirstTradesCard — the homepage's invitation to sign in and make a first
	 * few trades (v1.21.5; replaces the "Run your own Morphit site" card, whose
	 * place is the footer and /run-a-node).
	 *
	 * Branded sites: every colour is a theme token (src/theme.css), so an
	 * operator's `morphit-ops branding apply` colours re-tint the whole card,
	 * glow and border included.
	 *
	 * Truth: the reward tiles are the rewards this site's relay actually pays
	 * (RewardsPanel's sources: apps/relay create.ts — the account and its 2
	 * BLURT; handlers/order.ts — the free first buy; handlers/feedback.ts — the
	 * 10 + 10 first-trade bonus). A site without an operator tag pays none of
	 * them, so there the tiles are left out and the card speaks only of how
	 * trading works.
	 *
	 * Motion: a slow rotating light on the border, two drifting glows and the
	 * tiles' gentle float — CSS only (no JavaScript animation loop), and all of
	 * it stops for `prefers-reduced-motion: reduce`.
	 */
	import { page } from '$app/stores';
	import { _ } from 'svelte-i18n';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { instance } from '$stores/instance';
	import { hasAnySession } from '$stores/identity';
	import { hasPersistedKeystore } from '$crypto/persistentKeystore';

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	/** Rewards are paid by the relay of a site with an operator tag (RewardsPanel). */
	const paysRewards = $derived($instance.loaded && $instance.operator_tag !== null);

	// Someone with an account on this device (signed in, or locked) is sent to
	// trade, not to sign up — the same rule as the hero's "Start trading".
	let keystorePersisted = $state(false);
	$effect(() => {
		void $hasAnySession;
		keystorePersisted = hasPersistedKeystore();
	});
	const hasAccount = $derived($hasAnySession || keystorePersisted);

	const STEPS = ['account', 'find', 'trade'] as const;
	const REWARDS = ['free_account', 'free_buy', 'first_trade'] as const;
</script>

<section class="ftc mx-auto mt-16 max-w-4xl" aria-labelledby="first-trades-heading">
	<div class="ftc-border" aria-hidden="true"></div>
	<div class="ftc-face">
		<div class="ftc-glow ftc-glow-a" aria-hidden="true"></div>
		<div class="ftc-glow ftc-glow-b" aria-hidden="true"></div>
		<div class="ftc-dots" aria-hidden="true"></div>

		<div class="relative px-6 py-10 text-center sm:px-10 md:py-12">
			<p class="ftc-eyebrow">{$_('home.first_trades.eyebrow')}</p>
			<h2
				id="first-trades-heading"
				class="mt-4 font-display text-3xl font-extrabold leading-tight tracking-tight md:text-4xl"
			>
				<span class="ftc-title">{$_('home.first_trades.heading')}</span>
			</h2>
			<p class="mx-auto mt-4 max-w-2xl text-lg text-ink-700 dark:text-ink-200">
				{$_('home.first_trades.body')}
			</p>

			<ol class="mx-auto mt-8 grid max-w-3xl gap-3 text-left sm:grid-cols-3">
				{#each STEPS as step, i (step)}
					<li class="ftc-step">
						<span class="ftc-step-num" aria-hidden="true">{i + 1}</span>
						<span>
							<strong class="block text-ink-900 dark:text-ink-50"
								>{$_(`home.first_trades.step_${step}_title`)}</strong
							>
							<span class="text-sm text-ink-700 dark:text-ink-300"
								>{$_(`home.first_trades.step_${step}_body`)}</span
							>
						</span>
					</li>
				{/each}
			</ol>

			{#if paysRewards}
				<ul
					class="mx-auto mt-6 grid max-w-3xl gap-3 sm:grid-cols-3"
					data-testid="first-trades-rewards"
				>
					{#each REWARDS as reward, i (reward)}
						<li class="ftc-reward" style="animation-delay: {i * -2}s">
							<span class="ftc-reward-value">{$_(`home.first_trades.reward_${reward}_value`)}</span>
							<span class="mt-1 block text-sm text-ink-700 dark:text-ink-300"
								>{$_(`home.first_trades.reward_${reward}_body`)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="mt-8 flex flex-wrap items-center justify-center gap-3">
				{#if hasAccount}
					<a href={lp('/post')} class="btn-primary btn-shine" data-testid="first-trades-primary"
						>{$_('home.first_trades.cta_post')}</a
					>
					<a href={lp('/orderbook')} class="btn-secondary">{$_('home.first_trades.cta_browse')}</a>
				{:else}
					<a
						href={lp('/onboarding')}
						class="btn-primary btn-shine"
						data-testid="first-trades-primary"
						>{paysRewards
							? $_('home.first_trades.cta_signup_free')
							: $_('home.first_trades.cta_signup')}</a
					>
					<a href={lp('/login')} class="btn-secondary">{$_('home.first_trades.cta_login')}</a>
				{/if}
			</div>
		</div>
	</div>
</section>

<style>
	/* A rotating band of light along the border. The angle is a registered
	 * property so it can be animated; a browser without @property shows the
	 * same gradient, still. */
	@property --ftc-angle {
		syntax: '<angle>';
		inherits: false;
		initial-value: 0deg;
	}

	.ftc {
		position: relative;
		isolation: isolate;
		border-radius: 1.75rem;
		padding: 2px;
	}

	.ftc-border {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: conic-gradient(
			from var(--ftc-angle),
			rgb(var(--brand-1-rgb) / 0.15),
			rgb(var(--brand-1-rgb)),
			rgb(var(--brand-2-rgb)),
			rgb(var(--brand-3-rgb)),
			rgb(var(--brand-3-rgb) / 0.15) 60%,
			rgb(var(--brand-1-rgb) / 0.15)
		);
		animation: ftc-spin 9s linear infinite;
		z-index: -1;
	}
	/* The same light, blurred, as a soft halo around the card. */
	.ftc-border::after {
		content: '';
		position: absolute;
		inset: -10px;
		border-radius: inherit;
		background: inherit;
		filter: blur(22px);
		opacity: 0.35;
	}

	.ftc-face {
		position: relative;
		overflow: hidden;
		border-radius: calc(1.75rem - 2px);
		background: rgb(var(--surface-950-rgb));
	}

	.ftc-glow {
		position: absolute;
		width: 26rem;
		height: 26rem;
		border-radius: 9999px;
		filter: blur(70px);
		opacity: 0.22;
		pointer-events: none;
	}
	.ftc-glow-a {
		top: -10rem;
		left: -8rem;
		background: rgb(var(--brand-1-rgb));
		animation: ftc-drift-a 18s ease-in-out infinite alternate;
	}
	.ftc-glow-b {
		bottom: -12rem;
		right: -8rem;
		background: rgb(var(--brand-3-rgb));
		animation: ftc-drift-b 22s ease-in-out infinite alternate;
	}

	/* A faint field of dots, fading toward the edges. */
	.ftc-dots {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(rgb(var(--brand-2-rgb) / 0.18) 1px, transparent 1.5px);
		background-size: 22px 22px;
		mask-image: radial-gradient(ellipse at center, rgb(var(--surface-950-rgb)), transparent 70%);
		-webkit-mask-image: radial-gradient(
			ellipse at center,
			rgb(var(--surface-950-rgb)),
			transparent 70%
		);
		pointer-events: none;
	}

	.ftc-eyebrow {
		display: inline-block;
		border-radius: 9999px;
		border: 1px solid rgb(var(--brand-2-rgb) / 0.45);
		background: rgb(var(--brand-2-rgb) / 0.1);
		padding: 0.25rem 0.9rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: rgb(var(--brand-primary-rgb));
	}

	/* The heading in the brand gradient, with a slow sweep of light across it. */
	.ftc-title {
		background: linear-gradient(
			100deg,
			rgb(var(--brand-1-rgb)) 0%,
			rgb(var(--brand-2-rgb)) 35%,
			rgb(var(--surface-50-rgb)) 50%,
			rgb(var(--brand-2-rgb)) 65%,
			rgb(var(--brand-3-rgb)) 100%
		);
		background-size: 250% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: ftc-sheen 7s ease-in-out infinite;
	}

	.ftc-step {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		border-radius: 1rem;
		border: 1px solid rgb(var(--surface-700-rgb) / 0.7);
		background: rgb(var(--surface-900-rgb) / 0.6);
		padding: 0.9rem 1rem;
	}
	.ftc-step-num {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		border-radius: 9999px;
		background: var(--morphit-gradient);
		color: rgb(var(--surface-950-rgb));
		font-weight: 800;
	}

	.ftc-reward {
		border-radius: 1rem;
		border: 1px solid rgb(var(--brand-2-rgb) / 0.35);
		background: linear-gradient(
			160deg,
			rgb(var(--brand-1-rgb) / 0.1),
			rgb(var(--brand-3-rgb) / 0.08)
		);
		padding: 1rem;
		animation: ftc-float 6s ease-in-out infinite;
	}
	.ftc-reward-value {
		display: block;
		font-family: var(--font-display, inherit);
		font-size: 1.15rem;
		font-weight: 800;
		color: rgb(var(--brand-primary-rgb));
	}

	@keyframes ftc-spin {
		to {
			--ftc-angle: 360deg;
		}
	}
	@keyframes ftc-drift-a {
		to {
			transform: translate(6rem, 4rem) scale(1.1);
		}
	}
	@keyframes ftc-drift-b {
		to {
			transform: translate(-5rem, -3rem) scale(1.15);
		}
	}
	@keyframes ftc-sheen {
		0%,
		100% {
			background-position: 100% 0;
		}
		50% {
			background-position: 0% 0;
		}
	}
	@keyframes ftc-float {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ftc-border,
		.ftc-glow,
		.ftc-title,
		.ftc-reward {
			animation: none;
		}
	}
</style>
