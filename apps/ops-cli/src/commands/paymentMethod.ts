/**
 * Morphit ops CLI — `payment-method` subcommand.  Batch L (ADR-0021).
 *
 * Adds, removes, or lists this instance's payment-method additions.
 * Operators use this to extend the canonical registry with region-
 * specific methods that aren't shipped in the project's source code
 * (e.g. PromptPay for a Thailand-focused instance).
 *
 * Usage:
 *   morphit-ops payment-method add <key> \
 *     --name "<display name>" \
 *     --description "<description>" \
 *     --category online|in_person|crypto \
 *     [--url "https://..."]
 *   morphit-ops payment-method remove <key>
 *   morphit-ops payment-method list
 *
 * The list subcommand reads from local DB and prints the operator's
 * current additions.  The add and remove subcommands sign and
 * broadcast a `morphit_payment_method_addition_v1` op.
 *
 * Required environment (sourced from morphit.env): same as the
 * operator-block command — MORPHIT_RELAY_ACCOUNT plus an operator
 * posting-key file.
 *
 * Reserved keys: the indexer rejects any key that collides with a
 * canonical one (PayPal, Wise, Cash, etc.).  This CLI applies the
 * same check client-side so we don't waste a chain op on a
 * doomed broadcast.
 */

import { readFileSync } from 'node:fs';
import { askPassword, askYesNo } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';

/** Codepoint sanitization — same as operatorBlock + the indexer.
 *  See the operator-block command for rationale. */
const FORBIDDEN_CODEPOINTS = new Set<number>([
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d,
	0xfeff, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064
]);

function sanitize(raw: string): string {
	let out = '';
	for (const ch of raw) {
		const cp = ch.codePointAt(0)!;
		if (FORBIDDEN_CODEPOINTS.has(cp)) continue;
		if (cp >= 0x00 && cp <= 0x1f && cp !== 0x0a && cp !== 0x09) continue;
		if (cp >= 0x7f && cp <= 0x9f) continue;
		out += ch;
	}
	return out;
}

/** Reserved canonical keys.  Mirrors apps/indexer/src/indexer/handlers/
 *  operatorPaymentMethod.ts and apps/web/src/lib/payments/registry.ts.
 *  Drift is caught by reserved-keys-parity-smoke. */
const RESERVED_CANONICAL_KEYS: ReadonlySet<string> = new Set([
	'pay_btc',
	'pay_blurt',
	'pay_xmr',
	'barter_goods',
	'cash',
	'precious_metals',
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

const KEY_RE = /^[a-z][a-z0-9_]+$/;
const VALID_CATEGORIES: ReadonlySet<string> = new Set(['crypto', 'in_person', 'online']);

export interface PaymentMethodCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

export async function runPaymentMethod(ctx: PaymentMethodCtx): Promise<number> {
	const sub = ctx.positional[0];
	if (sub === 'add') return runAdd(ctx);
	if (sub === 'remove') return runRemove(ctx);
	if (sub === 'list') return runList(ctx);
	console.log('✗ Missing subcommand.');
	console.log('  Usage:');
	console.log(
		'    morphit-ops payment-method add <key> --name <n> --description <d> --category <c> [--url <u>]'
	);
	console.log('    morphit-ops payment-method remove <key>');
	console.log('    morphit-ops payment-method list');
	return 1;
}

// ─── add ────────────────────────────────────────────────────────

async function runAdd(ctx: PaymentMethodCtx): Promise<number> {
	const keyRaw = ctx.positional[1];
	if (typeof keyRaw !== 'string' || keyRaw.length === 0) {
		console.log(
			'✗ Missing key.  Usage: payment-method add <key> --name "..." --description "..." --category online'
		);
		return 1;
	}
	const key = keyRaw.trim();
	if (!KEY_RE.test(key)) {
		console.log(`✗ Invalid key: ${sanitizeForTerm(key)}`);
		console.log('  Keys must match /^[a-z][a-z0-9_]+$/ (lowercase, start with letter,');
		console.log('  may contain digits and underscores; 3–24 chars).');
		return 1;
	}
	if (key.length < 3 || key.length > 24) {
		console.log(`✗ Key length out of range: ${key.length} (must be 3–24).`);
		return 1;
	}
	if (RESERVED_CANONICAL_KEYS.has(key)) {
		console.log(`✗ Key "${key}" is a reserved canonical key.`);
		console.log('  This method is already in the canonical registry — your');
		console.log("  instance can't shadow it.  If you want to advocate for a");
		console.log("  change to the canonical entry's metadata, file an issue or");
		console.log('  PR against the project.');
		return 1;
	}

	const nameRaw = (ctx.flags.name ?? '').trim();
	if (nameRaw.length === 0) {
		console.log('✗ --name is required.');
		return 1;
	}
	if (nameRaw.length > 64) {
		console.log(`✗ --name too long (${nameRaw.length}, max 64).`);
		return 1;
	}
	const name = sanitize(nameRaw);
	if (name !== nameRaw) {
		console.log(`⚠  Stripped ${nameRaw.length - name.length} dangerous codepoint(s) from name.`);
	}

	const descRaw = (ctx.flags.description ?? '').trim();
	if (descRaw.length > 300) {
		console.log(`✗ --description too long (${descRaw.length}, max 300).`);
		return 1;
	}
	const description = sanitize(descRaw);
	if (description !== descRaw) {
		console.log(
			`⚠  Stripped ${descRaw.length - description.length} dangerous codepoint(s) from description.`
		);
	}

	const category = (ctx.flags.category ?? '').trim();
	if (!VALID_CATEGORIES.has(category)) {
		// cp139-C-16: operator's --category flag value echoed in
		// error.  Sanitize before display.
		console.log(`✗ Invalid --category: "${sanitizeForTerm(category)}".  Must be one of: crypto, in_person, online.`);
		return 1;
	}

	const urlRaw = ctx.flags.url;
	let url: string | null = null;
	if (typeof urlRaw === 'string' && urlRaw.length > 0) {
		if (!urlRaw.startsWith('https://')) {
			console.log('✗ --url must start with https://');
			return 1;
		}
		if (urlRaw.length > 200) {
			console.log(`✗ --url too long (${urlRaw.length}, max 200).`);
			return 1;
		}
		url = urlRaw;
	}

	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile =
		process.env.MORPHIT_OPERATOR_POSTING_KEY_FILE;
	if (!account) {
		console.log('✗ MORPHIT_RELAY_ACCOUNT is not set.');
		return 1;
	}
	if (!keyFile) {
		console.log('✗ Operator posting key file not configured.');
		return 1;
	}

	console.log('');
	console.log(`  Operator:    @${sanitizeForTerm(account)}`);
	console.log(`  Action:      add`);
	console.log(`  Key:         ${sanitizeForTerm(key)}`);
	console.log(`  Name:        ${sanitizeForTerm(name)}`);
	console.log(`  Description: ${description.length > 0 ? sanitizeForTerm(description) : '(empty)'}`);
	console.log(`  Category:    ${sanitizeForTerm(category)}`);
	console.log(`  URL:         ${url !== null ? sanitizeForTerm(url) : '(none)'}`);
	console.log('');
	console.log('  This op is signed and broadcast on chain.  Other Morphit');
	console.log('  instances will see the addition is namespaced (@instance:' + sanitizeForTerm(key) + ')');
	console.log("  and only this instance's picker will offer it as a selectable");
	console.log('  option.  Cross-instance order filtering still matches by the');
	console.log('  exact namespaced key.');
	console.log('');

	const ok = await askYesNo('Proceed?', false);
	if (!ok) {
		console.log('Aborted.');
		return 0;
	}

	let wif: string;
	try {
		wif = await loadKeyWif(keyFile);
	} catch (err) {
		console.log(`✗ Failed to load posting key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	// Audit 2026-05 hardening (NEW-9-13): reassign `wif` to '' in
	// `finally` so the local reference clears as soon as the
	// broadcast returns — even on error. JS strings are immutable
	// so the original byte sequence may persist in heap memory
	// until GC, but we minimize the variable's lifetime and avoid
	// keeping a live reference past the single use.
	let result: { block_num: number; trx_id: string };
	try {
		result = await broadcastPaymentMethod({
			account,
			wif,
			payload: {
				v: 1,
				action: 'add',
				key,
				name,
				description,
				category,
				url,
				ts: Math.floor(Date.now() / 1000)
			}
		});
	} catch (err) {
		console.log(`✗ Broadcast failed: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	} finally {
		wif = '';
	}

	console.log('');
	console.log(`✓ Posted in block ${result.block_num}.`);
	console.log(`  Transaction: ${sanitizeForTerm(result.trx_id)}`);
	console.log('');
	console.log(`  Once the indexer ingests this op, the picker will offer "${sanitizeForTerm(name)}"`);
	console.log(`  in the ${sanitizeForTerm(category)} category, with the description you provided.`);
	return 0;
}

// ─── remove ─────────────────────────────────────────────────────

async function runRemove(ctx: PaymentMethodCtx): Promise<number> {
	const keyRaw = ctx.positional[1];
	if (typeof keyRaw !== 'string' || keyRaw.length === 0) {
		console.log('✗ Missing key.  Usage: payment-method remove <key>');
		return 1;
	}
	const key = keyRaw.trim();
	if (!KEY_RE.test(key)) {
		console.log(`✗ Invalid key: ${key}`);
		return 1;
	}
	if (RESERVED_CANONICAL_KEYS.has(key)) {
		console.log(`✗ "${sanitizeForTerm(key)}" is a canonical key — operators can\'t remove canonical entries.`);
		console.log('  This is a federation-safety guarantee.  See ADR-0021.');
		return 1;
	}

	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile =
		process.env.MORPHIT_OPERATOR_POSTING_KEY_FILE;
	if (!account) {
		console.log('✗ MORPHIT_RELAY_ACCOUNT is not set.');
		return 1;
	}
	if (!keyFile) {
		console.log('✗ Operator posting key file not configured.');
		return 1;
	}

	console.log('');
	console.log(`  Operator: @${sanitizeForTerm(account)}`);
	console.log(`  Action:   remove`);
	console.log(`  Key:      ${sanitizeForTerm(key)}`);
	console.log('');
	console.log('  Existing orders that referenced this key will keep their');
	console.log('  display name (sourced from chain history); the picker will');
	console.log('  no longer offer it as a selectable option for new orders.');
	console.log('');

	const ok = await askYesNo('Proceed?', false);
	if (!ok) {
		console.log('Aborted.');
		return 0;
	}

	let wif: string;
	try {
		wif = await loadKeyWif(keyFile);
	} catch (err) {
		console.log(`✗ Failed to load posting key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	// Audit 2026-05 hardening (NEW-9-13): see add() for rationale.
	let result: { block_num: number; trx_id: string };
	try {
		result = await broadcastPaymentMethod({
			account,
			wif,
			payload: { v: 1, action: 'remove', key, ts: Math.floor(Date.now() / 1000) }
		});
	} catch (err) {
		console.log(`✗ Broadcast failed: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	} finally {
		wif = '';
	}

	console.log('');
	console.log(`✓ Posted in block ${result.block_num}.`);
	console.log(`  Transaction: ${sanitizeForTerm(result.trx_id)}`);
	return 0;
}

// ─── list ───────────────────────────────────────────────────────

async function runList(_ctx: PaymentMethodCtx): Promise<number> {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	if (!account) {
		console.log('✗ MORPHIT_RELAY_ACCOUNT is not set.');
		return 1;
	}

	// Lazy-load config + db to avoid the cost (and the requirement
	// that MORPHIT_OPS_DATABASE_URL be set) for the broadcast-only
	// `add` / `remove` subcommands.
	const { loadConfig } = await import('../config.ts');
	const { createDatabase } = await import('../db.ts');
	const db = await createDatabase(loadConfig());
	try {
		const result = await db.query<{
			key: string;
			name: string;
			description: string;
			category: string;
			url: string | null;
			state: string;
			updated_at: Date;
		}>(
			`SELECT key, name, description, category, url, state, updated_at
			   FROM instance_payment_methods
			  WHERE operator = $1
			  ORDER BY state DESC, category, name`,
			[account]
		);
		if (result.rows.length === 0) {
			console.log('(no instance additions configured)');
			return 0;
		}
		console.log('');
		console.log(`Operator: @${sanitizeForTerm(account)}`);
		console.log('');
		for (const row of result.rows) {
			// cp139-C-4: DB rows from instance_payment_methods could
			// carry attacker-controlled text in theory (compromised
			// peer instance replicating a chain op with hostile
			// fields, although the indexer's NFC + forbidden-char
			// gate at operatorPaymentMethod handler strips control
			// chars on the way in).  Defense-in-depth: strip again
			// at display.
			const stateMark = row.state === 'active' ? '✓' : '✗';
			console.log(
				`${stateMark} ${sanitizeForTerm(row.key)}  ` +
					`[${sanitizeForTerm(row.category)}]  ${sanitizeForTerm(row.name)}`
			);
			if (row.description.length > 0) {
				console.log(`     ${sanitizeForTerm(row.description)}`);
			}
			if (row.url) {
				console.log(`     ${sanitizeForTerm(row.url)}`);
			}
			console.log(`     state: ${row.state}, updated: ${row.updated_at.toISOString()}`);
			console.log('');
		}
		return 0;
	} finally {
		await db.close();
	}
}

// ─── helpers (mirror operatorBlock.ts) ──────────────────────────

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function loadKeyWif(keyFile: string): Promise<string> {
	const raw = readFileSync(keyFile, 'utf8').trim();
	if (!raw.startsWith('{')) return raw;
	const envelope = JSON.parse(raw);
	const passphrase = await askPassword('Unlock passphrase');
	if (passphrase.length === 0) {
		throw new Error('passphrase required to unlock encrypted keystore');
	}
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(envelope, passphrase);
}

async function broadcastPaymentMethod(args: {
	account: string;
	wif: string;
	payload: Record<string, unknown>;
}): Promise<{ block_num: number; trx_id: string }> {
	interface DblurtModule {
		Client: new (
			endpoint: string,
			opts: { addressPrefix: string; chainId: string }
		) => {
			broadcast: {
				sendOperations(ops: unknown[], priv: unknown): Promise<{ block_num: number; id: string }>;
			};
		};
		PrivateKey: { fromString(wif: string): unknown };
	}
	let dblurt: DblurtModule;
	try {
		dblurt = (await import('@beblurt/dblurt')) as unknown as DblurtModule;
	} catch {
		throw new Error('@beblurt/dblurt is not installed.');
	}

	const endpoints = [
		'https://rpc.blurt.blog',
		'https://blurt-rpc.saboin.com',
		'https://rpc.beblurt.com',
		'https://rpc.blurt.one'
	];

	let lastError: unknown = null;
	for (const endpoint of endpoints) {
		try {
			const client = new dblurt.Client(endpoint, {
				addressPrefix: 'BLT',
				chainId: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
			});
			const op: [
				'custom_json',
				{
					required_auths: string[];
					required_posting_auths: string[];
					id: string;
					json: string;
				}
			] = [
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [args.account],
					id: 'morphit_payment_method_addition_v1',
					json: JSON.stringify(args.payload)
				}
			];
			const priv = dblurt.PrivateKey.fromString(args.wif);
			const result = await client.broadcast.sendOperations([op], priv);
			return { block_num: result.block_num, trx_id: result.id };
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`All RPC endpoints failed.  Last error: ${errMsg(lastError)}`);
}
