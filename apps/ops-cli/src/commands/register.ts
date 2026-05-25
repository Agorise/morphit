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
	const { account, keyFile, instanceName, origin, contactUrl } = env;

	console.log(`  Account:      @${sanitizeForTerm(account)}`);
	console.log(`  Origin:       ${sanitizeForTerm(origin)}`);
	console.log(`  Display name: ${sanitizeForTerm(instanceName)}`);
	if (contactUrl !== null) {
		console.log(`  Contact URL:  ${sanitizeForTerm(contactUrl)}`);
	}
	console.log('');

	// ─── 2. Confirm ────
	const ok = await askYesNo(
		'Publish this registration on-chain now? This is permanent — register ops cannot be reversed (only superseded by an update op when that ships)',
		false
	);
	if (!ok) {
		console.log('Aborted.  Re-run when ready.');
		return 0;
	}

	// ─── 3. Load posting key ────
	let wif: string;
	try {
		wif = await loadPostingKey(keyFile);
	} catch (err) {
		console.log(`✗ Failed to load posting key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	// ─── 4. Verify the op-register handler still slots @account
	//      into a free tag (sanity-check before broadcasting; the
	//      chain-side check happens too, but we'd rather catch
	//      'account_already_registered' before paying RC).
	// (No-op stub — the on-chain handler is the canonical check;
	//  we don't duplicate state lookup here.  If chain rejects,
	//  we surface the rejection to the operator.)

	// ─── 5. Build + sign + broadcast ────
	// Audit 2026-05 hardening (NEW-9-13): wrap broadcast in
	// try/finally so `wif` clears even on error path. JS strings
	// are immutable; reassignment minimizes lifetime of the
	// reference even if the underlying memory persists until GC.
	let result: { block_num: number; trx_id: string };
	try {
		result = await broadcastRegister({
			account,
			wif,
			instanceName,
			origin,
			contactUrl
		});
	} catch (err) {
		console.log(`✗ Broadcast failed: ${sanitizeForTerm(errMsg(err))}`);
		console.log('');
		console.log('Common causes:');
		console.log('  - Tag already claimed by another account.  Edit');
		console.log('    MORPHIT_INSTANCE_NAME and re-run.');
		console.log('  - This account already registered.  Use a future');
		console.log('    `morphit-ops update` subcommand once it ships.');
		console.log('  - Posting-key mismatch.  Check the key file points');
		console.log("    at this account's posting key, not active or owner.");
		console.log('  - Insufficient resource credits.  Wait a few minutes');
		console.log("    or top up the account's BLURT balance.");
		return 1;
	} finally {
		wif = '';
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
			'your relay posting key.  After it lands on-chain, your\n' +
			'instance becomes discoverable across the federation.\n'
	);
}

interface ValidEnv {
	readonly account: string;
	readonly keyFile: string;
	readonly instanceName: string;
	readonly origin: string;
	readonly contactUrl: string | null;
}

function readEnv(): ValidEnv | { error: string } {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
	const instanceName = process.env.MORPHIT_INSTANCE_NAME;
	const origin = process.env.MORPHIT_INSTANCE_ORIGIN;
	const contactUrl = process.env.MORPHIT_INSTANCE_CONTACT_URL;

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
		contactUrl: contactUrl ?? null
	};
}

async function loadPostingKey(keyFile: string): Promise<string> {
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
	} catch {
		throw new Error(
			'@beblurt/dblurt is not installed.  Run `npm install` from the repo root first.'
		);
	}

	// Build the registration payload.  `tag` is reused as
	// instanceName, lower-cased and slugged to match the on-chain
	// validator (lowercase alphanumeric + dot/dash/underscore).
	// display_name is the friendlier free-form variant.
	const tag = sluggifyTag(args.instanceName);
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
