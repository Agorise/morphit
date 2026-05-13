/**
 * Morphit frontend — instance branding store.
 *
 * Holds this Morphit instance's branding (name, tagline,
 * contact URL, alt-network addresses).  Fetched once from
 * /v1/instance at first browser mount, then cached for the
 * session.
 *
 * Why a Svelte store: components subscribe with $instance.X
 * and re-render when the fetch completes.  No prop-drilling
 * through the layout tree.
 *
 * SSR / prerender note: during build-time prerender, the
 * store is initialized to the fallback shape and never
 * touched.  The actual fetch happens client-side on first
 * mount via initInstance() called from +layout.svelte.
 *
 * Failure mode: if the fetch errors (indexer down, CORS
 * issue, bad response), the store stays at the fallback.
 * Components can detect this via $instance.loaded === false
 * and choose to show a "still loading" or just-default UI.
 */

import { writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { getInstance } from '$indexer/client';

/** Shape held by the store.  Mirrors InstanceResponse plus a
 *  `loaded` flag so components can distinguish "default brand
 *  because that's what this instance configured" from "default
 *  brand because we haven't fetched yet". */
export interface InstanceState {
	readonly name: string | null;
	readonly tagline: string | null;
	readonly contact_url: string | null;
	readonly alt_networks: {
		readonly tor: string | null;
		readonly lokinet: string | null;
		/** I2P long-form b32 address (`<base32>.b32.i2p`).  Always-
		 *  resolvable; recommended for every i2p-hosted instance. */
		readonly i2p_b32: string | null;
		/** I2P human-readable name (`something.i2p`).  Only resolves
		 *  on routers whose address book has the mapping; an
		 *  operator may set neither, one, or both. */
		readonly i2p_name: string | null;
		readonly nostr: string | null;
	};
	readonly fee_recipient: string;
	readonly relay_account: string;
	/** REVISIT-LIST item 5 — operator earnings.  When non-null,
	 *  the post-order form includes this in every order op so
	 *  the indexer credits the operator with 90% of BLURT-paid
	 *  listing fees.  See $blurt/ops/order. */
	readonly operator_tag: string | null;
	readonly seo: {
		readonly title: string | null;
		readonly description: string | null;
		readonly keywords: string | null;
	};
	/** Per-instance chat-link external explorer URL templates
	 *  (Part 109).  Each field is either a `https://…/{txid}…`
	 *  template (operator override) or null (use frontend
	 *  bundled default).  The `urls.ts` lookup checks this
	 *  store first, falls back to the bundled default. */
	readonly chat_link_urls: {
		readonly btc: string | null;
		readonly xmr: string | null;
	};
	readonly loaded: boolean;
}

/** Hardcoded fallback used during SSR and as the post-fetch
 *  default when /v1/instance fails.  Account names match the
 *  canonical reference instance.  Frontend code reading
 *  $instance.name should ALWAYS check for null and fall back
 *  to a literal "Morphit" / `$_('app.tagline')` rather than
 *  trusting the store value, because operators with no branding
 *  configured will return null even after a successful fetch. */
const FALLBACK: InstanceState = {
	name: null,
	tagline: null,
	contact_url: null,
	alt_networks: {
		tor: null,
		lokinet: null,
		i2p_b32: null,
		i2p_name: null,
		nostr: null
	},
	fee_recipient: 'morphit-fees',
	relay_account: 'morphit-relay',
	operator_tag: null,
	seo: { title: null, description: null, keywords: null },
	chat_link_urls: { btc: null, xmr: null },
	loaded: false
};

/** Normalize the alt_networks blob from the /v1/instance fetch
 *  into the post-2026-05 frontend shape (i2p_b32 + i2p_name, no
 *  legacy `i2p`).  Pre-2026-05 indexers send `{tor, lokinet, i2p,
 *  nostr}`; this routes a legacy `i2p` value to either i2p_b32
 *  (if it ends in `.b32.i2p`) or i2p_name (any other `.i2p` suffix).
 *  Drops legacy values that don't match either suffix rather than
 *  guess. */
function normalizeAltNetworksFromWire(an: {
	tor: string | null;
	lokinet: string | null;
	i2p_b32?: string | null;
	i2p_name?: string | null;
	i2p?: string | null;
	nostr: string | null;
}): InstanceState['alt_networks'] {
	let i2pB32 = an.i2p_b32 ?? null;
	let i2pName = an.i2p_name ?? null;
	const legacy = an.i2p ?? null;
	if (legacy !== null && i2pB32 === null && i2pName === null) {
		const lower = legacy.toLowerCase();
		if (lower.endsWith('.b32.i2p')) {
			i2pB32 = legacy;
		} else if (lower.endsWith('.i2p')) {
			i2pName = legacy;
		}
	}
	return {
		tor: an.tor,
		lokinet: an.lokinet,
		i2p_b32: i2pB32,
		i2p_name: i2pName,
		nostr: an.nostr
	};
}

const store = writable<InstanceState>(FALLBACK);

export const instance: Readable<InstanceState> = { subscribe: store.subscribe };

/** Promise that resolves after the first fetch completes (success
 *  or failure).  Components that need the data before rendering
 *  (e.g., the homepage tagline block) await this; the rest just
 *  subscribe and re-render when it lands. */
let initPromise: Promise<void> | null = null;

/** Trigger the one-time fetch.  Idempotent — subsequent calls
 *  return the same promise.  Called from +layout.svelte's onMount. */
export function initInstance(): Promise<void> {
	if (!browser) {
		// SSR: store stays at the fallback.  The actual fetch
		// happens after hydration.
		return Promise.resolve();
	}
	if (initPromise !== null) return initPromise;
	initPromise = (async () => {
		try {
			const result = await getInstance();
			if (result.ok) {
				store.set({
					...result.data,
					alt_networks: normalizeAltNetworksFromWire(result.data.alt_networks),
					operator_tag: result.data.operator_tag ?? null,
					seo: result.data.seo ?? {
						title: null,
						description: null,
						keywords: null
					},
					chat_link_urls: result.data.chat_link_urls ?? {
						btc: null,
						xmr: null
					},
					loaded: true
				});
			} else {
				// Stay at fallback but mark loaded so components don't
				// hold rendering forever.
				store.set({ ...FALLBACK, loaded: true });
			}
		} catch {
			store.set({ ...FALLBACK, loaded: true });
		}
	})();
	return initPromise;
}

/** Test-only: reset the store to fallback and clear the init
 *  promise.  Used by component tests so each test starts fresh. */
export function resetInstanceStore(): void {
	store.set(FALLBACK);
	initPromise = null;
}

/** Synchronous accessor.  Returns the current state without
 *  subscribing.  Components in $derived contexts should use
 *  $instance.X instead; this is for non-reactive lookups
 *  (e.g., one-shot SEO tag generation). */
export function getInstanceSnapshot(): InstanceState {
	return get(store);
}
