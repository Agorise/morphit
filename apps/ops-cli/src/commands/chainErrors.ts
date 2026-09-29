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
import { signOnceAndBroadcast, type ChainAccessDeps } from '../lib/chainAccess.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';

/** Normalize an unknown thrown value to a string message. */
export function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Broadcast a single `custom_json` op to the Blurt chain (v1.20.0, D12).
 *
 * The transaction is built and SIGNED ONCE, locally (the key never leaves this
 * process), then routed by lib/chainAccess.ts:
 *   1. this node's own indexer POST /v1/broadcast (it holds the full 20-node
 *      pool, and treats a duplicate as success);
 *   2. if the indexer cannot carry it AND the node is not hidden-only, the SAME
 *      signed object to a health-ordered EndpointPool over the clearnet list
 *      (condenser_api.broadcast_transaction_synchronous; duplicate = success).
 * A hidden-only node never falls back to clearnet.
 *
 * WHAT IT REPLACED: a for-loop over DEFAULT_BLURT_RPC_ENDPOINTS calling dblurt's
 * `sendOperations` per endpoint, which re-signed on every failover (a new
 * transaction each time) and always started on the same node.
 *
 * Returns the trx id only (a synchronous broadcast knows its block, but callers
 * print the id). Errors keep the strings chainErrors' classifier matches: the
 * chain's own rejection reason, or `all Blurt RPC endpoints rejected the
 * broadcast. Last error: …` when nothing could be reached.
 */
export async function broadcastCustomJson(args: {
	account: string;
	wif: string;
	opId: string;
	payload: Record<string, unknown>;
	/** Test seam: routing dependencies (default: this box's real config). */
	deps?: ChainAccessDeps;
}): Promise<{ trx_id: string }> {
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: [args.account],
			id: args.opId,
			json: JSON.stringify(args.payload)
		}
	];
	try {
		await import('@beblurt/dblurt');
	} catch (err) {
		// dblurt is bundled into the compiled CLI; an import failure here is
		// almost always an ESM/CJS-interop problem in the bundle, NOT a missing
		// install. Surface the real cause so the diagnostics classify it right.
		throw new Error(`could not load the Blurt broadcast library: ${errMsg(err)}`);
	}
	const { trx_id } = await signOnceAndBroadcast({ op, wif: args.wif }, args.deps ?? {});
	return { trx_id };
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
	| 'tag_immutable' // re-register under a DIFFERENT tag than the account's first (rejected, changes nothing)
	| 'already_registered' // legacy: the pre-UPSERT one-time reject (no longer emitted; kept for old error strings)
	| 'key_mismatch'
	| 'insufficient_fee' // not enough LIQUID BLURT to pay the small per-op fee (NOT mana/RC)
	| 'rpc_unreachable'
	| 'unknown';

/**
 * Suggested LIQUID BLURT buffer to keep on an operator account so it can
 * always pay Blurt's small per-operation fee.
 *
 * IMPORTANT — Blurt is NOT Hive/Steem here (see docs/BLURT-CHAIN-MODEL.md).
 * Blurt does NOT gate transactions on RC / mana / bandwidth. Every on-chain
 * op instead costs a small BLURT FEE, deducted from the account's LIQUID
 * balance (the chain computes it from the witness-set `operation_flat_fee`
 * plus a `bandwidth_kbytes_fee` scaled by tx size). Mana on Blurt is
 * VOTING-only and never blocks a broadcast. So the thing an operator account
 * can run short of is LIQUID BLURT to pay the fee — not BP, not mana. Powering
 * up does NOT help transacting (it only raises voting power + APR); if
 * anything it moves BLURT out of the liquid balance the fee is paid from.
 *
 * A `custom_json` like the operator ops here is tiny, so the fee is a small
 * fraction of a BLURT. We suggest keeping a few BLURT liquid as comfortable
 * headroom for occasional operator ops — cheap to over-provision, expensive to
 * retry blind on a near-empty account.
 */
export const SUGGESTED_LIQUID_BLURT_BUFFER = 5;

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
	// The register op is an UPSERT keyed on the account: the ONLY thing it now
	// refuses on a re-register is a CHANGED tag (the tag is immutable). The old
	// one-time `account_already_registered` reject no longer exists on-chain, but
	// we still map its string (an old indexer / cached error) for a clear message.
	if (m.includes('tag_immutable')) return 'tag_immutable';
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

	// Fee / balance shortfall.  Blurt charges a small BLURT fee per op,
	// deducted from the LIQUID balance (it does NOT gate on RC / mana /
	// bandwidth like Hive/Steem — see docs/BLURT-CHAIN-MODEL.md), so the
	// resource an operator account runs short of is liquid BLURT to cover
	// that fee, surfaced as an insufficient-balance / insufficient-funds
	// assert.  We also still catch any leftover Steem-lineage "rc" / "mana"
	// wording defensively (blurtd is forked from Steem) and route it to the
	// SAME fee guidance, because on Blurt the actionable fix is always "keep
	// liquid BLURT for the fee", never "power up for mana".
	if (
		m.includes('insufficient balance') ||
		m.includes('insufficient funds') ||
		m.includes('does not have sufficient') ||
		m.includes('has not enough balance') ||
		m.includes('overdrawn') ||
		((m.includes('fee') || m.includes('balance')) &&
			(m.includes('insufficient') || m.includes('not enough')))
	) {
		return 'insufficient_fee';
	}
	if (
		m.includes('mana') ||
		m.includes('resource credit') ||
		m.includes('not enough rc') ||
		(m.includes('rc') &&
			(m.includes('insufficient') || m.includes('exceeded') || m.includes('negative')))
	) {
		return 'insufficient_fee';
	}

	// Transport.
	if (
		m.includes("node's own indexer") ||
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
			log(`  - Set a valid tag via \`sudo morphit-ops edit\` (Operator tag).`);
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
			log('  - Run `sudo morphit-ops edit` and set a display name that');
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
			log('  - Run `sudo morphit-ops edit` and set MORPHIT_INSTANCE_ORIGIN to');
			log('    your real public site, e.g. https://yourdomain.com (origin');
			log('    only — no trailing path), then re-run.');
			break;

		case 'tag_immutable':
			log(`@${sanitizeForTerm(ctx.account)} is already registered under a DIFFERENT tag.`);
			log('Your federation TAG is permanent once claimed, so a re-register that');
			log('tries to change it is rejected and changes nothing (your display name,');
			log('origin and contact would NOT update).');
			log('');
			log('What to do (on this box):');
			log('  - Run `sudo morphit-ops edit` → Operator tag and set it to the tag you');
			log('    ALREADY registered under, then re-run `sudo morphit-ops register` —');
			log('    that updates your display name / origin / contact / alt addresses.');
			break;

		case 'already_registered':
			// Legacy path: current chain code is an UPSERT, so this reject is no longer
			// emitted. If an old error string reaches here, a re-register would simply
			// UPDATE the mutable fields, so this is not a failure to act on.
			log(`@${sanitizeForTerm(ctx.account)} is already registered as an operator.`);
			log('Re-running register just UPDATES your display name, origin, contact and');
			log('alt addresses (the tag stays fixed) — nothing further is needed.');
			log('');
			log('What to do:');
			log('  - Check any node\'s /instances page to confirm');
			log(`    @${sanitizeForTerm(ctx.account)} is listed with the details you expect.`);
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
			log('       sudo morphit-ops show-key');
			log('    It prints the PUBLIC key your saved key derives to (it never');
			log('    reveals the private key).  Compare that public key against');
			log(`    the active authority shown for @${sanitizeForTerm(ctx.account)} on a Blurt`);
			log('    block explorer.  If they differ, re-run `sudo morphit-ops');
			log('    edit` and supply the correct ACTIVE key.');
			break;

		case 'insufficient_fee':
			log(`@${sanitizeForTerm(ctx.account)} could not cover this operation's fee.  On`);
			log('Blurt every on-chain op costs a small BLURT fee, paid from the');
			log("account's LIQUID balance (a flat fee plus a tiny size-based fee).");
			log('This is NOT mana — Blurt does not gate transactions on mana the');
			log('way Hive/Steem chains do, so powering up does NOT help and can');
			log('make it worse by moving BLURT out of the liquid balance.');
			log('');
			log('To fix it:');
			log(`  - Keep a little LIQUID BLURT on @${sanitizeForTerm(ctx.account)} — a few`);
			log(`    BLURT (≈${SUGGESTED_LIQUID_BLURT_BUFFER}) is ample headroom for occasional operator ops.`);
			log('    Transfer some liquid BLURT to the account (do NOT power it up),');
			log('    then re-run.  If the balance already looks fine, the shortfall');
			log('    may be transient chain state — re-run in a moment.');
			break;

		case 'rpc_unreachable':
			// v1.18.0 deep-deep, H1: on a hidden-only node the broadcast goes through
			// this node's own indexer over Tor/I2P, so "curl a clearnet RPC" is the
			// wrong advice: following it would be the very leak the node avoids.
			if (isHiddenOnlyNode()) {
				log('Could not complete the broadcast. This node is hidden-only, so it');
				log('sends chain requests only through its own indexer, over Tor/I2P,');
				log('and never to a clearnet Blurt node. Nothing is wrong with your');
				log('account or keys; the hidden route was not available just now.');
				log('');
				log('What to do:');
				log('  - Check the indexer is running:  sudo systemctl status morphit-indexer');
				log('  - Check its view of the chain:   sudo morphit-ops doctor');
				log('  - Tor and I2P can take a few minutes to warm up after a restart;');
				log('    wait a little, then re-run this command.');
				break;
			}
			log('Could not complete the broadcast against any Blurt RPC node.');
			log('This is a connectivity problem between THIS server and the Blurt');
			log('network, not a problem with your account or keys.');
			log('');
			log('What to do (on this server):');
			log('  - Check the indexer is running — broadcasts go through it first,');
			log('    and it uses the full Blurt node pool:  sudo systemctl status morphit-indexer');
			log('  - Check this server\'s outbound HTTPS / DNS: `sudo morphit-ops doctor`');
			log('    probes the configured Blurt RPC nodes. Then re-run.');
			log('  - If your firewall restricts egress, allow HTTPS to the Blurt');
			log('    RPC hosts.');
			break;

		case 'unknown':
		default:
			log('The broadcast was rejected and the cause was not recognized.');
			log('Things worth checking:');
			log(`  - Tag availability: is the tag derived from ${ctx.nameEnvVar}`);
			log('    free and not project-reserved? (try a different name)');
			log(`  - Key: does \`sudo morphit-ops show-key\` show the active key for`);
			log(`    @${sanitizeForTerm(ctx.account)}?`);
			log(`  - Fee: does @${sanitizeForTerm(ctx.account)} hold a little liquid BLURT for the`);
			log('    small per-op fee? (Blurt charges a fee, not mana — do not power up.)');
			log('  - Connectivity: can this server reach a Blurt RPC node?');
			log('  - If none of these fit, report the full message above.');
			break;
	}

	return kind;
}
