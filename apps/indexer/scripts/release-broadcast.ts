/**
 * release-broadcast — sign + broadcast a morphit_release_v1 op.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LAPTOP ONLY.  This uses the @morphit PRIVATE posting key   │
 * │  (the WIF), which by design lives OFF the production        │
 * │  server.  Never run this on the VPS.                        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Pipeline:
 *   1) Build the payload (pre-filled with the canonical treasury):
 *        node_modules/.bin/tsx apps/indexer/scripts/release-build-payload.ts > /tmp/morphit-release.json
 *   2) PREVIEW it — shows the exact op, asks for NO key, sends nothing:
 *        node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts /tmp/morphit-release.json --dry-run
 *   3) Sign + broadcast for real (prompts for the key, masked):
 *        node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts /tmp/morphit-release.json
 *
 * Flags:
 *   --dry-run        Print the exact op and exit.  No key, no network.
 *   --signer <acct>  Signing account (default: morphit).
 *   --node <url>     Use exactly this RPC node (default: the six clearnet
 *                    DEFAULT_BLURT_RPC_ENDPOINTS, health-ranked).
 *   --include-hidden Also rank the 14 hidden (.onion / .b32.i2p) nodes, through
 *                    this machine's Tor SOCKS / i2pd proxy (env
 *                    MORPHIT_INDEXER_TOR_SOCKS / MORPHIT_INDEXER_I2P_HTTP_PROXY).
 *                    Off by default: a laptop may run neither.
 *
 * The transaction is SIGNED ONCE and that exact transaction is offered to the
 * ranked nodes in turn (v1.20.0, D12 — see scripts/lib/signOnceBroadcast.ts);
 * it used to be re-signed per node, so a lost acceptance became a second op.
 *
 * The @morphit PRIVATE posting key (the WIF) is read from a MASKED
 * prompt at runtime — never a
 * file, never an env var (which would leak to shell history / `ps`),
 * never logged.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PrivateKey } from '@beblurt/dblurt';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import { askHidden, broadcastCustomJsonOnce, candidateNodes } from './lib/signOnceBroadcast.ts';
import { waitForHistoryListing } from './lib/historyListing.ts';

import {
	buildReleaseCustomJsonOp,
	RELEASE_SIGNER_DEFAULT,
	RELEASE_OP_ID
} from '../src/blurt/releaseBroadcastOp.ts';

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
function die(msg: string): never {
	process.stderr.write(`\n✗ ${msg}\n`);
	process.exit(1);
}

// ── argv ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let dryRun = false;
let signer = RELEASE_SIGNER_DEFAULT;
let nodeOverride: string | null = null;
let includeHidden = false;
let fileArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--dry-run') dryRun = true;
	else if (a === '--signer') signer = argv[++i] ?? signer;
	else if (a === '--node') nodeOverride = argv[++i] ?? null;
	else if (a === '--include-hidden') includeHidden = true;
	else if (!a.startsWith('--') && fileArg === null) fileArg = a;
}
if (!fileArg) {
	die(
		'usage: tsx release-broadcast.ts <release.json> [--dry-run] [--signer <acct>] [--node <url>] [--include-hidden]\n' +
			'  build the file first:  tsx release-build-payload.ts > /tmp/morphit-release.json'
	);
}

// ── read + validate + shape the op (pure; throws on any problem) ───
let payloadJson: string;
try {
	payloadJson = readFileSync(fileArg, 'utf-8');
} catch (e) {
	die(`cannot read ${fileArg}: ${errMsg(e)}`);
}
// annotate rather than leave `op` implicitly `any`.  This is the
// laptop-only release-broadcast CLI: the op it builds is what gets SIGNED and
// pushed on-chain, so `any` here erased type checking on the one payload in
// the repo that is irreversible once broadcast.
let op: ReturnType<typeof buildReleaseCustomJsonOp>;
try {
	op = buildReleaseCustomJsonOp(payloadJson, signer);
} catch (e) {
	die(errMsg(e));
}
const nodes = nodeOverride
	? [nodeOverride]
	: [...DEFAULT_BLURT_RPC_ENDPOINTS, ...(includeHidden ? ['(+ 14 hidden nodes)'] : [])];

process.stderr.write(
	'\n┌─────────────────────────────────────────────────────────────┐\n' +
		'│  release-broadcast — LAPTOP ONLY (uses the @morphit         │\n' +
		'│  PRIVATE posting key / WIF).  Never run on the server.      │\n' +
		'└─────────────────────────────────────────────────────────────┘\n\n'
);
process.stderr.write(`Operation id : ${op.id}\n`);
process.stderr.write(`Signed by    : @${op.required_posting_auths[0]} (posting authority)\n`);
process.stderr.write(`RPC node(s)  : ${nodes.join(', ')}\n`);
process.stderr.write('\nExact json that will be signed + broadcast:\n');
process.stderr.write(`${op.json}\n`);

// ── dry-run: stop here.  No key requested, nothing sent. ───────────
if (dryRun) {
	process.stderr.write('\n--dry-run: NOTHING was broadcast and NO key was requested.\n');
	process.stderr.write('Re-run without --dry-run to sign + broadcast for real.\n');
	process.exit(0);
}

// ── masked prompt helpers ──────────────────────────────────────────
function ask(query: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans.trim());
		});
	});
}

async function main(): Promise<void> {
	const confirm = await ask(
		`\nType the signer account name to confirm broadcast (or anything else to abort): `
	);
	if (confirm !== op.required_posting_auths[0]) {
		die('aborted (confirmation did not match the signer account name).');
	}

	const wif = await askHidden(
		`\n→ NOW PASTE the @${op.required_posting_auths[0]} PRIVATE posting key` +
			` (the WIF — it starts with "5") and press Enter.\n` +
			`  Nothing will show as you paste it — that is intentional; the key stays hidden.\n`
	);
	if (!wif.startsWith('5') || wif.length < 50) {
		die('that does not look like a Blurt WIF private key (expected a "5..." string).');
	}

	let priv: PrivateKey;
	try {
		priv = PrivateKey.fromString(wif);
	} catch (e) {
		die(`could not parse the key: ${errMsg(e)}`);
	}

	// Show the derived public key so the operator can eyeball it
	// against @morphit's known posting pubkey before sending.  (We do
	// NOT print the private key, ever.)
	try {
		const pub = priv.createPublic('BLT').toString();
		process.stderr.write(`\nDerived public key: ${pub}\n`);
	} catch {
		/* non-fatal — proceed; the broadcast itself will fail loudly if
		   the key is wrong for the account's posting authority. */
	}
	const go = await ask(
		`Broadcast morphit_release_v1 signed by @${op.required_posting_auths[0]} now? (type "yes"): `
	);
	if (go !== 'yes') die('aborted.');

	const opData = {
		required_auths: [...op.required_auths],
		required_posting_auths: [...op.required_posting_auths],
		id: op.id,
		json: op.json
	};

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
			`  op id     : ${RELEASE_OP_ID}\n\n` +
			'Every Morphit instance picks up the chain-pinned treasury within a block.\n'
	);

	// A block is not yet the account history, where every server's upgrade
	// looks for this record: wait until the nodes list it (morphit.io,
	// 2026-10-08: an upgrade started right after the broadcast refused).
	process.stderr.write(
		`\nWaiting until the nodes list ${res.trxId} in @${op.required_posting_auths[0]}'s history (up to 5 minutes) …\n`
	);
	const listing = await waitForHistoryListing({
		nodes: candidateNodes({ nodeOverride, includeHidden }),
		account: op.required_posting_auths[0],
		trxId: res.trxId
	});
	if (listing.complete) {
		process.stdout.write(
			`✓ ${listing.listed.length} node(s) list the release record in @${op.required_posting_auths[0]}'s history. Block 5 can start.\n`
		);
	} else if (listing.listed.length === 0 && listing.notListed.length === 0) {
		process.stdout.write(
			'No node answered the history check from this machine. Before Block 5, check the transaction id above on a block explorer.\n'
		);
	} else {
		process.stdout.write(
			`Not listed yet by: ${listing.notListed.join(', ')}.\n` +
				'An upgrade whose indexer reads from one of those may say it finds no release record; running it again a little later works.\n'
		);
	}
}

void main();
