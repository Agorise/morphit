#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/indexer-snapshot-broadcast.ts (cp766)
 *
 * Sign + broadcast an indexer_snapshot_v1 op from @morphit — the on-chain pointer
 * to a published indexer-DB snapshot (see indexerSnapshotOp.ts). Mirrors
 * chain-snapshot-broadcast.ts / release-broadcast.ts: laptop-only (the @morphit
 * posting WIF never goes in CI), validates the payload before asking for the key,
 * and dry-runs by default.
 *
 * Build the payload after you've exported + pinned + mirrored the snapshot
 * (pin-indexer-snapshot.sh emits it):
 *   {
 *     "ipfs_cid":          "bafy…",       // snapshot tarball CID
 *     "sha256":            "<64-hex>",     // sha256sum of indexer.sql.gz (== manifest.dumpSha256)
 *     "chain_id":          "<hex>",        // MUST match the target chain
 *     "schema_version":    40,
 *     "last_applied_block": 63188071,
 *     "size_bytes":        4200000000,
 *     "indexer_version":   "1.14.0",
 *     "ipns_name":         "k51q…",        // optional: always-newest pointer
 *     "forgejo_url":       "https://git.agorise.net/…/snap.tar.gz"  // optional mirror
 *   }
 *
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/indexer-snapshot-broadcast.ts snapshot.json --dry-run
 *   # then, for real, drop --dry-run (prompts for the @morphit posting WIF)
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PrivateKey } from '@beblurt/dblurt';
import { broadcastCustomJsonOnce } from './lib/signOnceBroadcast.ts';
import {
	buildIndexerSnapshotOp,
	INDEXER_SNAPSHOT_OP_ID,
	INDEXER_SNAPSHOT_SIGNER_DEFAULT
} from '../src/blurt/indexerSnapshotOp.ts';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
function die(msg: string): never {
	console.error(`indexer-snapshot-broadcast: ${msg}`);
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
	if (!file || file.startsWith('--')) die('usage: indexer-snapshot-broadcast.ts <payload.json> [--dry-run] [--signer morphit] [--node <url>] [--include-hidden]');
	const signer = flag('signer') ?? INDEXER_SNAPSHOT_SIGNER_DEFAULT;

	let payloadJson: string;
	try {
		payloadJson = readFileSync(file, 'utf8');
	} catch (e) {
		die(`could not read ${file}: ${errMsg(e)}`);
	}

	// Validate + shape BEFORE touching a key (fail loudly, locally).
	const op = buildIndexerSnapshotOp(payloadJson, signer);
	process.stderr.write(`\n${INDEXER_SNAPSHOT_OP_ID} — signed by @${signer}\n\n${op.json}\n\n`);

	if (has('dry-run')) {
		process.stderr.write('DRY RUN — not broadcast. Re-run without --dry-run to sign + send.\n');
		console.log(op.json);
		return;
	}

	// Non-interactive path for the auto-publish timer: a DEDICATED snapshot-signing
	// posting key in MORPHIT_SNAPSHOT_SIGNING_WIF + --yes. Opt-in only — the
	// interactive path (prompt for the WIF) stays the default so the main @morphit
	// key is never required to sit on a server.
	let wif: string;
	const envWif = process.env.MORPHIT_SNAPSHOT_SIGNING_WIF;
	if (has('yes') && envWif) {
		wif = envWif.trim();
		process.stderr.write('Non-interactive: signing with MORPHIT_SNAPSHOT_SIGNING_WIF.\n');
	} else {
		wif = await ask('Paste the @' + signer + ' POSTING WIF (starts with 5), or blank to abort: ');
	}
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
	if (!has('yes') && (await ask(`\nBroadcast ${INDEXER_SNAPSHOT_OP_ID} as @${signer} now? (type "yes"): `)) !== 'yes') {
		die('aborted.');
	}

	const opData = {
		required_auths: [...op.required_auths],
		required_posting_auths: [...op.required_posting_auths],
		id: op.id,
		json: op.json
	};
	// v1.20.0 (D12): signed ONCE, offered to health-ranked nodes in turn;
	// --node pins one, --include-hidden adds the hidden nodes (off by default).
	const nodeOverride = flag('node') ?? null;
	const includeHidden = has('include-hidden');
	let res: Awaited<ReturnType<typeof broadcastCustomJsonOnce>>;
	try {
		res = await broadcastCustomJsonOnce(opData, priv, { nodeOverride, includeHidden });
	} catch (e) {
		die(errMsg(e));
	}
	process.stdout.write(
		`\n✓ Broadcast accepted${res.duplicate ? ' (an earlier attempt had already landed)' : ''}.\n` +
			`  trx_id    : ${res.trxId}\n` +
			`  block_num : ${res.blockNum ?? '(pending)'}\n` +
			`  via       : ${res.via}\n` +
			`  op id     : ${INDEXER_SNAPSHOT_OP_ID}\n\n` +
			'New nodes reading the latest indexer_snapshot_v1 from @' + signer + ' will fast-sync from it.\n'
	);
}

main().catch((e) => die(errMsg(e)));
