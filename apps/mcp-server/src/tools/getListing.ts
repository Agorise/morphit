/**
 * Tool: morphit_get_listing
 *
 * Fetch the full detail of one order, given its (account, permlink)
 * pair.  Use this when the user has narrowed in on a specific
 * listing from searchOrders and the agent needs to surface its
 * full terms, payment-method specifics, etc.
 *
 * Also returns a deeplink to the order detail page so the agent
 * can hand the user off cleanly.
 */

import { z } from 'zod';
import { buildV1Url, fetchJson, getInstanceUrl } from '../indexerClient.js';

export const GET_LISTING_DESCRIPTION =
	'Fetch the full detail of one Morphit listing by its (account, ' +
	'permlink) pair. Use when the user has narrowed in on a specific ' +
	'listing from morphit_search_orders results.';

export const GetListingInputSchema = z.object({
	account: z
		.string()
		.min(3)
		.max(16)
		.regex(/^[a-z][a-z0-9.-]{2,15}$/)
		.describe(
			'The Blurt account that posted the listing. Lowercase letters, ' +
				'digits, hyphens, periods only — Blurt account-name rules.'
		),
	permlink: z
		.string()
		.min(3)
		.max(256)
		.regex(/^[a-z0-9][a-z0-9-]{2,255}$/)
		.describe(
			'The listing\'s permlink (per-listing identifier on chain). ' +
				'Lowercase, digits, hyphens.'
		)
});

export type GetListingInput = z.infer<typeof GetListingInputSchema>;

export async function getListing(input: GetListingInput): Promise<{
	listing: Record<string, unknown>;
	deeplink: string;
	note: string;
}> {
	// /v1/orders/:account returns all of that account's orders; we
	// filter for the matching permlink in this server (one extra
	// hop, but cleaner than depending on a per-permlink endpoint
	// shape that may not exist).
	const url = buildV1Url(`/orders/${encodeURIComponent(input.account)}`);
	const res = await fetchJson<{ rows: Array<Record<string, unknown>> }>(url);
	const match = (res.rows || []).find((r) => r.permlink === input.permlink);
	if (!match) {
		throw new Error(
			`No live listing found for account "${input.account}" with permlink ` +
				`"${input.permlink}" on the configured instance. The listing may ` +
				`have been cancelled, replaced, or never existed on this instance.`
		);
	}

	// cp146 F-mcp-13 — use getInstanceUrl() for the same validation
	// + DRY reasons as searchOrders.
	// cp146 F-mcp-12 — build the deeplink via URL so any future
	// change to the account/permlink validation grammar can't
	// introduce path-component injection.  Zod already constrains
	// `input.account` and `input.permlink` to safe character sets,
	// but the URL builder is the right structural defense in depth.
	//
	// cp156 F-mcp-7 — route through `${base}/?then=...` so the
	// root locale-detection shell adds the user's locale prefix.
	// Before cp156, hardcoded `/en/` gave non-English users the
	// English listing page even though the page itself is
	// translated for every supported locale.
	const innerPath = `/@${input.account}/${input.permlink}`;
	const deeplinkUrl = new URL('/', getInstanceUrl());
	deeplinkUrl.searchParams.set('then', innerPath);
	const deeplink = deeplinkUrl.toString();

	return {
		listing: match,
		deeplink,
		note:
			'To reply to this listing, the user should open the deeplink in ' +
			'their browser, unlock or create their Morphit identity, and click ' +
			"the listing's \"Reply\" button to open an encrypted chat with " +
			'the lister. From there the two parties coordinate fiat payment + ' +
			'crypto delivery directly — Morphit never custodies funds.'
	};
}
