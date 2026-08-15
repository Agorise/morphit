/**
 * rpc-directory-broadcast (v1.12.0) — sign + broadcast a `morphit_rpc_v1` op:
 * the canonical directory of PUBLIC hidden-service Blurt RPC nodes. Every
 * trusting indexer self-populates its hidden pool from it, so a vetted node is
 * added ecosystem-wide with no code change.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LAPTOP ONLY.  Uses the @morphit PRIVATE posting key (WIF),  │
 * │  which by design lives OFF the production servers.           │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   1) Inspect the built-in starter directory (Star + Jade) without a key:
 *        npx tsx apps/indexer/scripts/rpc-directory-broadcast.ts --dry-run
 *   2) Publish a custom directory from a JSON file:
 *        npx tsx apps/indexer/scripts/rpc-directory-broadcast.ts dir.json --dry-run
 *        npx tsx apps/indexer/scripts/rpc-directory-broadcast.ts dir.json
 *
 * Flags: --dry-run (print the op, no key, no network), --signer <acct>,
 *        --node <rpc-url> (override the broadcast node).
 *
 * The JSON file (when given) is the payload: { "v": 1, "ts": "<ISO>",
 * "nodes": [ { "name": "Star", "onion": "http://…onion:8091",
 * "i2p": "http://…b32.i2p:8091" }, … ] }.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, PrivateKey } from '@beblurt/dblurt';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import {
	buildRpcDirectoryCustomJsonOp,
	validateRpcDirectoryPayload,
	RPC_DIRECTORY_SIGNER_DEFAULT,
	RPC_DIRECTORY_OP_ID,
	type RpcDirectoryPayload,
	type RpcDirectoryCustomJsonOp
} from '../src/blurt/rpcDirectoryOp.ts';

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
function die(msg: string): never {
	process.stderr.write(`\n\u2717 ${msg}\n`);
	process.exit(1);
}

/** The built-in starter directory: the two public nodes shipped as the baked
 *  default. Used when no JSON file is passed, so the first publish is one
 *  command. Edit here (or pass a file) to add nodes. */
function starterDirectory(): RpcDirectoryPayload {
	return {
		v: 1,
		ts: new Date().toISOString(),
		nodes: [
			{
				name: 'Star',
				onion: 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091',
				i2p: 'http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091'
			},
			{
				name: 'Jade',
				onion: 'http://axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion:8091',
				i2p: 'http://7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p:8091'
			}
		]
	};
}

// ── argv ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let dryRun = false;
let signer = RPC_DIRECTORY_SIGNER_DEFAULT;
let nodeOverride: string | null = null;
let fileArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a === '--dry-run') dryRun = true;
	else if (a === '--signer') signer = argv[++i] ?? signer;
	else if (a === '--node') nodeOverride = argv[++i] ?? null;
	else if (!a.startsWith('--') && fileArg === null) fileArg = a;
}

// ── read/build + validate + shape the op (pure; throws on any problem) ──
let payloadInput: unknown;
if (fileArg) {
	let raw: string;
	try {
		raw = readFileSync(fileArg, 'utf-8');
	} catch (e) {
		die(`cannot read ${fileArg}: ${errMsg(e)}`);
	}
	try {
		payloadInput = JSON.parse(raw);
	} catch (e) {
		die(`${fileArg} is not valid JSON: ${errMsg(e)}`);
	}
} else {
	payloadInput = starterDirectory();
	process.stderr.write('(no file given — using the built-in starter directory: Star + Jade)\n');
}

const pre = validateRpcDirectoryPayload(payloadInput);
if (!pre.ok) die(`invalid rpc-directory payload: ${pre.reason}`);

let op: RpcDirectoryCustomJsonOp;
try {
	op = buildRpcDirectoryCustomJsonOp(payloadInput, signer);
} catch (e) {
	die(errMsg(e));
}

const nodes = nodeOverride ? [nodeOverride] : [...DEFAULT_BLURT_RPC_ENDPOINTS];

process.stderr.write(
	'\n\u250c\u2500 rpc-directory-broadcast \u2014 LAPTOP ONLY (uses the @morphit PRIVATE posting key). \u2500\u2510\n' +
		'\u2514\u2500 Never run on the server. \u2500\u2518\n'
);
process.stderr.write(`Signed by    : @${op.required_posting_auths[0]} (posting authority)\n`);
process.stderr.write(`Nodes in dir : ${pre.payload.nodes.length}\n`);
process.stderr.write('\nExact json that will be signed + broadcast:\n');
process.stderr.write(`${op.json}\n`);

if (dryRun) {
	process.stderr.write('\n--dry-run: NOTHING was broadcast and NO key was requested.\n');
	process.stderr.write('Re-run without --dry-run to sign + broadcast for real.\n');
	process.exit(0);
}

function askHidden(query: string): Promise<string> {
	process.stderr.write(query);
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
		rl.question('', (ans) => {
			rl.close();
			process.stderr.write('\n');
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
	if (confirm !== op.required_posting_auths[0]) die('aborted.');

	const wif = await askHidden(
		`\n\u2192 NOW PASTE the @${op.required_posting_auths[0]} PRIVATE posting key` +
			` (the WIF \u2014 it starts with "5") and press Enter.\n` +
			`  Nothing will show as you paste it \u2014 that is intentional; the key stays hidden.\n` +
			`  key> `
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
	try {
		process.stderr.write(`\nDerived public key: ${priv.createPublic('BLT').toString()}\n`);
	} catch {
		/* non-fatal — the broadcast fails loudly if the key is wrong. */
	}

	const go = await ask(
		`Broadcast ${RPC_DIRECTORY_OP_ID} signed by @${op.required_posting_auths[0]} now? (type "yes"): `
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
			process.stderr.write(`\nBroadcasting via ${url} \u2026\n`);
			const client = new Client(url, { timeout: 20_000 });
			const conf = (await client.broadcast.customJson(opData, priv)) as {
				id?: string;
				block_num?: number;
			};
			process.stdout.write(
				`\n\u2713 Broadcast accepted.\n  trx_id    : ${conf.id ?? '(unknown)'}\n` +
					`  block_num : ${conf.block_num ?? '(pending)'}\n` +
					`  op id     : ${RPC_DIRECTORY_OP_ID}\n\n` +
					'Every trusting Morphit instance merges these nodes into its hidden RPC pool within a block.\n'
			);
			return;
		} catch (e) {
			lastErr = e;
			process.stderr.write(`  \u2717 ${url}: ${errMsg(e)}\n`);
		}
	}
	die(`all RPC nodes failed. Last error: ${errMsg(lastErr)}`);
}

void main();
