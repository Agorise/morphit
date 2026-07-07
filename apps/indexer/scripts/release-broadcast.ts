/**
 * release-broadcast (cp317) — sign + broadcast a morphit_release_v1 op.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LAPTOP ONLY.  This uses the @morphit POSTING key, which by   │
 * │  design lives OFF the production server.  Never run this on   │
 * │  the VPS.                                                     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Pipeline:
 *   1) Build the payload (pre-filled with the canonical treasury):
 *        npx tsx apps/indexer/scripts/release-build-payload.ts > release.json
 *   2) PREVIEW it — shows the exact op, asks for NO key, sends nothing:
 *        npx tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run
 *   3) Sign + broadcast for real (prompts for the key, masked):
 *        npx tsx apps/indexer/scripts/release-broadcast.ts release.json
 *
 * Flags:
 *   --dry-run        Print the exact op and exit.  No key, no network.
 *   --signer <acct>  Signing account (default: morphit).
 *   --node <url>     Override the RPC node(s) (default: the project's
 *                    DEFAULT_BLURT_RPC_ENDPOINTS, tried in order).
 *
 * The posting key is read from a MASKED prompt at runtime — never a
 * file, never an env var (which would leak to shell history / `ps`),
 * never logged.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, PrivateKey } from '@beblurt/dblurt';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
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
let fileArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--dry-run') dryRun = true;
	else if (a === '--signer') signer = argv[++i] ?? signer;
	else if (a === '--node') nodeOverride = argv[++i] ?? null;
	else if (!a.startsWith('--') && fileArg === null) fileArg = a;
}
if (!fileArg) {
	die(
		'usage: tsx release-broadcast.ts <release.json> [--dry-run] [--signer <acct>] [--node <url>]\n' +
			'  build the file first:  tsx release-build-payload.ts > release.json'
	);
}

// ── read + validate + shape the op (pure; throws on any problem) ───
let payloadJson: string;
try {
	payloadJson = readFileSync(fileArg, 'utf-8');
} catch (e) {
	die(`cannot read ${fileArg}: ${errMsg(e)}`);
}
let op;
try {
	op = buildReleaseCustomJsonOp(payloadJson, signer);
} catch (e) {
	die(errMsg(e));
}
const nodes = nodeOverride ? [nodeOverride] : [...DEFAULT_BLURT_RPC_ENDPOINTS];

process.stderr.write(
	'\n┌─────────────────────────────────────────────────────────────┐\n' +
		'│  release-broadcast — LAPTOP ONLY (uses the @morphit posting   │\n' +
		'│  key).  Never run this on the production server.              │\n' +
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
function askHidden(query: string): Promise<string> {
	process.stdout.write(query);
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		// Suppress all keystroke echo so the WIF never appears on screen.
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
		rl.question('', (ans) => {
			rl.close();
			process.stdout.write('\n');
			resolve(ans.trim());
		});
	});
}
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
		`Paste the @${op.required_posting_auths[0]} POSTING key (WIF, starts "5..."): `
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

	let lastErr: unknown;
	for (const url of nodes) {
		try {
			process.stderr.write(`\nBroadcasting via ${url} …\n`);
			const client = new Client(url, { timeout: 20_000 });
			const conf = (await client.broadcast.customJson(opData, priv)) as {
				id?: string;
				block_num?: number;
			};
			process.stdout.write(
				`\n✓ Broadcast accepted.\n  trx_id    : ${conf.id ?? '(unknown)'}\n` +
					`  block_num : ${conf.block_num ?? '(pending)'}\n` +
					`  op id     : ${RELEASE_OP_ID}\n\n` +
					'Every Morphit instance picks up the chain-pinned treasury within a block.\n'
			);
			return;
		} catch (e) {
			lastErr = e;
			process.stderr.write(`  ✗ ${url}: ${errMsg(e)}\n`);
		}
	}
	die(`all RPC nodes failed. Last error: ${errMsg(lastErr)}`);
}

void main();
