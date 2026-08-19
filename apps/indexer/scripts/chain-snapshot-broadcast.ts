#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/chain-snapshot-broadcast.ts (cp765)
 *
 * Sign + broadcast a chain_snapshot_v1 op from @morphit — the on-chain pointer
 * to a published block_log snapshot (see chainSnapshotOp.ts). Mirrors
 * release-broadcast.ts: laptop-only (the @morphit posting WIF never goes in CI),
 * validates the payload before asking for the key, and dry-runs by default.
 *
 * Build the payload after you've pinned the block_log to IPFS + mirrored it:
 *   {
 *     "ipfs_cid":      "bafy…",           // block_log archive CID
 *     "sha256":        "<64-hex>",         // sha256sum of the archive
 *     "block_height":  62874615,
 *     "size_bytes":    27000000000,
 *     "blurtd_version":"0.1.5",
 *     "ipns_name":     "k51q…",            // optional: always-newest pointer
 *     "forgejo_url":   "https://git.agorise.net/…/block_log.tar"   // optional mirror
 *   }
 *
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/chain-snapshot-broadcast.ts snapshot.json --dry-run
 *   # then, for real, drop --dry-run (prompts for the @morphit posting WIF)
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, PrivateKey } from '@beblurt/dblurt';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import {
	buildChainSnapshotOp,
	CHAIN_SNAPSHOT_OP_ID,
	CHAIN_SNAPSHOT_SIGNER_DEFAULT
} from '../src/blurt/chainSnapshotOp.ts';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
function die(msg: string): never {
	console.error(`chain-snapshot-broadcast: ${msg}`);
	process.exit(1);
}
function ask(q: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}
const has = (n: string): boolean => process.argv.includes(`--${n}`);
function flag(n: string): string | undefined {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
	const file = process.argv[2];
	if (!file || file.startsWith('--')) die('usage: chain-snapshot-broadcast.ts <payload.json> [--dry-run] [--signer morphit]');
	const signer = flag('signer') ?? CHAIN_SNAPSHOT_SIGNER_DEFAULT;

	let payloadJson: string;
	try {
		payloadJson = readFileSync(file, 'utf8');
	} catch (e) {
		die(`could not read ${file}: ${errMsg(e)}`);
	}

	// Validate + shape BEFORE touching a key (fail loudly, locally).
	const op = buildChainSnapshotOp(payloadJson, signer);
	process.stderr.write(`\n${CHAIN_SNAPSHOT_OP_ID} — signed by @${signer}\n\n${op.json}\n\n`);

	if (has('dry-run')) {
		process.stderr.write('DRY RUN — not broadcast. Re-run without --dry-run to sign + send.\n');
		console.log(op.json);
		return;
	}

	const wif = await ask('Paste the @' + signer + ' POSTING WIF (starts with 5), or blank to abort: ');
	if (!wif) die('aborted (no key).');
	let priv: PrivateKey;
	try {
		priv = PrivateKey.fromString(wif);
	} catch (e) {
		die(`could not parse the key: ${errMsg(e)}`);
	}
	try {
		process.stderr.write(`\nDerived public key: ${priv.createPublic('BLT').toString()}\n`);
	} catch {
		/* non-fatal — the broadcast fails loudly if the key is wrong */
	}
	if ((await ask(`\nBroadcast ${CHAIN_SNAPSHOT_OP_ID} as @${signer} now? (type "yes"): `)) !== 'yes') {
		die('aborted.');
	}

	const opData = {
		required_auths: [...op.required_auths],
		required_posting_auths: [...op.required_posting_auths],
		id: op.id,
		json: op.json
	};
	let lastErr: unknown;
	for (const url of DEFAULT_BLURT_RPC_ENDPOINTS) {
		try {
			process.stderr.write(`\nBroadcasting via ${url} …\n`);
			const client = new Client(url, { timeout: 20_000 });
			const conf = (await client.broadcast.customJson(opData, priv)) as { id?: string; block_num?: number };
			process.stdout.write(
				`\n✓ Broadcast accepted.\n  trx_id    : ${conf.id ?? '(unknown)'}\n` +
					`  block_num : ${conf.block_num ?? '(pending)'}\n  op id     : ${CHAIN_SNAPSHOT_OP_ID}\n\n` +
					'New nodes reading the latest chain_snapshot_v1 from @' + signer + ' will bootstrap from it.\n'
			);
			return;
		} catch (e) {
			lastErr = e;
			process.stderr.write(`  ✗ ${url}: ${errMsg(e)}\n`);
		}
	}
	die(`every endpoint failed. Last error: ${errMsg(lastErr)}`);
}

main().catch((e) => die(errMsg(e)));
