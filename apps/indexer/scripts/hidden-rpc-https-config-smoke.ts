/**
 * hidden-rpc-https-config-smoke — MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS written
 * with https:// (v1.20.0 fix wave 3). Runs the REAL loadConfig.
 *
 * The hidden-network connectors now REFUSE an https:// URL (S9: Tor and I2P
 * carry plain HTTP; the network encrypts and authenticates). An operator-written
 * `https://<host>.onion` endpoint used to "work", dialled as plaintext HTTP to
 * the URL's port (80 when none was written, and https://host:443 parses as no
 * port), so after the connector change the pool would quietly lose that node.
 * Config load rewrites it to the http:// URL the transport always really
 * dialled, and says so on the console.
 *
 * Run from apps/indexer: npx tsx scripts/hidden-rpc-https-config-smoke.ts
 */
import { loadConfig } from '../src/config/index.ts';

let failed = 0;
let passed = 0;
const ok = (m: string): void => {
	console.log(`  ✓ ${m}`);
	passed++;
};
const bad = (m: string, d: string): void => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failed++;
};
const check = (cond: boolean, m: string, d: string): void => (cond ? ok(m) : bad(m, d));

const ONION = 'f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion';
const I2P = 'zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p';
const KNOB = 'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS';

process.env.MORPHIT_INDEXER_DATABASE_URL = 'postgres://u:p@localhost:5432/morphit_indexer';
process.env.MORPHIT_INDEXER_RELAY_ACCOUNT = 'tester';
process.env.MORPHIT_INDEXER_FEE_RECIPIENT = 'tester';
process.env.MORPHIT_INDEXER_PUBLIC_ORIGIN = 'https://indexer.example.org';
process.env.MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY =
	'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';
process.env.MORPHIT_INDEXER_CHAIN_ID =
	'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';

/** loadConfig with the console's warnings captured. */
function load(): { endpoints: readonly string[] | null; error: string | null; warned: string[] } {
	const warned: string[] = [];
	const orig = console.warn;
	console.warn = (...a: unknown[]): void => {
		warned.push(a.map(String).join(' '));
	};
	try {
		return { endpoints: loadConfig().hiddenRpcEndpoints, error: null, warned };
	} catch (e) {
		return { endpoints: null, error: e instanceof Error ? e.message : String(e), warned };
	} finally {
		console.warn = orig;
	}
}

// 1. https:// hidden endpoints reach the pool as http://, one warning each.
process.env[KNOB] = [
	`https://${ONION}`,
	`https://${I2P}:8091`,
	`https://${ONION}:443/rpc`,
	`http://${ONION}:8091`
].join(',');
{
	const r = load();
	const want = [
		`http://${ONION}`,
		`http://${I2P}:8091`,
		`http://${ONION}/rpc`,
		`http://${ONION}:8091`
	];
	check(
		JSON.stringify(r.endpoints) === JSON.stringify(want),
		'an https:// hidden endpoint reaches the pool as the http:// URL the transport dials',
		`got ${JSON.stringify(r.endpoints ?? r.error)}, want ${JSON.stringify(want)}`
	);
	const rewrites = r.warned.filter((m) => m.includes(KNOB));
	check(
		rewrites.length === 3,
		'each rewrite is logged once, and an http:// endpoint is not',
		`${rewrites.length} warnings: ${JSON.stringify(rewrites)}`
	);
	check(
		(rewrites[0] ?? '').includes(`https://${ONION}`) &&
			(rewrites[0] ?? '').includes(`http://${ONION}`),
		'the warning names what was written and what is dialled',
		JSON.stringify(rewrites[0])
	);
}

// 2. The host guard still holds, whatever the scheme.
for (const u of ['https://rpc.example.org', 'http://rpc.example.org']) {
	process.env[KNOB] = u;
	const r = load();
	check(
		r.error !== null && /hidden RPC endpoints must be \.onion or \.b32\.i2p/.test(r.error),
		`a clearnet host in the hidden knob is still refused (${u})`,
		JSON.stringify(r.endpoints ?? r.error)
	);
}

// 3. The http:// defaults pass untouched and silently.
delete process.env[KNOB];
{
	const r = load();
	check(
		r.endpoints !== null &&
			r.endpoints.length > 0 &&
			r.endpoints.every((u) => u.startsWith('http://')),
		'the baked http:// defaults load unchanged',
		JSON.stringify(r.endpoints ?? r.error)
	);
	check(
		r.warned.every((m) => !m.includes(KNOB)),
		'and nothing is said about them',
		JSON.stringify(r.warned)
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\nhidden-rpc-https-config smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} hidden-rpc-https-config scenarios passed`);
