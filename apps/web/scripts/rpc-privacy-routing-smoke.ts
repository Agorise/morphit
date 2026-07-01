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
 *   TRUST (must NOT be "optimized" into the indexer): release / payment /
 *   chat-identity VERIFICATION reads deliberately go direct to chain via the
 *   node-hopping rotator — and the security-critical ones across a MULTI-NODE
 *   quorum — precisely because the operator's own indexer is a single party
 *   that could forge a release, a "payment received" confirmation, or a chat
 *   identity. Routing these through the indexer would reintroduce exactly the
 *   forgery the quorum/trust-anchor defends against. This smoke fails if anyone
 *   reroutes them to a single same-origin call.
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

// ─── TRUST: verification stays direct-to-chain (rotator / multi-node quorum) ──
const blurtVerify = read('src/lib/chat/blurtVerify.ts');
check(
	'payment verification (blurtVerify) uses a multi-node quorum (callMany), not a single call',
	/getRotator\(\)/.test(blurtVerify) &&
		/\.callMany<[^>]*>\(\s*'condenser_api\.get_transaction'/.test(blurtVerify) &&
		// must NOT route the transfer check through the same-origin indexer
		!/\/v1\/(chain|account|broadcast)/.test(blurtVerify)
);

const chainOpVerify = read('src/lib/chat/chainOpVerify.ts');
check(
	'op verification (chainOpVerify) fetches the tx via the rotator, not the indexer',
	/getRotator\(\)/.test(chainOpVerify) &&
		/condenser_api\.get_transaction/.test(chainOpVerify) &&
		!/\/v1\/(chain|account)/.test(chainOpVerify)
);

const chainVerify = read('src/lib/chat/chainVerify.ts');
check(
	'chat-identity verification (chainVerify) reads chain history directly, not the indexer',
	(/getBlurtClient\(\)/.test(chainVerify) || /getRotator\(\)/.test(chainVerify)) &&
		!/\/v1\/(account|chain)\b/.test(chainVerify)
);

const releaseFetch = read('src/lib/net/releaseFetch.ts');
check(
	'release verification (releaseFetch) reads the signed op direct-to-chain via getBlurtClient',
	/getBlurtClient\(\)/.test(releaseFetch) && /getLatestCustomJson/.test(releaseFetch)
);
check(
	'releaseFetch documents WHY it avoids the indexer (trust anchor / forgery)',
	/trust anchor/i.test(releaseFetch) && /forge/i.test(releaseFetch)
);

// ─── The cp344 broadcast fallback is the only sanctioned direct WRITE path ───
const broadcastTransport = read('src/lib/blurt/broadcastTransport.ts');
check(
	'broadcastTransport prefers the same-origin indexer and only falls back to direct RPC',
	/\/v1\/broadcast/.test(broadcastTransport) &&
		/fall back|fallback/i.test(broadcastTransport) &&
		/getBlurtClient\(\)/.test(broadcastTransport)
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} rpc-privacy-routing scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
