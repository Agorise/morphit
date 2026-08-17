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
import { printChainErrorHelp, classifyChainError, SUGGESTED_LIQUID_BLURT_BUFFER, broadcastCustomJson, errMsg } from './chainErrors.ts';
import { isReservedTag } from '../../../indexer/src/indexer/confusables.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';

export interface RegisterCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

export async function runRegister(ctx: RegisterCtx): Promise<number> {
	// --non-interactive (alias --yes) runs unattended: it skips the confirm and
	// unlocks an encrypted relay key from the relay's passphrase file the same way
	// the relay service does — so morphit-first-online can auto-register with no
	// human present the moment the box comes online.
	const nonInteractive =
		ctx.flags['non-interactive'] !== undefined || ctx.flags['yes'] !== undefined;
	// Load the instance env so MORPHIT_RELAY_ACCOUNT / posting-key file are
	// available on a systemd deploy (the unit sources morphit.env, the
	// operator's interactive shell does not). OS env wins; best-effort.
	loadInstanceEnv(defaultRepoRoot());
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
	if (!nonInteractive) {
		const ok = await askYesNo(
			'Publish this registration on-chain now? This is permanent — register ops cannot be reversed (only superseded by a fresh register op)',
			false
		);
		if (!ok) {
			console.log('Aborted.  Re-run when ready.');
			return 0;
		}
	}

	// ─── 3-5. Load key → preview → broadcast, with a fee-aware retry
	//         loop ────
	//
	// On an 'insufficient_fee' failure (the account is short of the LIQUID
	// BLURT needed to pay Blurt's small per-op fee — NOT mana/RC; see
	// docs/BLURT-CHAIN-MODEL.md) we DON'T make the operator re-run the whole
	// command: we explain what to top up and then offer an in-place retry.
	// Crucial security property: the decrypted active key is loaded fresh for
	// EACH attempt and wiped immediately after the broadcast call, so it is
	// NOT resident in memory during the wait between attempts.  The cost is
	// re-entering the passphrase per retry for an encrypted keystore — the
	// right trade for a high-value active key.
	let result: { trx_id: string } | null = null;
	let attempt = 0;
	for (;;) {
		attempt++;

		// Load the key for THIS attempt.
		let wif: string;
		try {
			wif = await loadKeyWif(keyFile, nonInteractive);
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
				console.log('');
				console.log('    Verify this key is listed under the "Active Auth" (active');
				console.log(`    authority) for @${sanitizeForTerm(account)} on a Blurt block explorer.`);
				console.log('    Open this URL and look at the Active Auth public key —');
				console.log('    it should match the line above exactly:');
				console.log(`      https://blocks.blurtwallet.com/#/@${sanitizeForTerm(account)}`);
				console.log('    (Run `npx morphit-ops show-key` anytime to re-check.  A');
				console.log('     wrong key here is the #1 cause of failure.)');
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
			// Build the registration payload.  `tag` is the resolved
			// federation tag (MORPHIT_INSTANCE_OPERATOR_TAG, or a
			// display-name slug fallback) computed by the caller — the
			// SAME tag the relay attributes earnings to.  display_name is
			// the friendlier free-form variant.
			const payload: Record<string, unknown> = {
				v: 1,
				tag,
				display_name: instanceName,
				origin
			};
			if (contactUrl !== null) {
				payload.contact_url = contactUrl;
			}
			result = await Promise.race([
				broadcastCustomJson({
					account,
					wif,
					opId: 'morphit_operator_register_v1',
					payload
				}),
				// Offline / air-gapped: the broadcast's RPC calls have no upstream to
				// answer and would otherwise BLOCK FOREVER (the operator had to Ctrl-C).
				// Fail after 15s with a clear message instead — the caller then arms the
				// deferred first-online register, or the operator retries when online.
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									'Timed out reaching a Blurt RPC after 15s — this box may not be online yet. ' +
										'Your registration is unchanged; re-run `sudo morphit-ops register` once you are online ' +
										'(a fresh install also lists itself automatically on first connection).'
								)
							),
						15_000
					)
				)
			]);
		} catch (err) {
			broadcastErr = err;
		} finally {
			wif = '';
		}

		if (broadcastErr === null) break; // success

		// Classify.  Only 'insufficient_fee' is retryable in place; for
		// everything else we print full guidance and exit.
		const kind = classifyChainError(errMsg(broadcastErr));
		if (kind !== 'insufficient_fee') {
			printChainErrorHelp(errMsg(broadcastErr), {
				opLabel: 'morphit_operator_register_v1',
				account,
				tag,
				keyFile,
				nameEnvVar: 'MORPHIT_INSTANCE_NAME'
			});
			return 1;
		}

		// Insufficient fee — print the specific guidance (which account,
		// keep a little liquid BLURT), then offer an in-place retry.  The key
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
			`Once @${account} holds a little liquid BLURT for the fee (~${SUGGESTED_LIQUID_BLURT_BUFFER} BLURT ` +
				`is ample — transfer it, do NOT power up), retry the broadcast now? ` +
				`(No need to re-run setup — answer No to quit and run ` +
				`\`npx morphit-ops register\` later)`,
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
	console.log(`  Transaction:  ${sanitizeForTerm(result.trx_id)}`);
	console.log('');
	console.log('  (Blurt confirms asynchronously, so there is no block number');
	console.log('   to show at broadcast time — look the transaction up on a');
	console.log('   Blurt explorer to see the block it lands in.)');
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

async function loadKeyWif(keyFile: string, nonInteractive = false): Promise<string> {
	const raw = readFileSync(keyFile, 'utf8').trim();
	// Heuristic: encrypted envelopes are JSON.  Plaintext WIFs start
	// with '5'.  This matches the relay's looksLikeEnvelope check.
	if (!raw.startsWith('{')) {
		// Plaintext WIF.  No prompt needed.
		return raw;
	}
	const envelope = JSON.parse(raw);
	let passphrase: string;
	if (nonInteractive) {
		// Unattended unlock — read the passphrase from the SAME credential file the
		// relay service uses to unlock this key at startup (MORPHIT_RELAY_ACTIVE_KEY_-
		// PASSPHRASE_FILE).  Reading a file (not an env var) keeps the secret out of
		// /proc/<pid>/environ, exactly as the relay does.  If it isn't set, the key
		// can't be unlocked with no human — say so clearly and stop.
		const passFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE;
		if (!passFile) {
			throw new Error(
				'encrypted relay key, but MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE is not set — ' +
					'cannot unlock unattended.  Register by hand with `morphit-ops register`, or point that ' +
					'variable at the passphrase file the relay uses.'
			);
		}
		passphrase = readFileSync(passFile, 'utf8').replace(/\r?\n$/, '');
		if (passphrase.length === 0) {
			throw new Error(`passphrase file ${JSON.stringify(passFile)} is empty`);
		}
	} else {
		passphrase = await askPassword('Unlock passphrase');
		if (passphrase.length === 0) {
			throw new Error('passphrase required to unlock encrypted keystore');
		}
	}
	// Lazy import — relay's keyEnvelope module decrypts.
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(envelope, passphrase);
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
