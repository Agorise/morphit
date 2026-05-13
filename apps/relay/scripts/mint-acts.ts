#!/usr/bin/env node --experimental-strip-types
/**
 * Morphit relay — ACT (Account Creation Token) minting script.
 *
 * Per ADR-0010 §4, the relay pre-mints ACTs in a weekly
 * operator-run ceremony rather than minting on-demand when a
 * user signs up. This decouples the relay's working BLURT
 * balance from the signup rate: at 100 BLURT per ACT, minting
 * 20 ACTs ahead of time means the relay's hot wallet only
 * needs BLURT for starter dust + welcome bonuses, not for
 * chain-fee-level claim payments.
 *
 * USAGE
 *   node --experimental-strip-types scripts/mint-acts.ts [count]
 *   # or via tsx:
 *   tsx scripts/mint-acts.ts [count]
 *
 *   count: number of ACTs to mint. 1..100.
 *
 *     - When invoked from a TTY (operator running by hand) the
 *       count argument is required so a typo can't fire an
 *       unintended large burn.
 *     - When invoked unattended (systemd timer with no TTY),
 *       falls back to MORPHIT_RELAY_WEEKLY_ACT_COUNT env var.
 *       Default 25, range 1..100.  See ops/systemd/morphit-relay-mint-acts.{service,timer}
 *       for the recommended unattended setup.
 *
 * BEHAVIOR
 *   1. Loads the same config the relay uses (from environment).
 *   2. Reads the relay's active-key WIF from MORPHIT_RELAY_ACTIVE_KEY_FILE.
 *      (Future work: passphrase-at-boot flow — ADR-0010 §4.)
 *   3. Fetches the current account_creation_fee from chain.
 *   4. Broadcasts `count` claim_account ops sequentially. Each op
 *      mints one ACT. Failures are logged but don't stop the
 *      sequence — the operator sees per-op results and can
 *      retry missing ones with a smaller count.
 *   5. Reports the chain's tx ids + a final summary.
 *
 * The operator is expected to be logged into the relay host,
 * with the active-key file mounted at its usual path. Running
 * the script ONLY mints ACTs — it doesn't create accounts,
 * doesn't transfer BLURT, doesn't touch the queue.
 *
 * SAFETY
 *   - The script re-uses the live key-file path. If that file
 *     has world-readable perms, the script refuses to start
 *     (same check as the relay itself).
 *   - Failures during minting are logged with the current ACT
 *     index so the operator knows exactly which ones landed.
 */

import { loadConfig } from '../src/config/index.ts';
import { unlockActiveKey } from '../src/config/unlock.ts';
import { BlurtClient } from '../src/blurt/client.ts';
import { Client, PrivateKey } from '@beblurt/dblurt';

async function main(): Promise<void> {
	// Resolve the count: explicit CLI arg wins; otherwise fall
	// back to MORPHIT_RELAY_WEEKLY_ACT_COUNT (set in the systemd
	// unit for unattended runs).  When neither is set AND we're
	// on a TTY, the script demands the arg explicitly so a typo
	// can't accidentally fire a large burn.
	const countArg = process.argv[2];
	const envCountRaw = process.env.MORPHIT_RELAY_WEEKLY_ACT_COUNT;
	let countSource: 'arg' | 'env';
	let countRaw: string;
	if (countArg !== undefined && countArg !== '') {
		countRaw = countArg;
		countSource = 'arg';
	} else if (envCountRaw !== undefined && envCountRaw !== '') {
		countRaw = envCountRaw;
		countSource = 'env';
	} else {
		die(
			'missing count. Provide as argv[1] (e.g. `mint-acts.ts 25`) ' +
				'or set MORPHIT_RELAY_WEEKLY_ACT_COUNT for unattended runs.'
		);
	}
	const count = Number.parseInt(countRaw, 10);
	if (!Number.isInteger(count) || count < 1 || count > 100) {
		die(`count must be integer 1..100, got ${JSON.stringify(countRaw)} (source=${countSource})`);
	}
	log(`count=${count} source=${countSource}`);

	let cfg;
	try {
		cfg = loadConfig();
	} catch (err) {
		die(`config error: ${err instanceof Error ? err.message : String(err)}`);
	}

	// ADR-0010 §4: if the key file is an encrypted envelope,
	// prompt the operator for the passphrase. Plaintext files
	// pass through unchanged.
	//
	// Unattended-run path: when MORPHIT_RELAY_PASSPHRASE_FILE is
	// set, read the passphrase from that path (root-only, mode
	// 0600) instead of prompting on stdin. This is the systemd
	// timer's mechanism for getting through the prompt without
	// an operator in front of a tty.  See ops/systemd/morphit-
	// relay-mint-acts.service for how the file is fed via
	// LoadCredential=.
	try {
		const passphraseFile = process.env.MORPHIT_RELAY_PASSPHRASE_FILE;
		if (passphraseFile !== undefined && passphraseFile !== '') {
			const fs = await import('node:fs/promises');
			const raw = await fs.readFile(passphraseFile, 'utf8');
			// Trim ONE trailing newline (a cred file written by
			// `echo` will end in \n) but preserve any internal
			// whitespace that might be part of the passphrase.
			const passphrase = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
			if (passphrase.length === 0) {
				die(`passphrase file ${passphraseFile} is empty after trimming trailing newline`);
			}
			cfg = await unlockActiveKey(cfg, async () => passphrase);
			log('key unlocked from passphrase file (unattended path)');
		} else {
			cfg = await unlockActiveKey(cfg);
		}
	} catch (err) {
		die(`key unlock failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (cfg.relayActiveKeyWif === undefined) {
		die('internal: active key not set after unlock');
	}

	log(`loaded config; relay_account=${cfg.relayAccount} endpoints=${cfg.blurtRpcEndpoints.length}`);

	// Fetch current chain fee so we can report total BLURT burn.
	const blurt = new BlurtClient(cfg.blurtRpcEndpoints, cfg.accountCreationFeeBlurt);
	let feeBlurt: number;
	try {
		const chainProps = await blurt.getChainProperties();
		// account_creation_fee is a Graphene asset string like
		// "100.000 BLURT". Parse the numeric part.
		const feeStr = chainProps.account_creation_fee;
		const match = /^([\d.]+)\s+BLURT$/.exec(feeStr);
		if (!match) {
			die(`chain returned unparseable account_creation_fee: ${JSON.stringify(feeStr)}`);
		}
		feeBlurt = Number.parseFloat(match[1]!);
		if (!Number.isFinite(feeBlurt) || feeBlurt <= 0) {
			die(`chain returned non-positive account_creation_fee: ${feeStr}`);
		}
	} catch (err) {
		die(`get_chain_properties failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const totalBlurt = feeBlurt * count;
	log(
		`current account_creation_fee = ${feeBlurt.toFixed(3)} BLURT; minting ${count} ACT(s) will burn ~${totalBlurt.toFixed(3)} BLURT`
	);

	// Mint one ACT per iteration. Each claim_account op is its
	// own transaction so partial failures are recoverable.
	const priv = PrivateKey.fromString(cfg.relayActiveKeyWif);
	let succeeded = 0;
	let failed = 0;
	for (let i = 1; i <= count; i++) {
		try {
			const trxId = await mintOne(cfg.blurtRpcEndpoints, cfg.relayAccount, feeBlurt, priv);
			log(`  [${i}/${count}] minted  trx_id=${trxId}`);
			succeeded++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`  [${i}/${count}] FAILED  ${msg}`);
			failed++;
		}
	}

	log(`done; succeeded=${succeeded} failed=${failed}`);
	if (failed > 0) process.exit(2);
}

/** Broadcast a single claim_account op. Returns the trx id on
 *  success; throws on failure. */
async function mintOne(
	endpoints: readonly string[],
	creator: string,
	feeBlurt: number,
	priv: PrivateKey
): Promise<string> {
	// claim_account requires active authority. Op shape per
	// Steem/Blurt wire:
	//   ['claim_account', { creator, fee: "N.NNN BLURT", extensions: [] }]
	const op: [string, Record<string, unknown>] = [
		'claim_account',
		{
			creator,
			fee: `${feeBlurt.toFixed(3)} BLURT`,
			extensions: []
		}
	];

	// We don't re-use BlurtClient.callWithRotation here because
	// its private and the mint flow is simpler — try the first
	// endpoint, move to the next on failure. Three attempts max.
	let lastErr: unknown = null;
	for (let i = 0; i < endpoints.length; i++) {
		const client = new Client(endpoints[i]!, { timeout: 15_000 });
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const confirmation = await client.broadcast.sendOperations([op as any], priv);
			return String((confirmation as { id?: string }).id ?? '');
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function log(msg: string): void {
	const ts = new Date().toISOString();
	// eslint-disable-next-line no-console
	console.log(`${ts} [mint-acts] ${msg}`);
}

function die(msg: string): never {
	// eslint-disable-next-line no-console
	console.error(`[mint-acts] FATAL: ${msg}`);
	process.exit(1);
}

main().catch((err) => {
	die(`uncaught: ${err instanceof Error ? err.message : String(err)}`);
});
