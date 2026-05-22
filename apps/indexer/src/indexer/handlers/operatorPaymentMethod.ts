/**
 * Handler: morphit_payment_method_addition_v1  (Batch L / ADR-0021)
 *
 * Payload shape (validated):
 *   {
 *     v: 1,
 *     action: "add" | "remove",
 *     key: <[a-z][a-z0-9_]+, 3-24 chars>,
 *     name: <string, 1-64 chars>,             // required for "add"
 *     description: <string, ≤300 chars>,      // required for "add"
 *     category: "crypto" | "in_person" | "online",  // required for "add"
 *     url: <string|null, https:// only>,      // optional, "add" only
 *     ts: <unix seconds>
 *   }
 *
 * Effect: if `ctx.signer === ctx.config.operatorAccountName`, record
 * (or mark removed) an instance-level payment-method addition.
 * Anyone else's signature is rejected with `not_operator` — same
 * trust gate as operator-block.
 *
 * Storage: `instance_payment_methods` table.  Keyed on
 * (operator, key); state flips between 'active' and 'removed' but
 * the row persists for audit trail.
 *
 * Reserved keys: the handler refuses to add any key that collides
 * with a canonical key from the frontend registry (see
 * RESERVED_CANONICAL_KEYS below).  The reserved list is duplicated
 * here from apps/web/src/lib/payments/registry.ts following the
 * codebase's "duplicate constants across independently-deployable
 * apps" convention.  Adding a canonical entry → update both files.
 *
 * Sanitization: name and description go through the same
 * bidi/zero-width strip applied to operator-block reasons (audit
 * finding #10 from Batch I).  We strip rather than reject to
 * accommodate operators copy-pasting from elsewhere.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

const KEY_RE = /^[a-z][a-z0-9_]+$/;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 300;
const MIN_KEY_LEN = 3;
const MAX_KEY_LEN = 24;
const VALID_CATEGORIES: ReadonlySet<string> = new Set(['crypto', 'in_person', 'online']);

/** Reserved canonical keys — operators cannot create instance
 *  additions that would shadow these.  Kept in sync with
 *  apps/web/src/lib/payments/registry.ts.  When adding a new
 *  canonical entry, update BOTH this constant AND the frontend
 *  registry.  A tested smoke verifies the two match (see
 *  apps/indexer/scripts/payment-method-handler-smoke.ts). */
const RESERVED_CANONICAL_KEYS: ReadonlySet<string> = new Set([
	// Crypto
	'pay_btc',
	'pay_blurt',
	'pay_xmr',
	'pay_usdt',
	'pay_usdc',
	'pay_dai',
	'pay_bch',
	'pay_ltc',
	'pay_dash',
	'pay_doge',
	'pay_zec',
	'pay_arrr',
	'pay_dcr',
	'pay_sol',
	'pay_eth',
	'pay_xrp',
	// In Person
	'barter_goods',
	'cash',
	'precious_metals',
	// Online
	'airwallex',
	'alipay',
	'amazon_pay',
	'apple_pay',
	'bancontact',
	'bitso',
	'bizum',
	'blik',
	'cash_app',
	'gcash',
	'google_pay',
	'ideal',
	'interac_etransfer',
	'klarna',
	'mpesa',
	'mercado_pago',
	'mir',
	'mtn_momo',
	'oxxo_pay',
	'payoneer',
	'paypal',
	'paytm',
	'payu',
	'pix',
	'przelewy24',
	'revolut',
	'shaparak',
	'shebapay',
	'sofort',
	'spei',
	'square_cash',
	'unionpay',
	'venmo',
	'wechat_pay',
	'wise',
	'zelle'
]);

/** Codepoints stripped from operator-supplied name + description.
 *  Same set as operator-block.ts; duplicated here to avoid a
 *  shared dep across independently-deployable apps.  Covers
 *  bidi-override and zero-width characters. */
const STRIP_CODEPOINTS_RE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff]/g;

function sanitize(s: string): string {
	return s.replace(STRIP_CODEPOINTS_RE, '').trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	// Gate: only the configured operator account can sign these.
	// Uses operatorAccountName (per-instance) — same trust gate as
	// operatorBlock; see B3 audit note.
	if (ctx.signer !== ctx.config.operatorAccountName) {
		return { ok: false, reason: 'not_operator' };
	}

	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	if (ctx.payload.v !== 1) {
		return { ok: false, reason: 'unsupported_version' };
	}

	const action = ctx.payload.action;
	if (action !== 'add' && action !== 'remove') {
		return { ok: false, reason: 'action_invalid' };
	}

	const key = ctx.payload.key;
	if (typeof key !== 'string') {
		return { ok: false, reason: 'key_invalid' };
	}
	// P6-10 audit hardening: length check before regex.
	if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN) {
		return { ok: false, reason: 'key_length_invalid' };
	}
	if (!KEY_RE.test(key)) {
		return { ok: false, reason: 'key_invalid' };
	}
	if (RESERVED_CANONICAL_KEYS.has(key)) {
		return { ok: false, reason: 'key_reserved' };
	}

	if (action === 'remove') {
		// Mark existing as removed.  Idempotent — already-removed
		// stays removed.
		const existing = await client.query<{ state: string }>(
			`SELECT state FROM instance_payment_methods WHERE operator = $1 AND key = $2`,
			[ctx.signer, key]
		);
		if (existing.rows.length === 0) {
			return { ok: false, reason: 'no_prior_addition' };
		}
		if (existing.rows[0]!.state === 'removed') {
			return { ok: true };
		}
		await client.query(
			`UPDATE instance_payment_methods
			    SET state = 'removed',
			        last_action_block_num = $3,
			        updated_at = $4
			  WHERE operator = $1 AND key = $2`,
			[ctx.signer, key, ctx.blockNum, ctx.blockTime]
		);
		return { ok: true };
	}

	// action === 'add'
	const nameRaw = ctx.payload.name;
	if (typeof nameRaw !== 'string' || nameRaw.length === 0) {
		return { ok: false, reason: 'name_invalid' };
	}
	if (nameRaw.length > MAX_NAME_LEN) {
		return { ok: false, reason: 'name_too_long' };
	}
	const name = sanitize(nameRaw);
	if (name.length === 0) {
		return { ok: false, reason: 'name_invalid' };
	}

	const descRaw = ctx.payload.description;
	if (typeof descRaw !== 'string') {
		return { ok: false, reason: 'description_invalid' };
	}
	if (descRaw.length > MAX_DESC_LEN) {
		return { ok: false, reason: 'description_too_long' };
	}
	const description = sanitize(descRaw);

	const category = ctx.payload.category;
	if (typeof category !== 'string' || !VALID_CATEGORIES.has(category)) {
		return { ok: false, reason: 'category_invalid' };
	}

	const urlRaw = ctx.payload.url;
	let url: string | null = null;
	if (urlRaw !== null && urlRaw !== undefined) {
		if (typeof urlRaw !== 'string') {
			return { ok: false, reason: 'url_invalid' };
		}
		if (urlRaw.length > 200) {
			return { ok: false, reason: 'url_too_long' };
		}
		// P6-13 audit fix: parser-based validation rejects
		// userinfo-prefixed URLs (the https://bank.com@evil.com
		// phishing pattern) and malformed shapes.  Mirrors
		// operatorRegister.ts contact_url policy.
		let parsed: URL;
		try {
			parsed = new URL(urlRaw);
		} catch {
			return { ok: false, reason: 'url_invalid' };
		}
		if (parsed.protocol !== 'https:') {
			return { ok: false, reason: 'url_must_be_https' };
		}
		if (parsed.username !== '' || parsed.password !== '') {
			return { ok: false, reason: 'url_has_userinfo' };
		}
		url = urlRaw;
	}

	const existing = await client.query<{ state: string }>(
		`SELECT state FROM instance_payment_methods WHERE operator = $1 AND key = $2`,
		[ctx.signer, key]
	);

	if (existing.rows.length === 0) {
		// Fresh add.
		await client.query(
			`INSERT INTO instance_payment_methods
			   (operator, key, name, description, category, url, state,
			    since_block_num, since_trx_id,
			    last_action_block_num, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, 'active',
			         $7, $8, $7, $9, $9)`,
			[ctx.signer, key, name, description, category, url, ctx.blockNum, ctx.trxId, ctx.blockTime]
		);
		return { ok: true };
	}

	// Existing — re-add (after removal) or amend metadata.
	await client.query(
		`UPDATE instance_payment_methods
		    SET name = $3,
		        description = $4,
		        category = $5,
		        url = $6,
		        state = 'active',
		        last_action_block_num = $7,
		        updated_at = $8
		  WHERE operator = $1 AND key = $2`,
		[ctx.signer, key, name, description, category, url, ctx.blockNum, ctx.blockTime]
	);
	return { ok: true };
};

export default handle;
