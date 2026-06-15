<script lang="ts">
	/**
	 * WriteBlockedReadOnly — slot-in replacement for any write-affording
	 * UI element that should be disabled / explained when the current
	 * session is paired-readonly (ADR-0022 QR-pair, Option A).
	 *
	 * Use pattern at every write-action call site:
	 *
	 *   {#if $isPairedReadOnly}
	 *     <WriteBlockedReadOnly variant="post_order" />
	 *   {:else}
	 *     <!-- the normal write button / form / etc. -->
	 *   {/if}
	 *
	 * Or, if the action sits inside a form whose submit handler is
	 * already locked-aware, swap just the CTA:
	 *
	 *   <button disabled={$isPairedReadOnly} ...>...</button>
	 *
	 * Variants name the write context so the body copy can be tuned
	 * to what the user was about to do:
	 *
	 *   - 'post_order'        — post a buy/sell listing
	 *   - 'send_chat'         — send a chat message
	 *   - 'feedback'          — leave feedback (rating)
	 *   - 'feedback_response' — reply to feedback on your profile
	 *   - 'share_address'     — share a payment address in chat
	 *   - 'funds_sent'        — confirm funds-sent in chat
	 *   - 'profile'           — edit profile fields
	 *   - 'register_name'     — register a Blurt account name
	 *   - 'operator_register' — claim an operator tag
	 *   - 'feature_order'     — pay BLURT to feature one of your orders
	 *   - 'cancel_order'      — cancel one of your live orders
	 *   - 'generic'           — fallback / unspecified write
	 *
	 * Layout: a card with brand-emerald accent, mark icon, two-line
	 * copy (heading + body), and a single primary-style action that
	 * deep-links the user back to their phone.  The deep link is a
	 * `web+morphit://` custom protocol URL (registered in
	 * manifest.webmanifest); on the phone it opens the Morphit PWA
	 * to the equivalent flow.  Falls back to a plain text instruction
	 * if no deep link is meaningful for this variant.
	 *
	 * Variant-specific deep links:
	 *   - 'post_order'        → web+morphit:///post[?prefill=...]
	 *   - 'send_chat'         → web+morphit:///chat/<peer>[?order=<permlink>]
	 *   - 'feedback'          → web+morphit:///@<peer>
	 *   - 'feedback_response' → web+morphit:///@<account>   (own profile)
	 *   - 'profile'           → web+morphit:///settings
	 *   - 'register_name'     → web+morphit:///onboarding/register-name
	 *   - 'operator_register' → web+morphit:///run-a-node
	 *   - 'feature_order'     → web+morphit:///my/orders[#feature=<permlink>]
	 *   - 'cancel_order'      → web+morphit:///my/orders[#cancel=<permlink>]
	 *   - other               → web+morphit:///  (open the app)
	 */

	import { _ } from 'svelte-i18n';

	export type WriteVariant =
		| 'generic'
		| 'post_order'
		| 'send_chat'
		| 'feedback'
		| 'feedback_response'
		| 'share_address'
		| 'funds_sent'
		| 'profile'
		| 'register_name'
		| 'operator_register'
		| 'feature_order'
		| 'cancel_order';

	interface Props {
		/** Which write action the user was about to take.  Drives the
		 *  body copy and (where applicable) the deep-link destination. */
		variant: WriteVariant;
		/** Optional peer account name for chat/feedback variants —
		 *  appended to the deep link so the phone opens the right
		 *  conversation. */
		peer?: string | null;
		/** Optional order permlink — same purpose as `peer` for chat
		 *  variants opened from an order detail.  Preserves the
		 *  "which order are we talking about" context across the
		 *  phone handoff. */
		orderPermlink?: string | null;
		/** Optional override for the card density — `inline` renders
		 *  compactly inside a form row, `block` renders as a standalone
		 *  card.  Defaults to `block`. */
		density?: 'inline' | 'block';
	}

	const { variant, peer = null, orderPermlink = null, density = 'block' }: Props = $props();

	const bodyKey = $derived(`paired_readonly.write_blocked_${variant}_body`);

	const deepLink = $derived.by((): string => {
		// `web+morphit://` is the registered protocol handler from
		// manifest.webmanifest.  We use it here to deep-link the user's
		// phone into the right surface — opening Morphit at the
		// orderbook is fine for most variants, but post_order +
		// send_chat benefit from richer landings.  All paths are
		// inside the app; no external destinations.
		if (variant === 'post_order') {
			// When `orderPermlink` is supplied, the user is editing an
			// existing order — deep-link to the edit page on the phone
			// so the right form is open with current values pre-loaded.
			// Without permlink, fall back to the generic /post landing.
			if (orderPermlink) {
				return `web+morphit:///post/edit/${encodeURIComponent(orderPermlink)}`;
			}
			return 'web+morphit:///post';
		}
		if (variant === 'send_chat' && peer) {
			const q = orderPermlink ? `?order=${encodeURIComponent(orderPermlink)}` : '';
			return `web+morphit:///chat/${encodeURIComponent(peer)}${q}`;
		}
		if (variant === 'feedback' && peer) {
			// Two sub-cases:
			//   1. Counterparty-feedback from a chat/profile surface —
			//      `peer` is the counterparty whose profile we land on.
			//      The phone opens to their profile where the user can
			//      rate them.
			//   2. Self-trade-feedback from /my/orders — `peer` is the
			//      user's OWN account (caller convention) and
			//      `orderPermlink` carries the trade.  Routing through
			//      /my/orders#feedback=<permlink> hits the existing
			//      onMount deep-link handler that auto-opens the
			//      LeaveFeedbackForm for that order (same path the
			//      PendingFeedbackReminderBanner uses).
			if (orderPermlink) {
				return `web+morphit:///my/orders#feedback=${encodeURIComponent(orderPermlink)}`;
			}
			return `web+morphit:///@${encodeURIComponent(peer)}`;
		}
		if (variant === 'feedback_response' && peer) {
			// Reply-to-feedback always happens on the user's OWN profile;
			// `peer` here carries the user's own account name so the
			// phone lands on the right profile page where the unanswered
			// feedback list is rendered.
			return `web+morphit:///@${encodeURIComponent(peer)}`;
		}
		if (variant === 'profile') {
			return 'web+morphit:///settings';
		}
		if (variant === 'register_name') {
			return 'web+morphit:///onboarding/register-name';
		}
		if (variant === 'operator_register') {
			return 'web+morphit:///run-a-node';
		}
		if (variant === 'feature_order') {
			// Permlink preserves "which order are we featuring" context
			// across the phone handoff — the /my/orders page already
			// honors `#feature=<permlink>` to auto-open the bid form
			// (mirrors the existing `#feedback=` deep-link pattern from
			// the feedback-reminder banner).
			const h = orderPermlink ? `#feature=${encodeURIComponent(orderPermlink)}` : '';
			return `web+morphit:///my/orders${h}`;
		}
		if (variant === 'cancel_order') {
			const h = orderPermlink ? `#cancel=${encodeURIComponent(orderPermlink)}` : '';
			return `web+morphit:///my/orders${h}`;
		}
		return 'web+morphit:///';
	});
</script>

{#if density === 'inline'}
	<div
		class="inline-flex flex-wrap items-center gap-2 rounded-lg border border-morphit-emerald/30 bg-morphit-emerald/5 px-3 py-2 text-sm text-ink-700 dark:text-ink-200"
		role="note"
	>
		<svg
			class="h-4 w-4 flex-none text-morphit-emerald"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect x="6" y="2" width="12" height="20" rx="2" />
		</svg>
		<span>{$_(bodyKey)}</span>
		<a class="font-semibold text-morphit-emerald hover:underline" href={deepLink}>
			{$_('paired_readonly.write_blocked_action_label')}
		</a>
	</div>
{:else}
	<div
		class="rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-4"
		role="note"
	>
		<div class="flex items-start gap-3">
			<svg
				class="mt-0.5 h-5 w-5 flex-none text-morphit-emerald"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<rect x="6" y="2" width="12" height="20" rx="2" />
			</svg>
			<div class="flex-1">
				<p class="font-semibold text-morphit-teal dark:text-morphit-emerald">
					{$_('paired_readonly.write_blocked_generic_heading')}
				</p>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_(bodyKey)}
				</p>
				<a
					class="mt-3 inline-block rounded-xl border-2 border-morphit-btn bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
					href={deepLink}
				>
					{$_('paired_readonly.write_blocked_action_label')}
				</a>
			</div>
		</div>
	</div>
{/if}
