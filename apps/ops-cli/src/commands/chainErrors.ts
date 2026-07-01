/**
 * Morphit ops CLI — Blurt broadcast error diagnostics (cp178).
 *
 * BACKGROUND — why this module exists.
 * The `register` and `payment-method` subcommands broadcast a
 * signed op to the Blurt chain.  When that fails, the operator
 * used to get the RAW error followed by a STATIC list of four
 * "Common causes" — printed unconditionally, regardless of what
 * actually went wrong.  In practice that was actively misleading:
 *
 *   - A bundler ESM/CJS-interop failure (`Dynamic require of
 *     "stream" is not supported`, swallowed by the import
 *     try/catch) was reported as "@beblurt/dblurt is not
 *     installed.  Run `npm install`" — even though dblurt WAS
 *     installed and reinstalling couldn't fix it.  (The build is
 *     fixed in cp178; this module makes the residual error legible
 *     if anything like it recurs.)
 *   - The on-chain `tag_reserved` rejection (the operator chose an
 *     instance name that slugs to a project-reserved tag like
 *     `morphit`) was lumped under "Tag already claimed by another
 *     account" — close, but wrong: nobody else claimed it, the
 *     project reserves it.
 *
 * This module inspects the error text and prints ONLY the
 * guidance that matches, with specifics (which tag, which account,
 * how much BLURT Power), instead of a guess-list.  When nothing
 * matches, it falls back to a compact "things to check" list — but
 * even that is framed as possibilities, not a verdict.
 *
 * It is deliberately dependency-free and string-based: the dblurt
 * client surfaces chain errors as message strings (often JSON-RPC
 * `assert_exception` bodies), so substring/redex classification is
 * the pragmatic contract.  Each branch is covered by
 * register-diagnostics-smoke.
 */

import { sanitizeForTerm } from '../render/term.ts';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

/** Normalize an unknown thrown value to a string message. */
export function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Broadcast a single `custom_json` op to the Blurt chain, trying
 * each RPC endpoint in turn (cp182).
 *
 * Returns the trx id only.  blurtd's async `broadcast_transaction`
 * does NOT return a block number — dblurt's TransactionConfirmation
 * is `{ id, ...errorFields }`, and `block_num` lives only on the
 * SIGNED tx input, never on the confirmation — so any caller that
 * tried to print `result.block_num` was always printing `undefined`.
 *
 * dblurt also writes its own RPC chatter straight to the console: a
 * "Switched Blurt RPC: …" line (gated by `consoleOnFailover`, which
 * we leave false) and an UNCONDITIONAL
 * `console.error("Didn't failover for error …: [HTTP 429 …]")` on any
 * non-timeout endpoint error.  dblurt only fails over internally on
 * timeout-class errors, so an HTTP 429 from one endpoint makes it
 * throw and THIS loop does the real failover to the next RPC — i.e.
 * that 429 line is expected noise on a path we recover from.  Leaking
 * it to the operator's stdout right next to "broadcast successfully"
 * is alarming and wrong, so we capture console.log/console.error for
 * the duration of the loop, buffer what dblurt emits, and surface it
 * ONLY if every endpoint fails (folded into the thrown error).
 */
export async function broadcastCustomJson(args: {
	account: string;
	wif: string;
	opId: string;
	payload: Record<string, unknown>;
}): Promise<{ trx_id: string }> {
	interface DblurtModule {
		Client: new (
			endpoint: string,
			opts: { addressPrefix: string; chainId: string; consoleOnFailover?: boolean }
		) => {
			broadcast: {
				sendOperations(ops: unknown[], priv: unknown): Promise<{ id: string }>;
			};
		};
		PrivateKey: { fromString(wif: string): unknown };
	}
	let dblurt: DblurtModule;
	try {
		dblurt = (await import('@beblurt/dblurt')) as unknown as DblurtModule;
	} catch (err) {
		// dblurt is bundled into the compiled CLI; an import failure
		// here is almost always an ESM/CJS-interop problem in the
		// bundle, NOT a missing install.  Surface the real cause so the
		// diagnostics layer classifies it correctly.
		throw new Error(`could not load the Blurt broadcast library: ${errMsg(err)}`);
	}

	const endpoints = [...DEFAULT_BLURT_RPC_ENDPOINTS];

	const dblurtNoise: string[] = [];
	const realConsoleLog = console.log;
	const realConsoleError = console.error;
	const capture =
		(sink: (line: string) => void) =>
		(...callArgs: unknown[]): void => {
			sink(callArgs.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
		};

	let lastError: unknown = null;
	try {
		console.log = capture((l) => dblurtNoise.push(l));
		console.error = capture((l) => dblurtNoise.push(l));
		for (const endpoint of endpoints) {
			try {
				const client = new dblurt.Client(endpoint, {
					addressPrefix: 'BLT',
					chainId: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
					consoleOnFailover: false
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
						id: args.opId,
						json: JSON.stringify(args.payload)
					}
				];
				const priv = dblurt.PrivateKey.fromString(args.wif);
				const result = await client.broadcast.sendOperations([op], priv);
				return { trx_id: result.id };
			} catch (err) {
				lastError = err;
				continue;
			}
		}
	} finally {
		console.log = realConsoleLog;
		console.error = realConsoleError;
	}

	const noise = dblurtNoise.length > 0 ? `  (RPC detail: ${dblurtNoise.join(' | ')})` : '';
	throw new Error(
		`all Blurt RPC endpoints rejected the broadcast.  Last error: ${errMsg(lastError)}${noise}`
	);
}

export interface DiagnoseCtx {
	/** The op id being broadcast, e.g. 'morphit_operator_register_v1'. */
	readonly opLabel: string;
	/** The signing account (no leading @). */
	readonly account: string;
	/** The slugged tag, when the op carries one (register). null for ops
	 *  that don't (payment-method). */
	readonly tag: string | null;
	/** Path of the active-key file, for the key-mismatch branch. */
	readonly keyFile: string;
	/** The env var that holds the instance name → tag, for the
	 *  reserved/taken-tag branch's "edit X and re-run" instruction. */
	readonly nameEnvVar: string;
}

/** Coarse category of a broadcast failure, for callers/tests that
 *  want to assert classification without scraping printed text. */
export type ChainErrorKind =
	| 'dependency_unevaluable' // import/require/bundler failure (NOT a real missing install)
	| 'tag_reserved'
	| 'tag_taken'
	| 'invalid_tag' // tag failed a format/length check (too short/long/bad chars)
	| 'invalid_display_name' // display name impersonates a reserved name / bad chars / length
	| 'invalid_origin' // origin URL rejected (loopback/private/path/scheme/etc.)
	| 'already_registered'
	| 'key_mismatch'
	| 'insufficient_rc'
	| 'rpc_unreachable'
	| 'unknown';

/**
 * Approximate BLURT Power needed to transact comfortably.
 *
 * On Blurt the chain's rate-limit fuel is called MANA (the
 * Steem/Hive "resource credits / RC" term is not what Blurt users
 * see).  Mana accrues from BLURT Power (BP) and regenerates fully
 * over ~5 days.  A `custom_json` like the operator ops here is one
 * of the CHEAP operations — far below a >2 KB post.  The exact mana
 * charge floats with chain state and the op's byte size, so we
 * don't print a single fixed mana integer (it would go stale and
 * mislead).  Instead we give an actionable floor: an account with
 * this much BP comfortably covers occasional operator ops with
 * headroom, and regenerates well within a day.
 *
 * This is intentionally conservative (a few BLURT, not fractions),
 * because the failure mode we're guarding against — a near-empty
 * relay account that can't even post its own registration — is
 * cheap to over-provision against and expensive to retry blind.
 */
export const SUGGESTED_BP_FLOOR = 50;

/** Classify a broadcast error message into a coarse kind. */
export function classifyChainError(message: string): ChainErrorKind {
	const m = message.toLowerCase();

	// Bundler / module-eval failures.  These are NOT "package missing"
	// — the dependency is present but the runtime couldn't evaluate it
	// (the cp178 esbuild ESM `require` shim class).  Reinstalling does
	// nothing; a rebuild / report is the fix.
	if (
		m.includes('dynamic require of') ||
		m.includes('is not supported') ||
		m.includes('is not installed') ||
		m.includes('cannot find package') ||
		m.includes('err_module_not_found') ||
		m.includes('err_require_esm')
	) {
		return 'dependency_unevaluable';
	}

	// On-chain handler rejections (assert_exception bodies carry the
	// handler's reason string).  Order matters: the specific reserved /
	// already-claimed cases come before the generic tag-format match.
	if (m.includes('tag_reserved')) return 'tag_reserved';
	if (
		m.includes('tag_already_claimed') ||
		m.includes('tag_taken') ||
		m.includes('tag_already') ||
		m.includes('tag already')
	)
		return 'tag_taken';
	if (m.includes('account_already_registered') || m.includes('already registered'))
		return 'already_registered';
	// Tag format/length failures (operator typo'd or hand-edited the tag).
	if (
		m.includes('tag_too_short') ||
		m.includes('tag_too_long') ||
		m.includes('tag_invalid_chars') ||
		m.includes('tag_not_string')
	)
		return 'invalid_tag';
	// Display-name rejections — most operator-plausible is
	// impersonates_reserved (their display name contains a reserved
	// word like "morphit").
	if (m.includes('display_name_')) return 'invalid_display_name';
	// Origin rejections — loopback/private/link-local (they used a LAN
	// or localhost origin), or path/query/fragment/scheme/userinfo.
	if (m.includes('origin_')) return 'invalid_origin';
	// Contact-url rejections share the origin guidance bucket (both are
	// "fix the URL you configured").
	if (m.includes('contact_url_')) return 'invalid_origin';

	// Key / signature problems.  dblurt raises "private key network id
	// mismatch" for a wrong-network key, and the chain raises
	// missing/invalid posting-authority asserts for a key that isn't
	// the account's.
	if (
		m.includes('network id mismatch') ||
		m.includes('missing posting authority') ||
		m.includes('missing required posting authority') ||
		m.includes('missing authority') ||
		m.includes('signature') ||
		m.includes('invalid private key') ||
		m.includes('non-canonical')
	) {
		return 'key_mismatch';
	}

	// Mana exhaustion.  Blurt's USER-FACING term is "mana"; but the
	// blurtd daemon is forked from Steem, whose low-level assert
	// messages still say "rc" / "resource credit" / "manabar".  Match
	// BOTH so we classify correctly regardless of which the node
	// surfaces — the DISPLAYED guidance always uses Blurt's "mana".
	if (m.includes('mana')) return 'insufficient_rc';
	if (
		m.includes('rc') &&
		(m.includes('insufficient') || m.includes('exceeded') || m.includes('negative'))
	) {
		return 'insufficient_rc';
	}
	if (m.includes('resource credit') || m.includes('not enough rc')) return 'insufficient_rc';

	// Transport.
	if (
		m.includes('all blurt rpc endpoints') ||
		m.includes('econnrefused') ||
		m.includes('enotfound') ||
		m.includes('etimedout') ||
		m.includes('fetch failed') ||
		m.includes('network')
	) {
		return 'rpc_unreachable';
	}

	return 'unknown';
}

/**
 * Print accurate, specific guidance for a broadcast failure.
 * Returns the classified kind (handy for tests / callers).
 *
 * `log` is injectable so tests can capture output; defaults to
 * console.log.
 */
export function printChainErrorHelp(
	rawMessage: string,
	ctx: DiagnoseCtx,
	log: (line: string) => void = (l) => console.log(l)
): ChainErrorKind {
	const safe = sanitizeForTerm(rawMessage);
	const kind = classifyChainError(rawMessage);

	log(`✗ ${ctx.opLabel} broadcast failed: ${safe}`);
	log('');

	switch (kind) {
		case 'dependency_unevaluable':
			log('This is a build/runtime problem, NOT a chain rejection — and');
			log('despite any "not installed" wording, the dependency is present.');
			log('The compiled CLI could not evaluate the Blurt broadcast library');
			log('(an ESM/CommonJS interop failure inside the bundle).');
			log('');
			log('What to do:');
			log('  1. Rebuild the CLI from a clean tree:');
			log('       git pull && npm install && npm run build');
			log('  2. Re-run this command.');
			log('  3. If it still fails with a "Dynamic require" or module-load');
			log('     error, this is a packaging bug — please report it with the');
			log('     full message above (do NOT just reinstall; that will not');
			log('     fix it).');
			break;

		case 'tag_reserved':
			log(`The tag "${sanitizeForTerm(ctx.tag ?? '')}" is reserved by the Morphit`);
			log('project (names like morphit, morphit-relay, agorise are held');
			log('back so nobody can squat a canonical identity — the tag is');
			log('permanent once registered).  Nobody else has "claimed" it; it is');
			log('simply not available to register.');
			log('');
			log('What to do:');
			log(`  - Choose a different instance name.  Edit ${ctx.nameEnvVar}`);
			log('    in your config to something that identifies YOUR node (e.g.');
			log('    your domain or community name), then re-run.  The tag is');
			log('    derived from that name (lower-cased, URL-safe).');
			break;

		case 'tag_taken':
			log(`The tag "${sanitizeForTerm(ctx.tag ?? '')}" is already registered by`);
			log('another operator.  Tags are unique across the federation and');
			log('permanent, so you cannot take one that exists.');
			log('');
			log('What to do:');
			log(`  - Pick a different instance name (edit ${ctx.nameEnvVar}) and`);
			log('    re-run.  Search the /instances directory of any node to see');
			log('    which tags are taken.');
			break;

		case 'invalid_tag':
			log(`The tag "${sanitizeForTerm(ctx.tag ?? '')}" was rejected by the chain's format`);
			log('rules.  A tag must be 1–64 characters, lowercase letters,');
			log('digits, dots, underscores, or hyphens only — nothing else.');
			log('');
			log('What to do:');
			log(`  - Set a valid tag via \`npx morphit-ops edit\` (Operator tag).`);
			log('    Your domain (lowercased) is a safe, valid choice.');
			break;

		case 'invalid_display_name':
			log('Your instance display name was rejected by the chain.  The most');
			log('common cause is that it looks like a reserved Morphit name (for');
			log('example it contains "morphit" or "agorise"); the chain also');
			log('rejects names that are empty, too long (>64 chars), start with');
			log('"@", or contain control/invisible characters.');
			log('');
			log('What to do:');
			log('  - Run `npx morphit-ops edit` and set a display name that');
			log('    identifies your own instance without impersonating a');
			log('    reserved project name, then re-run.');
			break;

		case 'invalid_origin':
			log('The origin (or contact URL) you configured was rejected by the');
			log('chain.  Origins must be a plain public https:// URL — no path,');
			log('query, or fragment, no embedded credentials, and NOT a private,');
			log('loopback, or link-local address (so http://localhost, 127.0.0.1,');
			log('or a 192.168.x.x LAN address will be refused).');
			log('');
			log('What to do:');
			log('  - Run `npx morphit-ops edit` and set MORPHIT_INSTANCE_ORIGIN to');
			log('    your real public site, e.g. https://yourdomain.com (origin');
			log('    only — no trailing path), then re-run.');
			break;

		case 'already_registered':
			log(`The account @${sanitizeForTerm(ctx.account)} is already registered as an`);
			log('operator on-chain.  A second registration for the same account');
			log('is rejected by design — registration is one-time.');
			log('');
			log('What to do:');
			log('  - Nothing, if your details are correct: you are already');
			log('    discoverable.  Check any node\'s /instances page to confirm');
			log(`    @${sanitizeForTerm(ctx.account)} is listed.`);
			log('  - To change your origin/display name/contact later, use the');
			log('    `morphit-ops update` subcommand once it ships (registration');
			log('    details will be editable then; today they are immutable).');
			break;

		case 'key_mismatch':
			log(`The signing key did not satisfy @${sanitizeForTerm(ctx.account)}'s posting`);
			log('authority on chain.  This op is signed with that account\'s');
			log('ACTIVE key; the usual cause is that the key on disk is the wrong');
			log('key (e.g. a posting key was saved instead of the active key, or');
			log('the key belongs to a different account / network).');
			log('');
			log('What to do:');
			log('  - Verify which key is saved by running:');
			log('       npx morphit-ops show-key');
			log('    It prints the PUBLIC key your saved key derives to (it never');
			log('    reveals the private key).  Compare that public key against');
			log(`    the active authority shown for @${sanitizeForTerm(ctx.account)} on a Blurt`);
			log('    block explorer.  If they differ, re-run `npx morphit-ops');
			log('    edit` and supply the correct ACTIVE key.');
			break;

		case 'insufficient_rc':
			log(`@${sanitizeForTerm(ctx.account)} does not have enough mana to broadcast right`);
			log('now.  Mana is Blurt\'s rate-limit fuel for transactions; it');
			log('comes from BLURT Power (BP) and refills fully over about 5 days.');
			log('');
			log('To fix it — either:');
			log('  - Wait a few hours for mana to regenerate (this op is cheap;');
			log('    a partially-recharged account is usually enough); OR');
			log(`  - Power up BLURT into BP on @${sanitizeForTerm(ctx.account)}.  As a`);
			log(`    comfortable floor, ~${SUGGESTED_BP_FLOOR} BP gives this account ample mana`);
			log('    headroom for occasional operator ops with margin to spare.');
			log('    In any Blurt wallet: Wallet → Power Up (or a transfer_to_vesting');
			log('    op).  Note: BP is staked BLURT; powering down later takes ~weeks.');
			break;

		case 'rpc_unreachable':
			log('Could not complete the broadcast against any Blurt RPC node.');
			log('This is a connectivity problem between THIS server and the Blurt');
			log('network, not a problem with your account or keys.');
			log('');
			log('What to do:');
			log('  - Check this server\'s outbound network / DNS and that it can');
			log('    reach https://rpc.blurt.blog (curl it).  Then re-run.');
			log('  - If your firewall restricts egress, allow HTTPS to the Blurt');
			log('    RPC hosts.');
			break;

		case 'unknown':
		default:
			log('The broadcast was rejected and the cause was not recognized.');
			log('Things worth checking:');
			log(`  - Tag availability: is the tag derived from ${ctx.nameEnvVar}`);
			log('    free and not project-reserved? (try a different name)');
			log(`  - Key: does \`npx morphit-ops show-key\` show the active key for`);
			log(`    @${sanitizeForTerm(ctx.account)}?`);
			log(`  - Mana: does @${sanitizeForTerm(ctx.account)} have mana / some BP to transact?`);
			log('  - Connectivity: can this server reach a Blurt RPC node?');
			log('  - If none of these fit, report the full message above.');
			break;
	}

	return kind;
}
