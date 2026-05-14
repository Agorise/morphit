/**
 * Morphit indexer — /v1/instance endpoint.
 *
 * Surfaces this instance's per-operator branding for the
 * frontend to display in title bar, homepage, and footer.
 * All fields are optional; frontend has hardcoded fallbacks
 * for unbranded instances ("Morphit" / "A Morphit instance").
 *
 * Response is cached for 5 minutes (Cache-Control: public,
 * max-age=300) — branding is set-and-forget, no need to
 * re-fetch on every page navigation.
 *
 * Includes fee_recipient and relay_account because the
 * frontend already surfaces these in trust-context strings
 * ("operated by @alice"); having them in the same payload
 * saves a /v1/operators round trip on cold-load.
 *
 * Includes operator_tag (REVISIT-LIST item 5) so the frontend
 * can include it in every order op posted from this instance,
 * which credits 90% of BLURT-paid listing fees to the operator.
 */

import { Hono } from 'hono';

import type { Config } from '$config';

export interface InstanceResponse {
	name: string | null;
	tagline: string | null;
	contact_url: string | null;
	alt_networks: {
		tor: string | null;
		lokinet: string | null;
		/** I2P long-form b32 address (`<52-char-base32>.b32.i2p`).
		 *  Always-resolvable form; recommended for every i2p-hosted
		 *  instance. */
		i2p_b32: string | null;
		/** I2P human-readable name (`something.i2p`).  Optional;
		 *  only resolves on routers whose address book has the
		 *  mapping.  An operator may set neither, one, or both. */
		i2p_name: string | null;
		/** Legacy single field — deprecated.  When `i2p_b32` or
		 *  `i2p_name` is set, this is `null`.  Kept on the wire for
		 *  one release cycle so older frontends pointed at this
		 *  endpoint don't break.  Will be removed pre-launch in a
		 *  follow-up; until then, the loader routes the legacy
		 *  config var into the appropriate new field. */
		i2p: string | null;
		nostr: string | null;
	};
	fee_recipient: string;
	relay_account: string;
	/** REVISIT-LIST item 5 — operator earnings.  When non-null,
	 *  the frontend includes this on every order op as
	 *  `operator_tag`, and the indexer credits 90% of BLURT-paid
	 *  listing fees to the operator who registered this tag.
	 *  When null (unbranded instance), orders go out without
	 *  attribution and the treasury keeps 100%.
	 *
	 *  Note: this is the operator-config-declared tag.  It's
	 *  the operator's responsibility to ensure the tag matches
	 *  a registered `morphit_operator_register_v1` op — if the
	 *  tag is unregistered or inactive when an order op lands,
	 *  the attribution module silently no-ops (no credit, no
	 *  payout), and the treasury keeps 100%.  See
	 *  apps/indexer/src/indexer/operatorEarnings.ts. */
	operator_tag: string | null;
	/** Optional SEO override (task #4).  Null = use bundled
	 *  i18n defaults; non-null = render this string verbatim
	 *  in the Head component instead of the localized default. */
	seo: {
		title: string | null;
		description: string | null;
		keywords: string | null;
	};
	/** Frontend chat-link URL templates (Part 109).  Per-instance
	 *  operator-configurable override for the "click a txid in
	 *  chat, open in external explorer" feature.  Null = frontend
	 *  uses its bundled default (mempool.space for BTC,
	 *  xmrchain.net for XMR).  Non-null = template containing
	 *  `{txid}` that the frontend substitutes at render time.
	 *  Privacy posture: this is per-OPERATOR (not per-user),
	 *  because each operator decides what their users' clicks
	 *  send to which third party.  A user who wants different
	 *  behavior chooses a different instance. */
	chat_link_urls: {
		btc: string | null;
		xmr: string | null;
	};
	/** Trade-only assets this instance has DISABLED via the
	 *  `MORPHIT_INDEXER_DISABLED_ASSETS` env var (Memory #25 —
	 *  every new asset ships default-ON instance-wide with
	 *  operator override).  Wire format: array of uppercase
	 *  asset tickers (e.g. `['USDT']` or `['USDT', 'ARRR']`).
	 *  Empty array = this instance accepts every asset in the
	 *  canonical registry.
	 *
	 *  Surface intent: lets the frontend's `/run-a-node` and
	 *  `/operators` pages render a "this instance's asset
	 *  policy" badge so users can self-select an instance that
	 *  matches their preference (privacy-pure operators may
	 *  disable USDT; pragmatic operators leave it on).  ADR-0023
	 *  USDT context + REVISIT-LIST §A recommendation.
	 *
	 *  Note: federation peers still see this instance's USERS
	 *  trade USDT (chain history is shared); the gate is only
	 *  on NEW orders posted FROM this instance.  Cross-instance
	 *  read-only visibility is preserved regardless of operator
	 *  stance. */
	disabled_assets: readonly string[];
}

export function instanceRoute(config: Config): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		const body: InstanceResponse = {
			name: config.instanceName ?? null,
			tagline: config.instanceTagline ?? null,
			contact_url: config.instanceContactUrl ?? null,
			alt_networks: {
				tor: config.instanceTorAddress ?? null,
				lokinet: config.instanceLokinetAddress ?? null,
				i2p_b32: config.instanceI2pB32Address ?? null,
				i2p_name: config.instanceI2pNameAddress ?? null,
				// Deprecated legacy field — left as null when
				// either new field is set; stays populated only
				// when an operator has only the legacy env var
				// (in which case the loader routed it to the
				// b32 or name field per suffix, so this stays
				// null).  Older frontends reading `alt_networks.i2p`
				// will see null and gracefully omit the link;
				// they should upgrade to read the new fields.
				i2p: null,
				nostr: config.instanceNostrPubkey ?? null
			},
			fee_recipient: config.feeRecipient,
			relay_account: config.relayAccount,
			operator_tag: config.instanceOperatorTag ?? null,
			seo: {
				title: config.instanceSeoTitle ?? null,
				description: config.instanceSeoDescription ?? null,
				keywords: config.instanceSeoKeywords ?? null
			},
			chat_link_urls: {
				btc: config.frontendBtcChatLinkUrl ?? null,
				xmr: config.frontendXmrChatLinkUrl ?? null
			},
			disabled_assets: config.disabledAssets
		};
		c.header('Cache-Control', 'public, max-age=300');
		return c.json(body);
	});

	return app;
}
