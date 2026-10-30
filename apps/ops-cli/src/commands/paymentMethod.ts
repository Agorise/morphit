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
 *   morphit-ops payment-method            (interactive list/add/remove menu)
 *
 * The list subcommand reads from local DB and prints the operator's
 * current additions.  The add and remove subcommands sign and
 * broadcast a `morphit_payment_method_addition_v1` op.  Running with
 * no subcommand (and the "Manage payment methods" main-menu item)
 * opens an interactive menu that prompts for the same inputs and
 * reuses these exact add/remove/list paths.
 *
 * Required environment (sourced from morphit.env): MORPHIT_RELAY_ACCOUNT and
 * the relay's active-key file MORPHIT_RELAY_ACTIVE_KEY_FILE — what every
 * install writes, and what `register` signs with. (It used to require
 * MORPHIT_OPERATOR_POSTING_KEY_FILE, which no installer writes, so add and
 * remove always failed — after every question had been asked. That variable
 * is still honoured when an operator has set it.)
 *
 * WHY THE ACTIVE KEY CAN SIGN THIS POSTING-LEVEL OP. The op stays
 * `required_posting_auths: [account]`: the indexer accepts this op ONLY as a
 * posting-authority op signed by the instance's operator account
 * (apps/indexer/src/blurt/verify.ts extractSigner — an op with
 * required_auths is refused as `active_auth_not_allowed` unless it is one of
 * the three fee-bearing ops — and handlers/operatorPaymentMethod.ts: signer
 * === operatorAccountName, which Ansible sets to the relay account). On
 * Blurt, a Steem-derived chain, a posting authority is satisfied by the
 * account's posting, active OR owner keys, so the relay's active key signs it.
 * `register` has always broadcast its posting-level op exactly this way.
 *
 * Reserved keys: the indexer rejects any key that collides with a
 * canonical one (PayPal, Wise, Cash, etc.).  This CLI applies the
 * same check client-side so we don't waste a chain op on a
 * doomed broadcast.
 */

import { existsSync, readFileSync } from 'node:fs';
import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import { unlockRelayKey } from './register.ts';
import { readEffectiveEnv, INDEXER_ENV_FILES, RELAY_ENV_FILES } from '../lib/relayHiddenHeal.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { printChainErrorHelp, broadcastCustomJson, errMsg } from './chainErrors.ts';
import { BroadcastOutcomeUnknownError } from '../lib/chainAccess.ts';
import { withSpinner } from '../init/spinner.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';

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
	// Load the instance env (morphit.env + morphit.config.env) so on-chain
	// settings (relay account, posting-key file) are present even on a
	// systemd deploy where only the unit sources them. OS env wins; this is
	// best-effort under non-sudo (morphit.env is typically root-only).
	loadInstanceEnv(defaultRepoRoot());
	const sub = ctx.positional[0];
	if (sub === 'add') return runAdd(ctx);
	if (sub === 'remove') return runRemove(ctx);
	if (sub === 'list') return runList(ctx);
	if (sub === 'menu' || sub === undefined) return runMenu(ctx);
	console.log(`✗ Unknown subcommand: ${sanitizeForTerm(String(sub))}`);
	console.log('  Usage:');
	console.log(
		'    morphit-ops payment-method add <key> --name <n> --description <d> --category <c> [--url <u>]'
	);
	console.log('    morphit-ops payment-method remove <key>');
	console.log('    morphit-ops payment-method list');
	console.log('    morphit-ops payment-method            (interactive menu)');
	return 1;
}

// ─── interactive menu (the morphit-ops main-menu entry point) ────

/** Interactive list / add / remove loop. This is what the
 *  "Manage payment methods" main-menu item runs (positional
 *  ['menu']), and what a bare `morphit-ops payment-method` runs.
 *  Each action reuses the same validated, confirmed, on-chain
 *  broadcast paths as the scriptable `add` / `remove` / `list`
 *  subcommands — the menu just gathers the inputs by prompting. */
async function runMenu(ctx: PaymentMethodCtx): Promise<number> {
	for (;;) {
		console.log('');
		const choice = await askChoice(
			"Manage the payment methods this site adds to Morphit's built-in list:",
			[
				'List the payment methods this site adds',
				'Add a payment method',
				'Remove a payment method',
				// This leaves the command (the main menu does not come back).
				'Done'
			],
			3
		);
		if (choice === 0) {
			await runList(ctx);
		} else if (choice === 1) {
			await runAddInteractive();
		} else if (choice === 2) {
			await runRemoveInteractive();
		} else {
			return 0;
		}
	}
}

// ─── signing key ─────────────────────────────────────────────────

export interface SigningSetup {
	readonly account: string;
	readonly keyFile: string;
}

/**
 * Can this server sign a payment-method change that the indexer will accept?
 * Checked BEFORE any question is asked. Returns the account and key file, or
 * prints exactly what is wrong and what to do, and returns null.
 *
 * Reads only: the environment loaded from morphit.env, the key file's
 * readability, and the indexer's own settings (which account it accepts
 * payment methods from). PURE apart from those reads, which are injectable.
 */
export function checkSigningSetup(
	deps: {
		readonly env?: NodeJS.ProcessEnv;
		readonly readable?: (path: string) => 'ok' | 'missing' | 'denied';
		readonly indexerOperator?: () => string | null;
		/** The relay service's own key-file setting (its env files). */
		readonly relayKeyFile?: () => string | null;
		readonly print?: (line: string) => void;
	} = {}
): SigningSetup | null {
	const env = deps.env ?? process.env;
	const print = deps.print ?? ((l: string) => console.log(l));
	const readable = deps.readable ?? fileReadable;
	const account = env.MORPHIT_RELAY_ACCOUNT;
	if (!account) {
		print(
			'✗ MORPHIT_RELAY_ACCOUNT is not set — it is defined in morphit.env (root-only), so re-run this command with sudo:'
		);
		print('    sudo morphit-ops payment-method');
		return null;
	}
	// morphit.env first (what `register` reads), then the relay service's own
	// files (/etc/morphit/relay.env carries the same setting on an install).
	const keyFile =
		env.MORPHIT_OPERATOR_POSTING_KEY_FILE ||
		env.MORPHIT_RELAY_ACTIVE_KEY_FILE ||
		(deps.relayKeyFile ?? relayServiceKeyFile)();
	if (!keyFile) {
		print("✗ This server has no key to sign with: MORPHIT_RELAY_ACTIVE_KEY_FILE (the relay's");
		print('  active-key file) is set in neither morphit.env nor /etc/morphit/relay.env, so');
		print('  the relay itself has no key either.  Set the relay up first (the guided');
		print('  install does it): on this server, sudo morphit-ops  →  Install / set up a new node.');
		return null;
	}
	const r = readable(keyFile);
	if (r === 'denied') {
		print(`✗ Can't read the key file ${sanitizeForTerm(keyFile)} as this user.`);
		print('  Run it with sudo: sudo morphit-ops payment-method');
		return null;
	}
	if (r === 'missing') {
		print(`✗ The key file ${sanitizeForTerm(keyFile)} does not exist on this server.`);
		print('  On this server, check which key is installed with: sudo morphit-ops show-key');
		return null;
	}
	// The indexer stores a payment method only when it is signed by the
	// account it treats as this instance's operator.
	const operator = (deps.indexerOperator ?? indexerOperatorAccount)();
	if (operator !== null && operator !== account) {
		print(
			`✗ Your indexer accepts payment methods only from @${sanitizeForTerm(operator)}, but this server signs as`
		);
		print(`  @${sanitizeForTerm(account)} — a change sent now would be ignored.`);
		print(
			'  Set MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME to your relay account in /etc/morphit/indexer.env,'
		);
		print('  then on this server run: sudo systemctl restart morphit-indexer');
		return null;
	}
	return { account, keyFile };
}

function fileReadable(path: string): 'ok' | 'missing' | 'denied' {
	if (!existsSync(path)) return 'missing';
	try {
		readFileSync(path);
		return 'ok';
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing';
	}
}

/** MORPHIT_RELAY_ACTIVE_KEY_FILE as the relay service gets it, or null. */
function relayServiceKeyFile(): string | null {
	try {
		const root = process.env.MORPHIT_ENV_ROOT ?? '';
		return (
			readEffectiveEnv(
				RELAY_ENV_FILES.map((f) => `${root}${f}`),
				['MORPHIT_RELAY_ACTIVE_KEY_FILE']
			).get('MORPHIT_RELAY_ACTIVE_KEY_FILE') || null
		);
	} catch {
		return null;
	}
}

/** What the indexer's own config falls back to when neither account setting
 *  is set (apps/indexer/src/config: MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME
 *  defaults to it, and the operator account defaults to that). */
export const INDEXER_DEFAULT_OPERATOR_ACCOUNT = 'morphit';

/** The account the indexer treats as this instance's operator (its own rule:
 *  MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME, else MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME,
 *  else its built-in default), or null when its settings cannot be read (one
 *  of its env files exists but cannot be read here, or none exists).
 *
 *  It returned null when neither setting was set — "cannot tell" — so an
 *  install whose indexer falls back to the default account was never warned
 *  that its payment-method changes would be ignored (review, 2026-10-29). */
export function indexerOperatorAccount(root = process.env.MORPHIT_ENV_ROOT ?? ''): string | null {
	try {
		const files = INDEXER_ENV_FILES.map((f) => `${root}${f}`);
		const readable = files.map(fileReadable);
		if (readable.includes('denied') || !readable.includes('ok')) return null;
		const e = readEffectiveEnv(files, [
			'MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME',
			'MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME'
		]);
		const op = e.get('MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME');
		if (op) return op;
		return e.get('MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME') || INDEXER_DEFAULT_OPERATOR_ACCOUNT;
	} catch {
		return null;
	}
}

/** A broadcast that may still land: say so, and how to look for it, instead of
 *  "it failed" — sending it again blind would be a second change. */
function printMayStillLand(err: BroadcastOutcomeUnknownError): void {
	console.log(`✗ ${sanitizeForTerm(err.message)}`);
	console.log('');
	console.log("  Before sending it again, look for it: this node's indexer lists the change once");
	console.log('  the chain has made it final. On this server:');
	console.log('    sudo morphit-ops payment-method list');
}

/** Prompt for the fields of a new payment-method addition (with
 *  inline validation so the user can correct mistakes without
 *  aborting), then hand off to runAdd, which re-validates, shows
 *  the confirmation summary, and broadcasts. */
async function runAddInteractive(): Promise<number> {
	// Nothing is asked when it could not be sent anyway.
	if (checkSigningSetup() === null) return 1;
	console.log('');
	console.log('Add a payment method to the list your site offers.');

	let key = '';
	for (;;) {
		const raw = (
			await ask(
				'Short ID for it (lowercase letters, digits and _, e.g. "my_local_bank"; 3–24 characters)'
			)
		).trim();
		if (raw === '') {
			console.log('  ✗ A key is required.\n');
			continue;
		}
		if (!KEY_RE.test(raw)) {
			console.log('  ✗ Must match /^[a-z][a-z0-9_]+$/ (lowercase, start with a letter).\n');
			continue;
		}
		if (raw.length < 3 || raw.length > 24) {
			console.log('  ✗ Must be 3–24 characters.\n');
			continue;
		}
		if (RESERVED_CANONICAL_KEYS.has(raw)) {
			console.log(`  ✗ "${sanitizeForTerm(raw)}" is a reserved canonical key — pick another.\n`);
			continue;
		}
		key = raw;
		break;
	}

	let name = '';
	for (;;) {
		const raw = (await ask('Display name (e.g. "My Local Bank")')).trim();
		if (raw === '') {
			console.log('  ✗ A name is required.\n');
			continue;
		}
		if (raw.length > 64) {
			console.log('  ✗ Too long (max 64).\n');
			continue;
		}
		name = raw;
		break;
	}

	let description = '';
	for (;;) {
		const raw = (await ask('Description (optional, max 300 — Enter to skip)')).trim();
		if (raw.length > 300) {
			console.log('  ✗ Too long (max 300).\n');
			continue;
		}
		description = raw;
		break;
	}

	const categories = ['crypto', 'in_person', 'online'] as const;
	const catIdx = await askChoice('Category:', categories as unknown as string[]);
	const category = categories[catIdx] ?? 'online';

	let url = '';
	for (;;) {
		const raw = (await ask('URL (optional, must start with https:// — Enter to skip)')).trim();
		if (raw === '') break;
		if (!raw.startsWith('https://')) {
			console.log('  ✗ Must start with https://\n');
			continue;
		}
		if (raw.length > 200) {
			console.log('  ✗ Too long (max 200).\n');
			continue;
		}
		url = raw;
		break;
	}

	const flags: Record<string, string> = { name, description, category };
	if (url !== '') flags.url = url;
	return runAdd({ positional: ['add', key], flags });
}

/** List the operator's removable additions, let them pick one,
 *  then hand off to runRemove (which confirms + broadcasts). */
async function runRemoveInteractive(): Promise<number> {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	if (!account) {
		console.log(
			'✗ MORPHIT_RELAY_ACCOUNT is not set — it is defined in morphit.env (root-only), so re-run this command with sudo.'
		);
		return 1;
	}
	if (checkSigningSetup() === null) return 1;
	// Only the ones still offered: a removed one cannot be removed again.
	const rows = (await fetchAdditions(account)).filter((r) => r.state === 'active');
	if (rows.length === 0) {
		console.log('');
		console.log('(this site adds no payment methods, so there is nothing to remove)');
		return 0;
	}
	console.log('');
	const labels = rows.map(
		(r) =>
			`${sanitizeForTerm(r.name)}  [${sanitizeForTerm(r.category)}]  (ID: ${sanitizeForTerm(r.key)})`
	);
	labels.push('Cancel');
	const idx = await askChoice('Which payment method do you want to remove?', labels);
	if (idx === labels.length - 1) {
		console.log('Cancelled.');
		return 0;
	}
	const chosen = rows[idx];
	if (!chosen) {
		console.log('Cancelled.');
		return 0;
	}
	return runRemove({ positional: ['remove', chosen.key], flags: {} });
}

/** Read the operator's instance additions for the remove picker.
 *  Mirrors runList's query but returns rows instead of printing. */
async function fetchAdditions(
	account: string
): Promise<Array<{ key: string; name: string; category: string; state: string }>> {
	const { loadConfig } = await import('../config.ts');
	const { createDatabase } = await import('../db.ts');
	const db = await createDatabase(loadConfig());
	try {
		const result = await withSpinner('Reading your payment methods from the database…', () =>
			db.query<{
				key: string;
				name: string;
				category: string;
				state: string;
			}>(
				`SELECT key, name, category, state
				   FROM instance_payment_methods
				  WHERE operator = $1
				  ORDER BY state DESC, category, name`,
				[account]
			)
		);
		return result.rows;
	} finally {
		await db.close();
	}
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

	// A flag given with no value parses as the string "true" — never store
	// that as a name or description.
	for (const f of ['name', 'description'] as const) {
		if (ctx.flags[f] === 'true') {
			console.log(`✗ --${f} needs a value: --${f} "…"`);
			return 1;
		}
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
		// operator's --category flag value echoed in
		// error.  Sanitize before display.
		console.log(
			`✗ Invalid --category: "${sanitizeForTerm(category)}".  Must be one of: crypto, in_person, online.`
		);
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

	const setup = checkSigningSetup();
	if (setup === null) return 1;
	const { account, keyFile } = setup;

	console.log('');
	console.log(`  Operator:    @${sanitizeForTerm(account)}`);
	console.log(`  Action:      add`);
	console.log(`  Key:         ${sanitizeForTerm(key)}`);
	console.log(`  Name:        ${sanitizeForTerm(name)}`);
	console.log(
		`  Description: ${description.length > 0 ? sanitizeForTerm(description) : '(empty)'}`
	);
	console.log(`  Category:    ${sanitizeForTerm(category)}`);
	console.log(`  URL:         ${url !== null ? sanitizeForTerm(url) : '(none)'}`);
	console.log('');
	console.log('  This op is signed and broadcast on chain.  Other Morphit');
	console.log(
		'  instances will see the addition is namespaced (@instance:' + sanitizeForTerm(key) + ')'
	);
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
		console.log(`✗ Failed to load the relay account's key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	// Audit 2026-05 hardening (NEW-9-13): reassign `wif` to '' in
	// `finally` so the local reference clears as soon as the
	// broadcast returns — even on error. JS strings are immutable
	// so the original byte sequence may persist in heap memory
	// until GC, but we minimize the variable's lifetime and avoid
	// keeping a live reference past the single use.
	let result: { trx_id: string };
	try {
		// on a hidden-only node this goes through the
		// node's own indexer over Tor/I2P and can take a minute, so show a spinner
		// rather than a silent terminal.
		result = await withSpinner('Broadcasting to the chain…', () =>
			broadcastCustomJson({
				account,
				wif,
				opId: 'morphit_payment_method_addition_v1',
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
			})
		);
	} catch (err) {
		if (err instanceof BroadcastOutcomeUnknownError) {
			printMayStillLand(err);
			return 1;
		}
		printChainErrorHelp(errMsg(err), {
			opLabel: 'morphit_payment_method_addition_v1',
			account,
			tag: null,
			keyFile,
			nameEnvVar: 'MORPHIT_INSTANCE_NAME'
		});
		return 1;
	} finally {
		wif = '';
	}

	console.log('');
	console.log('✓ Broadcast successfully.');
	console.log(`  Transaction: ${sanitizeForTerm(result.trx_id)}`);
	console.log('');
	console.log(
		`  Once the indexer ingests this op, the picker will offer "${sanitizeForTerm(name)}"`
	);
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
		console.log(
			`✗ "${sanitizeForTerm(key)}" is a canonical key — operators can\'t remove canonical entries.`
		);
		console.log('  This is a federation-safety guarantee.  See ADR-0021.');
		return 1;
	}

	const setup = checkSigningSetup();
	if (setup === null) return 1;
	const { account, keyFile } = setup;

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
		console.log(`✗ Failed to load the relay account's key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	// Audit 2026-05 hardening (NEW-9-13): see add() for rationale.
	let result: { trx_id: string };
	try {
		// Spinner: see add().
		result = await withSpinner('Broadcasting to the chain…', () =>
			broadcastCustomJson({
				account,
				wif,
				opId: 'morphit_payment_method_addition_v1',
				payload: { v: 1, action: 'remove', key, ts: Math.floor(Date.now() / 1000) }
			})
		);
	} catch (err) {
		if (err instanceof BroadcastOutcomeUnknownError) {
			printMayStillLand(err);
			return 1;
		}
		printChainErrorHelp(errMsg(err), {
			opLabel: 'morphit_payment_method_addition_v1',
			account,
			tag: null,
			keyFile,
			nameEnvVar: 'MORPHIT_INSTANCE_NAME'
		});
		return 1;
	} finally {
		wif = '';
	}

	console.log('');
	console.log('✓ Broadcast successfully.');
	console.log(`  Transaction: ${sanitizeForTerm(result.trx_id)}`);
	return 0;
}

// ─── list ───────────────────────────────────────────────────────

async function runList(_ctx: PaymentMethodCtx): Promise<number> {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	if (!account) {
		console.log(
			'✗ MORPHIT_RELAY_ACCOUNT is not set — it is defined in morphit.env (root-only), so re-run this command with sudo.'
		);
		return 1;
	}

	// Lazy-load config + db to avoid the cost (and the requirement
	// that MORPHIT_OPS_DATABASE_URL be set) for the broadcast-only
	// `add` / `remove` subcommands.
	const { loadConfig } = await import('../config.ts');
	const { createDatabase } = await import('../db.ts');
	const db = await createDatabase(loadConfig());
	try {
		const result = await withSpinner('Reading your payment methods from the database…', () =>
			db.query<{
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
			)
		);
		if (result.rows.length === 0) {
			console.log('(no instance additions configured)');
			return 0;
		}
		console.log('');
		console.log(`Operator: @${sanitizeForTerm(account)}`);
		console.log('');
		for (const row of result.rows) {
			// DB rows from instance_payment_methods could
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

// ─── helpers ─────────────────────────────────────────────────────

/** Unlock the key with `register`'s own helper (unlockRelayKey): a plaintext
 *  WIF as is; an encrypted key file first with the relay's host-sealed
 *  passphrase (nothing to type), else the passphrase is asked, up to three
 *  tries, a wrong one said in plain words, the unlock under the spinner. */
const loadKeyWif = (keyFile: string): Promise<string> => unlockRelayKey(keyFile);
