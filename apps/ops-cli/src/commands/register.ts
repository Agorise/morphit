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
 *   MORPHIT_INDEXER_FEE_RECIPIENT (optional; resolved exactly as the indexer
 *                                  service resolves it — see below)
 *
 * v1.20.0 (G1): the op carries `fee_recipient`, the RESOLVED fees account the
 * frontend pays the 90 % leg of BLURT fees to. Other Morphit instances accept
 * that leg only when it matches this registration, so without it your users'
 * BLURT-paid orders are hidden and their first-contact DMs dropped on every
 * other instance. `morphit-ops upgrade` re-publishes it unattended when the
 * chain disagrees (lib/feeRecipientHeal.ts).
 *
 * Reads keystore from disk; if encrypted, prompts for the
 * unlock passphrase same way the relay does at startup.
 *
 * Re-registrable: the on-chain handler is an UPSERT keyed on the
 * signing account, so re-running `register` UPDATES the mutable
 * fields (display_name, origin, contact_url, alt addresses). Only
 * the TAG is immutable — a re-register that changes it is rejected
 * as 'tag_immutable' and changes nothing (we pre-flight that below
 * so the operator never broadcasts a doomed op). There is no
 * 'account_already_registered' rejection any more.
 *
 * Dependencies are lazy-imported so the ops-cli's other
 * subcommands (init, status) don't fail to load when dblurt
 * isn't installed yet.  `register` requires `npm install` to
 * have run; without it the lazy import errors with a clear
 * message.
 */

import { readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withSpinner } from '../init/spinner.ts';
import { spawnSync } from 'node:child_process';
import { ask, askPassword, askYesNo, RELAY_KEY_UNLOCK_PROMPT } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import {
	printChainErrorHelp,
	classifyChainError,
	SUGGESTED_LIQUID_BLURT_BUFFER,
	broadcastCustomJson,
	errMsg
} from './chainErrors.ts';
import {
	isReservedTag,
	ownsReservedName,
	tagImpersonatesReserved
} from '../../../indexer/src/indexer/confusables.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';
import { operatorTagConflict, fetchRegisteredTag } from '../lib/operatorTagGuard.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { CANONICAL_BLURT_TREASURY, configuredFeeRecipient } from '../lib/operatorFeeRecipient.ts';
import { RELAY_ENV_FILES, readEffectiveEnv } from '../lib/relayHiddenHeal.ts';

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
		// env.error is built from env-var validation
		// failures; it can include the offending env-var VALUE
		// in the error message ("MORPHIT_INSTANCE_ORIGIN must
		// be https://, got 'http://attacker$\x1b[2J/'").  Strip
		// terminal escapes from the operator's screen at
		// display.
		console.log(`✗ ${sanitizeForTerm(env.error)}`);
		return 1;
	}
	const {
		account,
		keyFile,
		instanceName,
		origin,
		contactUrl,
		operatorTag,
		altAddresses,
		feeRecipient
	} = env;

	console.log(`  Account:      @${sanitizeForTerm(account)}`);
	console.log(`  Origin:       ${sanitizeForTerm(origin)}`);
	console.log(`  Display name: ${sanitizeForTerm(instanceName)}`);
	if (contactUrl !== null) {
		console.log(`  Contact URL:  ${sanitizeForTerm(contactUrl)}`);
	}
	console.log(`  Fees account: @${sanitizeForTerm(feeRecipient)}`);
	console.log(
		feeRecipient === CANONICAL_BLURT_TREASURY
			? '    (the shared Morphit treasury — you have no fees account of your own)'
			: '    (other Morphit instances accept your users\u2019 fees paid to this account)'
	);
	// SHOW the alt addresses this op will publish, before it is signed.
	//
	// They were carried into the payload but never displayed, so an operator
	// confirmed a PERMANENT on-chain op without seeing which addresses it
	// announced. That is precisely how an instance came to publish a stale
	// .b32.i2p its router no longer hosted: every peer's I2P fetch to it failed
	// for an unknown period, and the one moment someone could have caught it —
	// the confirmation prompt — showed them nothing.
	//
	// Peers reach you at whatever this op says, so it is the single most
	// important thing on this screen after the account.
	const altShown: [string, string | null | undefined][] = [
		['Tor', altAddresses.tor],
		['I2P (b32)', altAddresses.i2p_b32],
		['I2P (name)', altAddresses.i2p_name],
		['Lokinet', altAddresses.lokinet],
		['ENS', altAddresses.ens]
	];
	const altPresent = altShown.filter(([, v]) => v !== null && v !== undefined && v !== '');
	if (altPresent.length > 0) {
		console.log('  Alt addresses (peers will use these — check them):');
		for (const [label, value] of altPresent) {
			console.log(`    ${label.padEnd(11)} ${sanitizeForTerm(String(value))}`);
		}
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
		console.log('     `sudo morphit-ops init` or `edit` — so your registered tag');
		console.log('     and your earnings tag are guaranteed to match.)');
	}
	console.log('');
	console.log('  (The "tag" is your instance\'s unique, PERMANENT federation');
	console.log('   identity. It is what attributes orders to you for fee');
	console.log('   earnings, and — once registered — what other nodes list you');
	console.log('   under in the public /instances directory and on your');
	console.log('   /about-this-instance page. The TAG cannot be changed once');
	console.log('   registered; the other fields — display name, origin, contact,');
	console.log('   alt addresses — you update just by running register again.)');
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
		console.log('  `sudo morphit-ops edit` (Operator tag), then re-run register.');
		return 1;
	}

	// Pre-flight: the tag is IMMUTABLE. If this account already registered under
	// a DIFFERENT tag, the on-chain handler rejects a re-register as
	// `tag_immutable` and silently changes NOTHING — the operator broadcasts a
	// valid-looking op but their display_name / origin / contact never update
	// (the trap that left morphitlat's title stale for 10 hours). Catch it here,
	// against the local indexer, before the irreversible confirm + any mana.
	const registeredTag = await withSpinner('Checking your existing on-chain registration…', () =>
		fetchRegisteredTag(account)
	);
	if (operatorTagConflict(registeredTag, tag)) {
		console.log(
			`✗ @${sanitizeForTerm(account)} is already registered under the tag "${sanitizeForTerm(registeredTag as string)}".`
		);
		console.log('  The federation tag is PERMANENT. Re-registering under a different tag');
		console.log(`  ("${sanitizeForTerm(tag)}") is rejected on-chain as tag_immutable and changes`);
		console.log('  nothing — your display name, origin, and contact would NOT update.');
		console.log('');
		console.log(
			`  Set MORPHIT_INSTANCE_OPERATOR_TAG="${sanitizeForTerm(registeredTag as string)}" (via`
		);
		console.log('  `sudo morphit-ops edit` → Operator tag, or the config file) so it matches');
		console.log('  your registered tag, then re-run register to update the other fields.');
		return 1;
	}

	// Pre-flight: the indexer now refuses, on FIRST
	// registration, a tag that looks like a reserved name (`m0rphit`,
	// `morphit-io`) unless this account owns that name. An existing
	// registration keeps its tag, so only a first registration is checked —
	// the same rule the indexer applies, so the op is not broadcast for nothing.
	if (registeredTag === null && tagImpersonatesReserved(tag) && !ownsReservedName(account, tag)) {
		console.log(
			`✗ The tag "${sanitizeForTerm(tag)}" looks like a name reserved by the Morphit project`
		);
		console.log('  (look-alikes such as m0rphit, or morphit- followed by anything, are held');
		console.log('  back so nobody can pass as an official node). Choose a tag that');
		console.log('  identifies YOUR node — your domain is a good choice — with');
		console.log('  `sudo morphit-ops edit` (Operator tag), then re-run register.');
		return 1;
	}

	// ─── 2. Confirm ────
	if (!nonInteractive) {
		const ok = await askYesNo(
			'Publish this registration on-chain now? Your TAG is permanent once claimed; the other fields you can change later by running register again',
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
			wif = nonInteractive ? await loadRelayKeyUnattended(keyFile) : await loadKeyWif(keyFile);
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
				console.log('    (Run `sudo morphit-ops show-key` anytime to re-check.  A');
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
			const payload = buildRegisterPayload(env, tag);
			result = await broadcastRegistration(account, wif, payload);
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
				`\`sudo morphit-ops register\` later)`,
			false
		);
		if (!retry) {
			console.log('Stopped.  Re-run `sudo morphit-ops register` when ready.');
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

/**
 * The register payload for `env` under `tag`. Exported for the upgrade's
 * fee-recipient heal, which publishes the SAME record `register` would (every
 * field, so a peer still on an older indexer — whose handler overwrites the
 * origin and addresses with whatever the op carries — keeps them).
 */
export function buildRegisterPayload(env: ValidEnv, tag: string): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		v: 1,
		tag,
		display_name: env.instanceName,
		origin: env.origin,
		// v1.20.0 (G1) — the resolved fees account (see the module doc).
		fee_recipient: env.feeRecipient
	};
	if (env.contactUrl !== null) {
		payload.contact_url = env.contactUrl;
	}
	// v1.15.3 — publish hidden-service addresses ON-CHAIN so the federation
	// can reach a clearnet-censored node over Tor/I2P without a (blocked)
	// clearnet probe. Only include fields that are actually set.
	const a = env.altAddresses;
	const alt: Record<string, string> = {};
	if (a.tor) alt.tor = a.tor;
	if (a.i2p_b32) alt.i2p_b32 = a.i2p_b32;
	if (a.i2p_name) alt.i2p_name = a.i2p_name;
	if (a.lokinet) alt.lokinet = a.lokinet;
	if (a.ens) alt.ens = a.ens;
	if (Object.keys(alt).length > 0) payload.alt_addresses = alt;
	return payload;
}

/**
 * Sign once and broadcast a register op, with a spinner and a hard limit.
 * a hidden-only node broadcasts through its own indexer
 * over Tor/I2P (see broadcastCustomJson), where a round trip plus the wait for
 * a block routinely takes longer than 15 s — so 200 s there, 15 s elsewhere.
 * Offline / air-gapped, the RPC calls would otherwise BLOCK FOREVER (the
 * operator had to Ctrl-C); fail with a clear message instead.
 */
export async function broadcastRegistration(
	account: string,
	wif: string,
	payload: Record<string, unknown>,
	/** Cap on the wait (the upgrade heal passes what its phase has left). */
	maxLimitMs?: number
): Promise<{ trx_id: string }> {
	const hiddenOnly = isHiddenOnlyNode();
	const limitMs = Math.min(hiddenOnly ? 200_000 : 15_000, maxLimitMs ?? Number.POSITIVE_INFINITY);
	let timer: NodeJS.Timeout | undefined;
	try {
		return await withSpinner(
			hiddenOnly
				? 'Broadcasting your registration through this node\u2019s indexer over Tor/I2P (can take a minute)…'
				: 'Broadcasting your registration to the chain…',
			() =>
				Promise.race([
					broadcastCustomJson({ account, wif, opId: 'morphit_operator_register_v1', payload }),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										(hiddenOnly
											? `No answer from this node's own indexer over Tor/I2P after ${Math.round(limitMs / 1000)}s — the hidden route may still be warming up. `
											: `Timed out reaching a Blurt RPC after ${Math.round(limitMs / 1000)}s — this box may not be online yet. `) +
											'Your registration is unchanged; re-run `sudo morphit-ops register` once you are online ' +
											'(a fresh install also lists itself automatically on first connection).'
									)
								),
							limitMs
						);
					})
				])
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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

export interface ValidEnv {
	readonly account: string;
	readonly keyFile: string;
	readonly instanceName: string;
	readonly origin: string;
	readonly contactUrl: string | null;
	/** The operator's configured federation tag
	 *  (MORPHIT_INSTANCE_OPERATOR_TAG) — the SAME value the relay uses
	 *  to attribute order earnings.  null if unset (older configs). */
	readonly operatorTag: string | null;
	/** v1.15.3 — hidden-service addresses read from config, published on-chain so
	 *  peers can reach a clearnet-censored node over Tor/I2P. All optional. */
	readonly altAddresses: {
		tor: string | null;
		i2p_b32: string | null;
		i2p_name: string | null;
		lokinet: string | null;
		ens: string | null;
	};
	/** v1.20.0 (G1) — the fees account the indexer SERVICE resolves
	 *  (MORPHIT_INDEXER_FEE_RECIPIENT, or the canonical treasury). */
	readonly feeRecipient: string;
}

/** The register inputs from the environment (exported for the upgrade heal). */
export function readRegisterEnv(): ValidEnv | { error: string } {
	return readEnv();
}

function readEnv(): ValidEnv | { error: string } {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
	const instanceName = process.env.MORPHIT_INSTANCE_NAME;
	const origin = process.env.MORPHIT_INSTANCE_ORIGIN;
	const contactUrl = process.env.MORPHIT_INSTANCE_CONTACT_URL;
	const operatorTag = process.env.MORPHIT_INSTANCE_OPERATOR_TAG;
	// Legacy single-var i2p address (pre b32/name split). edit.ts falls back to
	// it for display; register must too, or an operator whose b32 lives only in
	// the legacy var silently drops it from the on-chain broadcast (v1.15.7).
	const legacyI2p = (process.env.MORPHIT_INSTANCE_I2P_ADDRESS ?? '').trim() || null;

	const missing: string[] = [];
	if (!account) missing.push('MORPHIT_RELAY_ACCOUNT');
	if (!keyFile) missing.push('MORPHIT_RELAY_ACTIVE_KEY_FILE');
	if (!instanceName) missing.push('MORPHIT_INSTANCE_NAME');
	if (!origin) missing.push('MORPHIT_INSTANCE_ORIGIN');
	if (missing.length > 0) {
		return {
			error:
				`Missing required environment variables: ${missing.join(', ')}.\n` +
				'  These live in your instance env files. On a DEFAULT install they are in\n' +
				'  /opt/morphit and owned by root, so source them and register in ONE root\n' +
				'  shell (a plain `. ./morphit.env` fails there — wrong dir / no permission):\n' +
				"    sudo bash -c 'set -a; . /opt/morphit/morphit.env; . /opt/morphit/morphit.config.env; set +a; cd /opt/morphit && morphit-ops register'\n" +
				'  (Running from your OWN checkout instead? cd there first, then:\n' +
				'    set -a; . ./morphit.env; . ./morphit.config.env; set +a )'
		};
	}
	return {
		account: account!,
		keyFile: keyFile!,
		instanceName: instanceName!,
		origin: origin!,
		contactUrl: contactUrl ?? null,
		operatorTag: operatorTag && operatorTag.trim().length > 0 ? operatorTag.trim() : null,
		altAddresses: {
			tor: (process.env.MORPHIT_INSTANCE_TOR_ADDRESS ?? '').trim() || null,
			i2p_b32:
				((process.env.MORPHIT_INSTANCE_I2P_B32_ADDRESS ?? '').trim() || null) ??
				(legacyI2p && legacyI2p.endsWith('.b32.i2p') ? legacyI2p : null),
			i2p_name:
				((process.env.MORPHIT_INSTANCE_I2P_NAME_ADDRESS ?? '').trim() || null) ??
				(legacyI2p && legacyI2p.endsWith('.i2p') && !legacyI2p.endsWith('.b32.i2p')
					? legacyI2p
					: null),
			lokinet: (process.env.MORPHIT_INSTANCE_LOKINET_ADDRESS ?? '').trim() || null,
			ens: (process.env.MORPHIT_INSTANCE_ENS_NAME ?? '').trim() || null
		},
		feeRecipient: configuredFeeRecipient().recipient
	};
}

/** Try to obtain the relay's unlock passphrase from the SAME host-bound
 *  systemd credential the relay service auto-unlocks with at boot
 *  (`/etc/morphit/relay_passphrase.cred`, sealed `--with-key=host`).  Returns
 *  the passphrase, or null if the cred is absent / systemd-creds is unavailable
 *  / decryption fails (e.g. not running as root, or a different host).  The
 *  decrypted secret is read from systemd-creds' standard output straight into
 *  this process's memory: it is never written to any file (it used to pass
 *  through a world-readable /run file). */
export function trySealedRelayPassphrase(): string | null {
	const cred = process.env.MORPHIT_RELAY_CRED_FILE || '/etc/morphit/relay_passphrase.cred';
	if (!existsSync(cred)) return null;
	try {
		const r = spawnSync('systemd-creds', ['decrypt', '--name=relay_passphrase', cred, '-'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024
		});
		if (r.status !== 0 || typeof r.stdout !== 'string') return null;
		const pass = r.stdout.replace(/\r?\n$/, '');
		return pass.length > 0 ? pass : null;
	} catch {
		return null;
	}
}

/** Passphrase files older releases left in /run (`register` and the
 *  fee-recipient heal decrypted the relay's sealed credential into
 *  `/run/morphit-reg-<pid>-<hex>.pass`, mode 0644, removed afterwards — unless
 *  the process was killed in between). */
export const STALE_REG_PASS_RE = /^morphit-reg-\d+-[0-9a-f]{12}\.pass$/;

/** Remove every such leftover in `dir`; returns how many were found and how
 *  many are still there afterwards (read back). Never throws. */
export function removeStaleRegPassFiles(dir = '/run'): { found: number; left: number } {
	const list = (): string[] => {
		try {
			return readdirSync(dir).filter((n) => STALE_REG_PASS_RE.test(n));
		} catch {
			return [];
		}
	};
	const found = list();
	for (const n of found) {
		try {
			unlinkSync(join(dir, n));
		} catch {
			/* reported below */
		}
	}
	return { found: found.length, left: list().length };
}

/**
 * Unlock the relay's active key with NO human present, the way the relay
 * service and morphit-first-online do: a plaintext WIF as is; an encrypted
 * envelope with the relay's host-sealed credential
 * (/etc/morphit/relay_passphrase.cred, root only), else with the passphrase
 * FILE the relay is configured with (MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE,
 * from this environment or the relay service's env files). Reading files (not
 * an env var) keeps the secret out of /proc/<pid>/environ. Throws, saying why,
 * when none of those can unlock it — the key then needs its owner.
 */
export async function loadRelayKeyUnattended(keyFile: string): Promise<string> {
	const raw = readFileSync(keyFile, 'utf8').trim();
	// Heuristic: encrypted envelopes are JSON; plaintext WIFs start with '5'
	// (the relay's looksLikeEnvelope check).
	if (!raw.startsWith('{')) return raw;
	const envelope = JSON.parse(raw);
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');
	const sealed = trySealedRelayPassphrase();
	if (sealed !== null) {
		try {
			return decryptEnvelope(envelope, sealed);
		} catch {
			// The sealed passphrase does not open THIS keystore; try the file.
		}
	}
	let passFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE;
	if (!passFile) {
		try {
			const root = process.env.MORPHIT_ENV_ROOT ?? '';
			passFile = readEffectiveEnv(
				RELAY_ENV_FILES.map((f) => `${root}${f}`),
				['MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE']
			).get('MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE');
		} catch {
			passFile = undefined;
		}
	}
	if (!passFile) {
		throw new Error(
			'encrypted relay key, and neither the relay\u2019s sealed credential nor a passphrase file ' +
				'(MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE) can unlock it unattended.  Register by hand ' +
				'with `sudo morphit-ops register` on this server.'
		);
	}
	const passphrase = readFileSync(passFile, 'utf8').replace(/\r?\n$/, '');
	if (passphrase.length === 0) {
		throw new Error(`passphrase file ${JSON.stringify(passFile)} is empty`);
	}
	return decryptEnvelope(envelope, passphrase);
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
	// Lazy import — relay's keyEnvelope module decrypts.
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');

	// Interactive.  FIRST try the relay's own host-sealed credential: an operator
	// running this ON the box should never have to re-type a passphrase the relay
	// already holds sealed (and re-typing/​pasting it is exactly what failed —
	// v1.15.6).  Only if that credential is absent or doesn't unlock THIS envelope
	// do we fall back to prompting.
	const sealed = trySealedRelayPassphrase();
	if (sealed !== null) {
		try {
			const wif = decryptEnvelope(envelope, sealed);
			console.log("  \u2713 Unlocked from the relay's sealed credential — no passphrase needed.");
			return wif;
		} catch {
			// The sealed passphrase didn't match THIS keystore (unusual). Fall
			// through to the manual prompt rather than failing outright.
		}
	}

	const passphrase = await askPassword(RELAY_KEY_UNLOCK_PROMPT);
	if (passphrase.length === 0) {
		throw new Error('passphrase required to unlock encrypted keystore');
	}
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
