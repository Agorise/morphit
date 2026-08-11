#!/usr/bin/env tsx
/**
 * hidden-service-origin — cp702 (v1.11.0 hidden-service-only node, Layer 1).
 *
 * The on-chain foundation for a node with NO clearnet domain:
 *   - operatorRegister accepts http:// origins for Tor/I2P/Lokinet hosts
 *     (their networks encrypt at the transport layer) while keeping clearnet
 *     https-only and all SSRF guards intact — so an onion-only node can
 *     advertise itself to the federated directory.
 *   - the federation probe LISTS hidden-service origins on their signed on-chain
 *     advertisement instead of network-probing them (a clearnet indexer can't
 *     reach a .onion → it must not mark the node 'unreachable').
 * Backward-compatible: existing https origins and the probe path are unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; }
};

console.log('\n── hidden-service-origin (cp702) ──────────────────────\n');
const reg = read('apps/indexer/src/indexer/handlers/operatorRegister.ts');
check('operatorRegister allows http:// only for hidden-service hosts (.onion/.i2p/.loki)',
	/isHiddenServiceHost/.test(reg) && /parsed\.protocol === 'http:' && isHiddenServiceHost/.test(reg));
check('I2P matching covers BOTH named .i2p AND .b32.i2p (endsWith .i2p)',
	/oHost\.endsWith\('\.i2p'\)/.test(reg));
check('clearnet still rejected on http (origin_bad_scheme retained)',
	/return \{ reason: 'origin_bad_scheme' \}/.test(reg));
check('validate() is exported (unit-testable)', /export function validate\(/.test(reg));

const probe = read('apps/indexer/src/indexer/federationProbe.ts');
check('federation probe detects hidden-service origins', /function isHiddenServiceOrigin\(/.test(probe));
check('federation probe LISTS hidden-service origins instead of probing them',
	/isHiddenServiceOrigin\(inst\.origin\)/.test(probe) && /persistHiddenServiceListed/.test(probe));
check('hidden-service listing records it was not network-probed (auditable, not a false "good")',
	/hidden_service_not_network_probed/.test(probe));

console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} hidden-service-origin checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
