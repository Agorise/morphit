/**
 * rpc-privacy-routing-smoke (cp346)
 *
 * Pins the browser→chain routing policy so it can't silently regress in EITHER
 * direction:
 *
 *   PRIVACY (priority #1): reads that only need PUBLIC data and carry no trust
 *   weight must go through the SAME-ORIGIN indexer, so third-party RPC nodes
 *   never see the user's IP or which account they're touching. Today that's the
 *   pairing posting-key lookup (cp346 — fetchAccountKeys, never a direct
 *   condenser_api.get_accounts) and the seed-import reverse key→name lookup
 *   (cp351 accountByKey — POST /v1/chain/key-references, never a direct
 *   condenser_api.get_key_references). A general sweep also fails if ANY web
 *   source file makes a direct get_key_references call, so the next instance of
 *   this class can't slip past an enumerated allowlist (the gap that let the
 *   original accountByKey ship direct).
 *
 *   TRUST — cp410 policy. PAYMENT, chat-IDENTITY and op-signature verification
 *   now route through the same-origin indexer (privacy #1); the browser's old
 *   multi-node quorum is gone. To keep the money-critical payment check
 *   trustless for the cautious, the chat UI offers an independent block-explorer
 *   "Verify" link instead. RELEASE verification is the SOLE exception: it still
 *   reads the real chain DIRECTLY (getDirectChainClient), because its anti-tamper
 *   trust anchor is meaningless if it trusts the operator's own indexer — a
 *   malicious operator could otherwise forge a "verified" release. This smoke
 *   fails if payment/identity/op verification regress to a direct-node read, if
 *   release verification is rerouted through the indexer, or if any flow OTHER
 *   than release verification uses the direct-to-chain reader.
 *
 * Static source scan (the rotator module pulls $app/environment, which the
 * smoke runner can't resolve, so we assert on source rather than importing).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const read = (p: string): string => readFileSync(join(webRoot, p), 'utf8');

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\nrpc-privacy-routing smoke:\n');

// ─── PRIVACY: pairing reads PUBLIC keys via the same-origin indexer ──────────
const pairingClient = read('src/lib/auth/pairingClient.ts');
const pairingPhone = read('src/lib/auth/pairingPhoneSigner.ts');

check(
	'pairingClient fetches keys via the indexer (fetchAccountKeys), not direct RPC',
	pairingClient.includes('fetchAccountKeys') &&
		!/condenser_api\.get_accounts/.test(pairingClient)
);
check(
	'pairingPhoneSigner fetches keys via the indexer (fetchAccountKeys), not direct RPC',
	pairingPhone.includes('fetchAccountKeys') && !/condenser_api\.get_accounts/.test(pairingPhone)
);

// ─── PRIVACY: seed-import reverse key→name lookup is same-origin (cp351) ──────
const accountByKey = read('src/lib/blurt/accountByKey.ts');
check(
	'accountByKey resolves via the same-origin indexer (POST /v1/chain/key-references)',
	/\/v1\/chain\/key-references/.test(accountByKey) &&
		/fetchWithTimeout/.test(accountByKey)
);
check(
	'accountByKey does NOT call get_key_references directly (no browser→3rd-party RPC leak)',
	!/['"](?:condenser_api\.)?get_key_references['"]/.test(accountByKey) &&
		!/getBlurtClient/.test(accountByKey)
);

// General sweep: NO web source file may call condenser_api.get_key_references
// directly. accountByKey is the only key→name lookup and it must stay
// same-origin; an enumerated check (above) wouldn't catch a NEW file doing it
// direct — exactly how the original accountByKey shipped a direct call past
// the cp346 allowlist. Walk every .ts/.svelte under src/. A DIRECT call passes
// the method as a quoted string argument; a comment/doc mention uses backticks
// or bare prose, so the quoted-string pattern targets only real call sites.
function walk(dir: string, acc: string[]): string[] {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, ent.name);
		if (ent.isDirectory()) walk(full, acc);
		else if (/\.(ts|svelte)$/.test(ent.name)) acc.push(full);
	}
	return acc;
}
const srcFiles = walk(join(webRoot, 'src'), []);
const directKeyRefOffenders = srcFiles.filter((f) =>
	/['"](?:condenser_api\.)?get_key_references['"]/.test(readFileSync(f, 'utf8'))
);
check(
	'no web source calls condenser_api.get_key_references directly (sweep)',
	directKeyRefOffenders.length === 0
);
if (directKeyRefOffenders.length > 0) {
	for (const f of directKeyRefOffenders) console.log(`      ↳ direct get_key_references in ${f}`);
}

// The same-origin lookup needs the indexer endpoint to exist (else the import
// flow silently falls back to manual entry forever). Pin the proxy route.
const indexerChainExplorer = readFileSync(
	join(webRoot, '..', 'indexer', 'src', 'api', 'chainExplorer.ts'),
	'utf8'
);
check(
	'indexer exposes the same-origin key-references proxy (POST /key-references + get_key_references)',
	/['"]\/key-references['"]/.test(indexerChainExplorer) &&
		/get_key_references/.test(indexerChainExplorer)
);

// ─── TRUST: payment / identity / op verification now route through the indexer ─
// cp410 — these used to read direct-to-chain across a multi-node quorum; they
// now go through the same-origin indexer relay (chainRelay), and must NOT use
// the node-hopping rotator or its callMany quorum any more.
const blurtVerify = read('src/lib/chat/blurtVerify.ts');
check(
	'payment verification (blurtVerify) routes through the indexer relay (chainRelay), not the rotator',
	/chainRelay/.test(blurtVerify) && !/getRotator\(\)/.test(blurtVerify) && !/\.callMany\b/.test(blurtVerify)
);

const chainOpVerify = read('src/lib/chat/chainOpVerify.ts');
check(
	'op verification (chainOpVerify) routes through the indexer relay (chainRelay), not the rotator',
	/chainRelay/.test(chainOpVerify) && !/getRotator\(\)/.test(chainOpVerify)
);

const chainVerify = read('src/lib/chat/chainVerify.ts');
check(
	'chat-identity verification (chainVerify) routes through the indexer relay (chainRelay), not the rotator',
	/chainRelay/.test(chainVerify) && !/getRotator\(\)/.test(chainVerify) && !/\.callMany\b/.test(chainVerify)
);

// ─── TRUST EXCEPTION: release verification stays DIRECT-to-chain ──────────────
// The sole sanctioned browser→node reader. Its anti-tamper anchor is worthless
// if it trusts the operator's own indexer (which could forge a "verified"
// release), so it MUST read the real chain via getDirectChainClient.
const releaseFetch = read('src/lib/net/releaseFetch.ts');
check(
	'release verification (releaseFetch) reads direct-to-chain via getDirectChainClient',
	/getDirectChainClient\(\)/.test(releaseFetch) && /getLatestCustomJson/.test(releaseFetch)
);
check(
	'releaseFetch does NOT route through the indexer (no getBlurtClient, no /v1 relay)',
	!/getBlurtClient\b/.test(releaseFetch) && !/\/v1\/(chain|account)/.test(releaseFetch)
);
check(
	'releaseFetch documents WHY it avoids the indexer (trust anchor / forgery)',
	/trust anchor/i.test(releaseFetch) && /forge/i.test(releaseFetch)
);

// getDirectChainClient is the ONE sanctioned browser→node reader. Sweep every
// web source: only releaseFetch may call it, and only blurt/client.ts (where it
// is defined and wired to the rotator) may reference it. A NEW file calling it
// would be a fresh direct-to-chain leak — fail loudly.
const directClientOffenders = srcFiles.filter((f) => {
	if (f.endsWith('lib/blurt/client.ts') || f.endsWith('lib/net/releaseFetch.ts')) return false;
	// Match a CALL `getDirectChainClient(` — a bare mention in a comment (e.g.
	// endpoints.ts documenting why the rotator exists) is not a direct-chain read.
	return /getDirectChainClient\(/.test(readFileSync(f, 'utf8'));
});
check('only releaseFetch uses the direct-to-chain client (sweep)', directClientOffenders.length === 0);
if (directClientOffenders.length > 0) {
	for (const f of directClientOffenders) console.log(`      ↳ direct-chain client used in ${f}`);
}

// ─── BROADCAST: same-origin indexer ONLY — no direct-to-node fallback ────────
// cp410 removed the cp344 direct-RPC fallback. Broadcasts go through
// /v1/broadcast and fail (BroadcastUnavailableError) if the indexer is
// unreachable — they never leak to a third-party node.
const broadcastTransport = read('src/lib/blurt/broadcastTransport.ts');
check(
	'broadcastTransport broadcasts ONLY through the same-origin indexer (/v1/broadcast)',
	/\/v1\/broadcast/.test(broadcastTransport)
);
check(
	'broadcastTransport has NO direct-RPC fallback (no getBlurtClient, no directRpcBroadcast)',
	!/getBlurtClient\b/.test(broadcastTransport) &&
		!/directRpcBroadcast/.test(broadcastTransport) &&
		/no direct-rpc fallback/i.test(broadcastTransport)
);

// ─── The indexer exposes the generic read-only condenser relay (cp410) ───────
check(
	'indexer exposes the read-only condenser relay (POST /condenser, whitelisted)',
	/['"]\/condenser['"]/.test(indexerChainExplorer) && /RELAYABLE_READ_METHODS/.test(indexerChainExplorer)
);

console.log('');
// A page served from a .onion/.i2p origin must use a HIDDEN-ONLY RPC pool — the
// visitor is on Tor/I2P and their browser must never open a clearnet connection,
// not even as a fallback. getRotator() drops DEFAULT_RPC_ENDPOINTS in that case.
{
	const endpointsSrc = read('src/lib/net/endpoints.ts');
	check(
		'served-from-hidden origin → hidden-only RPC pool (no clearnet fall-through)',
		/servedFromHidden/.test(endpointsSrc) &&
			/\.endsWith\('\.onion'\)\s*\|\|\s*h\.endsWith\('\.i2p'\)/.test(endpointsSrc) &&
			/servedFromHidden\s*\?\s*\[\.\.\.DEFAULT_HIDDEN_RPC_ENDPOINTS\]/.test(endpointsSrc)
	);
}

if (failed === 0) {
	console.log(`\u2713 all ${passed} rpc-privacy-routing scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
