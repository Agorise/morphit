/**
 * Morphit ops CLI — `register` subcommand.
 *
 * Publishes this operator's morphit_operator_register_v1 op on
 * the Blurt chain.  Once posted, every other Morphit indexer
 * will see the registration via chain replay and add this
 * instance to their /v1/instances directory.
 *
 * Prerequisite environment (sourced from morphit.env +
 * morphit.config.env per the wizard's file split):
 *   MORPHIT_RELAY_ACCOUNT
 *   MORPHIT_RELAY_ACTIVE_KEY_FILE
 *   MORPHIT_INSTANCE_NAME
 *   MORPHIT_INSTANCE_ORIGIN
 *   MORPHIT_INSTANCE_CONTACT_URL  (optional)
 *
 * Reads keystore from disk; if encrypted, prompts for the
 * unlock passphrase same way the relay does at startup.
 *
 * Idempotent at the chain level: a second register op for the
 * same account is rejected by the on-chain handler with reason
 * 'account_already_registered'.  We surface that as a
 * recognizable error rather than a confusing chain rejection.
 *
 * Dependencies are lazy-imported so the ops-cli's other
 * subcommands (init, status) don't fail to load when dblurt
 * isn't installed yet.  `register` requires `npm install` to
 * have run; without it the lazy import errors with a clear
 * message.
 */

import { readFileSync } from 'node:fs';
import { ask, askPassword, askYesNo } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { printChainErrorHelp, classifyChainError, SUGGESTED_BP_FLOOR } from './chainErrors.ts';
import { isReservedTag } from '../../../indexer/src/indexer/confusables.ts';

export interface RegisterCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

export async function runRegister(_ctx: RegisterCtx): Promise<number> {
	printHeader();

	// ─── 1. Validate env ────
	const env = readEnv();
	if ('error' in env) {
		// cp139-C-8: env.error is built from env-var validation
		// failures; it can include the offending env-var VALUE
		// in the error message ("MORPHIT_INSTANCE_ORIGIN must
		// be https://, got 'http://attacker$\x1b[2J/'").  Strip
		// terminal escapes from the operator's screen at
		// display.
		console.log(`✗ ${sanitizeForTerm(env.error)}`);
		return 1;
	}
	const { account, keyFile, instanceName, origin, contactUrl, operatorTag } = env;

	console.log(`  Account:      @${sanitizeForTerm(account)}`);
	console.log(`  Origin:       ${sanitizeForTerm(origin)}`);
	console.log(`  Display name: ${sanitizeForTerm(instanceName)}`);
	if (contactUrl !== null) {
		console.log(`  Contact URL:  ${sanitizeForTerm(contactUrl)}`);
	}
	// The tag we register MUST be the same tag the relay attributes
	// earnings to — MORPHIT_INSTANCE_OPERATOR_TAG, set by the wizard.
	// Registering anything else would mean your on-chain identity and
	// your earning identity diverge (you'd register one tag but your
	// orders would carry another, so payouts wouldn't match).  Only if
	// that var is unset (older configs predating the wizard's tag step)
	// do we fall back to slugging the display name, and we say so.
	let tag: string;
	if (operatorTag !== null) {
		tag = operatorTag;
		console.log(`  Federation tag: ${sanitizeForTerm(tag)}`);
		console.log('    (from MORPHIT_INSTANCE_OPERATOR_TAG — the same tag your');
		console.log('     relay uses to attribute order earnings to you)');
	} else {
		tag = sluggifyTag(instanceName);
		console.log(`  Federation tag: ${sanitizeForTerm(tag)}`);
		console.log('    (MORPHIT_INSTANCE_OPERATOR_TAG is not set, so this was');
		console.log('     derived from your display name.  Set that variable — via');
		console.log('     `npx morphit-ops init` or `edit` — so your registered tag');
		console.log('     and your earnings tag are guaranteed to match.)');
	}
	console.log('');
	console.log('  (The "tag" is your instance\'s unique, PERMANENT federation');
	console.log('   identity. It is what attributes orders to you for fee');
	console.log('   earnings, and — once registered — what other nodes list you');
	console.log('   under in the public /instances directory and on your');
	console.log('   /about-this-instance page. It cannot be changed once');
	console.log('   registered, only superseded by a future update op.)');
	console.log('');

	// Pre-flight: reject a project-reserved tag NOW, before the
	// irreversible confirm and before paying any mana.  The on-chain
	// handler would reject it too (reason 'tag_reserved'), but
	// catching it here saves the operator a confusing round-trip.
	if (isReservedTag(tag)) {
		console.log(`✗ The tag "${sanitizeForTerm(tag)}" is reserved by the Morphit project`);
		console.log('  (names like morphit, morphit-relay, agorise are held back so');
		console.log('  nobody can squat a canonical identity).  Nobody else has');
		console.log('  claimed it — it is simply not available to register.');
		console.log('');
		console.log('  Change your federation tag to one that identifies YOUR node');
		console.log('  (your domain is a good choice) by re-running');
		console.log('  `npx morphit-ops edit` (Operator tag), then re-run register.');
		return 1;
	}

	// ─── 2. Confirm ────
	const ok = await askYesNo(
		'Publish this registration on-chain now? This is permanent — register ops cannot be reversed (only superseded by an update op when that ships)',
		false
	);
	if (!ok) {
		console.log('Aborted.  Re-run when ready.');
		return 0;
	}

	// ─── 3-5. Load key → preview → broadcast, with a mana-aware retry
	//         loop ────
	//
	// On an 'insufficient_rc' failure we DON'T make the operator re-run
	// the whole command: we explain how much to power up and then offer
	// an in-place retry.  Crucial security property: the decrypted
	// active key is loaded fresh for EACH attempt and wiped immediately
	// after the broadcast call, so it is NOT resident in memory during
	// the (possibly minutes-long) power-up wait between attempts.  The
	// cost is re-entering the passphrase per retry for an encrypted
	// keystore — the right trade for a high-value active key.
	let result: { block_num: number; trx_id: string } | null = null;
	let attempt = 0;
	for (;;) {
		attempt++;

		// Load the key for THIS attempt.
		let wif: string;
		try {
			wif = await loadKeyWif(keyFile);
		} catch (err) {
			console.log(`✗ Failed to load relay account key: ${sanitizeForTerm(errMsg(err))}`);
			return 1;
		}

		// On the first attempt only, show which key will sign (public
		// key only) so the operator can eyeball that the right key is
		// in play.  Never prints the private key.
		if (attempt === 1) {
			try {
				const dblurtPk = (await import('@beblurt/dblurt')) as unknown as {
					PrivateKey: {
						fromString(wif: string): { createPublic(prefix?: string): { toString(): string } };
					};
				};
				const pub = dblurtPk.PrivateKey.fromString(wif).createPublic('BLT').toString();
				console.log(`  Signing with the active key for @${sanitizeForTerm(account)} →`);
				console.log(`    public key: ${pub}`);
				console.log(`    (verify this matches @${sanitizeForTerm(account)}'s active authority on a`);
				console.log('     Blurt explorer; run `npx morphit-ops show-key` anytime to');
				console.log('     re-check.  A wrong key here is the #1 cause of failure.)');
				console.log('');
			} catch {
				// Non-fatal: a derivation failure will resurface as a
				// key error from the broadcast, with full diagnostics.
			}
		}

		// Build + sign + broadcast.  Wrap so `wif` is wiped on every
		// path (success, mana-retry, or hard failure).  JS strings are
		// immutable so this drops our reference rather than scrubbing
		// the bytes — but it ensures the secret is not held across the
		// retry prompt's wait.
		let broadcastErr: unknown = null;
		try {
			result = await broadcastRegister({
				account,
				wif,
				tag,
				instanceName,
				origin,
				contactUrl
			});
		} catch (err) {
			broadcastErr = err;
		} finally {
			wif = '';
		}

		if (broadcastErr === null) break; // success

		// Classify.  Only 'insufficient_rc' is retryable in place; for
		// everything else we print full guidance and exit.
		const kind = classifyChainError(errMsg(broadcastErr));
		if (kind !== 'insufficient_rc') {
			printChainErrorHelp(errMsg(broadcastErr), {
				opLabel: 'morphit_operator_register_v1',
				account,
				tag,
				keyFile,
				nameEnvVar: 'MORPHIT_INSTANCE_NAME'
			});
			return 1;
		}

		// Insufficient mana — print the specific power-up guidance (which
		// account, how much BP), then offer an in-place retry.  The key
		// is already wiped (above); the operator can take their time.
		printChainErrorHelp(errMsg(broadcastErr), {
			opLabel: 'morphit_operator_register_v1',
			account,
			tag,
			keyFile,
			nameEnvVar: 'MORPHIT_INSTANCE_NAME'
		});
		console.log('');
		const retry = await askYesNo(
			`Once you've powered up BLURT into BP on @${account} (~${SUGGESTED_BP_FLOOR} BP ` +
				`recommended), retry the broadcast now? (No need to re-run setup — ` +
				`answer No to quit and run \`npx morphit-ops register\` later)`,
			false
		);
		if (!retry) {
			console.log('Stopped.  Re-run `npx morphit-ops register` when ready.');
			return 1;
		}
		console.log('');
		console.log(`Retrying broadcast for @${sanitizeForTerm(account)}…`);
		console.log('');
		// loop continues — key is re-loaded fresh at the top
	}

	if (result === null) {
		// Defensive: the loop only breaks on success (result set) or
		// returns on failure, so this is unreachable — but keep the
		// type-narrowing honest.
		console.log('✗ Broadcast did not complete.');
		return 1;
	}

	console.log('');
	console.log('━'.repeat(58));
	console.log('Registration broadcast successfully.');
	console.log('━'.repeat(58));
	console.log('');
	console.log(`  Transaction:  ${result.trx_id}`);
	console.log(`  Block:        ${result.block_num}`);
	console.log('');
	console.log('Within roughly a minute every Morphit indexer will see your');
	console.log('registration and add your instance to their /instances');
	console.log('directory.  Each will probe your origin to verify it is');
	console.log('serving correctly.');
	console.log('');
	console.log('Check your own /instances page after a minute or two —');
	console.log("you should see yourself listed with status 'good'.");
	console.log('');

	return 0;
}

// ─── Helpers ─────────────────────────────────────────────────────

function printHeader(): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('Publish operator registration to the Blurt chain');
	console.log(rule);
	console.log('');
	console.log(
		'This posts a morphit_operator_register_v1 op signed by\n' +
			"your relay account's active key (the same key the relay\n" +
			'already holds for chain broadcasts).  After it lands\n' +
			'on-chain, your instance becomes discoverable across the\n' +
			'federation.\n'
	);
}

interface ValidEnv {
	readonly account: string;
	readonly keyFile: string;
	readonly instanceName: string;
	readonly origin: string;
	readonly contactUrl: string | null;
	/** The operator's configured federation tag
	 *  (MORPHIT_INSTANCE_OPERATOR_TAG) — the SAME value the relay uses
	 *  to attribute order earnings.  null if unset (older configs). */
	readonly operatorTag: string | null;
}

function readEnv(): ValidEnv | { error: string } {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
	const instanceName = process.env.MORPHIT_INSTANCE_NAME;
	const origin = process.env.MORPHIT_INSTANCE_ORIGIN;
	const contactUrl = process.env.MORPHIT_INSTANCE_CONTACT_URL;
	const operatorTag = process.env.MORPHIT_INSTANCE_OPERATOR_TAG;

	const missing: string[] = [];
	if (!account) missing.push('MORPHIT_RELAY_ACCOUNT');
	if (!keyFile) missing.push('MORPHIT_RELAY_ACTIVE_KEY_FILE');
	if (!instanceName) missing.push('MORPHIT_INSTANCE_NAME');
	if (!origin) missing.push('MORPHIT_INSTANCE_ORIGIN');
	if (missing.length > 0) {
		return {
			error:
				`Missing required environment variables: ${missing.join(', ')}.\n` +
				'  Source your morphit.env and morphit.config.env first:\n' +
				'    set -a; . ./morphit.env; . ./morphit.config.env; set +a'
		};
	}
	return {
		account: account!,
		keyFile: keyFile!,
		instanceName: instanceName!,
		origin: origin!,
		contactUrl: contactUrl ?? null,
		operatorTag: operatorTag && operatorTag.trim().length > 0 ? operatorTag.trim() : null
	};
}

async function loadKeyWif(keyFile: string): Promise<string> {
	const raw = readFileSync(keyFile, 'utf8').trim();
	// Heuristic: encrypted envelopes are JSON.  Plaintext WIFs start
	// with '5'.  This matches the relay's looksLikeEnvelope check.
	if (!raw.startsWith('{')) {
		// Plaintext WIF.  No prompt needed.
		return raw;
	}
	const envelope = JSON.parse(raw);
	const passphrase = await askPassword('Unlock passphrase');
	if (passphrase.length === 0) {
		throw new Error('passphrase required to unlock encrypted keystore');
	}
	// Lazy import — relay's keyEnvelope module decrypts.
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(envelope, passphrase);
}

async function broadcastRegister(args: {
	account: string;
	wif: string;
	tag: string;
	instanceName: string;
	origin: string;
	contactUrl: string | null;
}): Promise<{ block_num: number; trx_id: string }> {
	// Lazy-import dblurt so other ops-cli subcommands work without
	// it.  Failure to import surfaces as a clean error rather than
	// a stack trace at module load.  Typed loosely (unknown) here
	// because dblurt's types aren't in ops-cli's resolution scope;
	// runtime asserts cover what static types would.
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
	} catch (err) {
		// The package is a build dependency and is bundled into the
		// compiled CLI; a failure here is almost always a module-eval /
		// ESM-CJS-interop problem inside the bundle, NOT a missing
		// install.  Surface the real cause so the diagnostics layer can
		// classify it correctly (and so reinstalling isn't mis-suggested).
		throw new Error(
			`could not load the Blurt broadcast library: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}

	// Build the registration payload.  `tag` is the resolved
	// federation tag (MORPHIT_INSTANCE_OPERATOR_TAG, or a display-name
	// slug fallback) computed by the caller — the SAME tag the relay
	// attributes earnings to.  display_name is the friendlier
	// free-form variant.
	const tag = args.tag;
	const payload: Record<string, unknown> = {
		v: 1,
		tag,
		display_name: args.instanceName,
		origin: args.origin
	};
	if (args.contactUrl !== null) {
		payload.contact_url = args.contactUrl;
	}

	// Pick a Blurt RPC endpoint to talk to.  Same canonical list
	// shipped with the Morphit frontend (apps/web/src/lib/net/config.ts).
	// Update this list if the frontend list changes.
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
					id: 'morphit_operator_register_v1',
					json: JSON.stringify(payload)
				}
			];
			const priv = dblurt.PrivateKey.fromString(args.wif);
			const result = await client.broadcast.sendOperations([op], priv);
			return {
				block_num: result.block_num,
				trx_id: result.id
			};
		} catch (err) {
			lastError = err;
			continue;
		}
	}
	throw new Error(
		`all Blurt RPC endpoints rejected the broadcast.  Last error: ${errMsg(lastError)}`
	);
}

/** Convert a free-form instance name to a tag.  Tag rules:
 *  lowercase, [a-z0-9._-] only.  We slug on '.': replace
 *  spaces and other chars with '-', strip duplicates, trim
 *  ends.  If the result is empty, fall back to a default. */
function sluggifyTag(name: string): string {
	const lowered = name.toLowerCase();
	let slug = '';
	for (const ch of lowered) {
		if (/[a-z0-9._-]/.test(ch)) {
			slug += ch;
		} else {
			// Replace any other char with a dash.
			if (slug.length > 0 && slug[slug.length - 1] !== '-') {
				slug += '-';
			}
		}
	}
	// Trim leading/trailing punctuation.
	slug = slug.replace(/^[._-]+|[._-]+$/g, '');
	if (slug.length === 0) return 'morphit-instance';
	if (slug.length > 64) slug = slug.slice(0, 64);
	return slug;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
