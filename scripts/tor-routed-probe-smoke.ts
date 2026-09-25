#!/usr/bin/env tsx
/**
 * tor-routed-probe — cp704 (Layer 6). Peer onion/I2P nodes must get a REAL
 * federation status, probed through the co-located Tor/I2P proxies — not a
 * blanket 'good'. A down LOCAL proxy must fall the peer back to listed (never
 * 'unreachable' for our daemon being offline).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => { if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; } };

console.log('\n── tor-routed-probe (cp704) ───────────────────────────\n');
const hsf = read('apps/indexer/src/indexer/hiddenServiceFetch.ts');
const ht = read('packages/hidden-transport/src/index.ts');
// The I2P leg is named by OUR connector, not by undici's `ProxyAgent`, which is
// what this used to grep for. v1.18.0 replaced ProxyAgent with a hand-written
// CONNECT connector so a refused tunnel arrives as a typed error carrying the
// status, instead of as `UND_ERR_ABORTED` with the status buried in prose —
// and this check went red for a change that improved the thing it guards. A
// needle naming a LIBRARY CLASS tests who we depend on; the property is that
// both hidden transports are wired into the fetch path.
check('both hidden connectors + hidden-service fetch exist (Tor 9050 / i2pd 4444)',
	/socks5ConnectRequest/.test(hsf) &&
		/fetchJsonViaHiddenService/.test(hsf) &&
		/makeHttpConnectConnector/.test(hsf));
check('a down LOCAL proxy is a distinct ProxyUnavailableError (not a peer fault)',
	/class ProxyUnavailableError/.test(ht) && /ProxyUnavailableError/.test(hsf));
const fp = read('apps/indexer/src/indexer/federationProbe.ts');
check('probeOne accepts an injected fetcher (clearnet vs hidden-service)', /fetchFn: <T>\(url: string\) => Promise<T> = fetchJson/.test(fp));
check('the scheduler probes hidden-service origins via the proxy (real status)',
	/fetchJsonViaHiddenService<T>\(url, proxies\)/.test(fp) && /probeOne\(/.test(fp) && /hiddenFetch\b/.test(fp));
// The classifier is isProxyUnavailable(), NOT `instanceof`: fetch() hangs the
// connector's error off `cause`, so an instanceof test never matched (see the
// comment in federationProbe.ts). This check used to accept `instanceof` — and
// passed on a COMMENT that mentions it.
check('a down local proxy falls the peer back to listed (persistListedNotProbed)',
	/if \(isProxyUnavailable\(err\)\) \{\s*try \{\s*await this\.persistListedNotProbed\(inst, 'hidden_service_not_network_probed'\)/.test(fp));
const env = read('ops/ansible/roles/morphit/templates/indexer.env.j2');
check('ansible sets MORPHIT_INDEXER_TOR_SOCKS + I2P proxy', /MORPHIT_INDEXER_TOR_SOCKS=/.test(env) && /MORPHIT_INDEXER_I2P_HTTP_PROXY=/.test(env));
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} tor-routed-probe checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
