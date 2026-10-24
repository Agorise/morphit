#!/usr/bin/env tsx
/**
 * scripts/canary-tor-only-routing-smoke.ts
 *
 * locks the tor-only privacy fix for the warrant-canary freshness
 * proofs (audit finding F-1). On a tor-only node the canary's outbound fetches
 * (Blurt chain-head, Bitcoin head, news RSS) must route through the co-located
 * Tor SOCKS proxy so the node's real clearnet IP is never revealed to those
 * endpoints — the same exposure a later change closed for the indexer's own reads.
 *
 * This smoke asserts, without needing a live Tor daemon:
 *   - the SOCKS5 wire bytes are correct (greeting, ATYP=domain CONNECT,
 *     reply parsing) — pure, socket-free;
 *   - `installTorDispatcherIfTorOnly` is a NO-OP on clearnet (byte-identical
 *     clearnet behavior) and reports the Tor route only when tor-only;
 *   - generate.sh derives tor-only (explicit flag OR .onion/.i2p origin),
 *     exports the two env vars the Node helpers read, and routes the news curl
 *     through socks5h:// on tor-only while staying proxy-free on clearnet;
 *   - both Node helpers install the dispatcher before fetching.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	socks5Greeting,
	socks5ConnectRequest,
	parseSocks5Greeting,
	parseSocks5ConnectReply,
	parseHostPort,
	canaryIsTorOnly,
	canaryHiddenDispatcherFor,
	canaryHostLooksHidden,
	installTorDispatcherIfTorOnly
} from './canary/torSocksDispatcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

console.log('\n── canary tor-only routing smoke (cp761) ──────────────\n');

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

// ── SOCKS5 wire bytes (pure) ──────────────────────────────────────
const greet = socks5Greeting();
check('greeting is [0x05,0x01,0x00]', greet.length === 3 && greet[0] === 0x05 && greet[1] === 0x01 && greet[2] === 0x00);

const req = socks5ConnectRequest('rpc.example.org', 443);
check('CONNECT uses SOCKS v5 + CMD CONNECT', req[0] === 0x05 && req[1] === 0x01 && req[2] === 0x00);
check('CONNECT uses ATYP=domain (0x03) — proxy-side DNS, no local resolve/leak', req[3] === 0x03);
check('CONNECT encodes the hostname length + bytes', req[4] === 'rpc.example.org'.length && req.subarray(5, 5 + 15).toString('ascii') === 'rpc.example.org');
check('CONNECT encodes the port big-endian (443)', req.readUInt16BE(5 + 15) === 443);

check('greeting reply [0x05,0x00] parses ok', parseSocks5Greeting(Buffer.from([0x05, 0x00])).ok === true);
check('greeting requiring auth is rejected', parseSocks5Greeting(Buffer.from([0x05, 0x02])).ok === false);
check('CONNECT reply rep=0x00 is success', parseSocks5ConnectReply(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])).ok === true);
check('CONNECT reply rep!=0x00 is failure', parseSocks5ConnectReply(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])).ok === false);

check('parseHostPort splits host:port', parseHostPort('127.0.0.1:9050', 9050).host === '127.0.0.1' && parseHostPort('127.0.0.1:9050', 9050).port === 9050);
check('parseHostPort falls back to default port', parseHostPort('127.0.0.1', 9050).port === 9050);

// ── installer behavior (no live Tor needed) ───────────────────────
check('canaryIsTorOnly false when unset', canaryIsTorOnly({}) === false);
check('canaryIsTorOnly true only for "1"', canaryIsTorOnly({ MORPHIT_CANARY_TOR_ONLY: '1' }) === true && canaryIsTorOnly({ MORPHIT_CANARY_TOR_ONLY: 'yes' }) === false);
check('installer is a no-op on clearnet (reports direct)', installTorDispatcherIfTorOnly({}) === 'clearnet (direct)');
{
	const route = installTorDispatcherIfTorOnly({ MORPHIT_CANARY_TOR_ONLY: '1', MORPHIT_CANARY_TOR_SOCKS: '127.0.0.1:9150' });
	check('installer reports the tor route + custom SOCKS on tor-only', route === 'tor-only (SOCKS 127.0.0.1:9150)');
}

// ── generate.sh wiring ────────────────────────────────────────────
const gen = read('scripts/canary/generate.sh');
check('generate.sh detects tor-only from a hidden-service origin', /\*\.onion \| \*\.i2p\) CANARY_TOR_ONLY=1/.test(gen));
check('generate.sh honors an explicit MORPHIT_CANARY_TOR_ONLY', /MORPHIT_CANARY_TOR_ONLY:-auto/.test(gen));
check('generate.sh exports MORPHIT_CANARY_TOR_ONLY for the Node helpers', /export MORPHIT_CANARY_TOR_ONLY=/.test(gen));
check('generate.sh exports MORPHIT_CANARY_TOR_SOCKS for the Node helpers', /export MORPHIT_CANARY_TOR_SOCKS=/.test(gen));
check('news curl uses the (possibly empty) proxy args array', /curl -fsSL "\$\{CURL_PROXY_ARGS\[@\]\}"/.test(gen));
check('tor-only proxy uses socks5h:// (proxy-side DNS, no DNS leak)', /--proxy "socks5h:\/\/\$CANARY_TOR_SOCKS"/.test(gen));
check('CURL_PROXY_ARGS is empty on clearnet (byte-identical there)', /CURL_PROXY_ARGS=\(\)/.test(gen));
check('proxy args are only populated inside the tor-only branch', /if \[ "\$CANARY_TOR_ONLY" = 1 \]; then\n\tCURL_PROXY_ARGS=\(--proxy/.test(gen));

// ── Node helpers install the dispatcher before fetching ───────────
const blurt = read('scripts/canary/fetch-blurt-head.ts');
const btc = read('scripts/canary/fetch-btc-head.ts');
check('fetch-blurt-head imports the tor dispatcher installer', /import \{[^}]*\binstallTorDispatcherIfTorOnly\b[^}]*\} from '\.\/torSocksDispatcher\.js'/.test(blurt));
check('fetch-blurt-head calls installTorDispatcherIfTorOnly() in main', /installTorDispatcherIfTorOnly\(\)/.test(blurt));
check('fetch-btc-head imports the tor dispatcher installer', /import \{[^}]*\binstallTorDispatcherIfTorOnly\b[^}]*\} from '\.\/torSocksDispatcher\.js'/.test(btc));
check('fetch-btc-head calls installTorDispatcherIfTorOnly() in main', /installTorDispatcherIfTorOnly\(\)/.test(btc));

// ── v1.21.15: a hidden source only through Tor / i2pd ───────────────
{
	const onion = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api';
	const i2p = 'http://44naenfnp6foaegpmujdn4pmhtgo52tjkgs2d3ir2wo7d7mfbufq.b32.i2p/api';
	const env = {} as NodeJS.ProcessEnv;
	const viaTor = canaryHiddenDispatcherFor(onion, env);
	const viaI2p = canaryHiddenDispatcherFor(i2p, env);
	check('an onion source gets the Tor proxy dispatcher, an I2P one the i2pd one', viaTor !== null && viaI2p !== null && viaTor !== viaI2p);
	check('a clearnet source gets none (normal route)', canaryHiddenDispatcherFor('https://mempool.space/api', env) === null);
	check('a .loki source gets none (no proxy: the caller skips it)', canaryHiddenDispatcherFor('http://x.loki/api', env) === null);
	check(
		'with the Tor / I2P proxy switched off (empty), the hidden source gets none (skipped, never direct)',
		canaryHiddenDispatcherFor(onion, { MORPHIT_CANARY_TOR_SOCKS: '' } as NodeJS.ProcessEnv) === null &&
			canaryHiddenDispatcherFor(i2p, { MORPHIT_CANARY_I2P_HTTP_PROXY: ' ' } as NodeJS.ProcessEnv) === null
	);
}

// ── v1.21.15 review: a malformed hidden name is never dialled directly ──
check(
	'a short or dotted .onion, an .i2p or a .loki host counts as hidden (and gets no proxy → skipped)',
	['http://short.onion/api', 'http://x.onion./api', 'http://a.b32.i2p./api', 'http://n.loki/api'].every(
		(u) => canaryHostLooksHidden(u)
	) &&
		canaryHiddenDispatcherFor('http://short.onion/api', {} as NodeJS.ProcessEnv) === null &&
		!canaryHostLooksHidden('https://mempool.space/api')
);
for (const [name, text] of [
	['fetch-btc-head', btc],
	['fetch-blurt-head', blurt]
] as const) {
	check(
		`${name}: a host that only LOOKS hidden is treated as hidden (skipped without a proxy, never dialled)`,
		/hiddenNetworkOf\([^)]*\) \?\? \(canaryHostLooksHidden\([^)]*\) \? 'hidden' : null\)/.test(text)
	);
}

// ── verdict ───────────────────────────────────────────────────────
const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} canary-tor-only-routing checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} canary-tor-only-routing scenarios passed`);
