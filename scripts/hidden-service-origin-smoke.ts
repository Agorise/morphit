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
import { isHiddenServiceOrigin } from '../packages/hidden-transport/src/index.ts';

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
	/isHiddenServiceOrigin\(inst\.origin\)/.test(probe) && /persistListedNotProbed/.test(probe));
check('hidden-service listing records it was not network-probed (auditable, not a false "good")',
	/hidden_service_not_network_probed/.test(probe));

// v1.12.4 — the RELAY'S OWN startup config must also boot with a tor-only http://
// origin. This is the LOCAL config validation (distinct from the on-chain register
// path above); a too-strict https-only check here crash-looped a tor-only relay.
const relayCfg = read('apps/relay/src/config/index.ts');
// v1.18.0 (F35) — the rule moved into @morphit/hidden-transport so the relay and
// `morphit-ops upgrade` share one reading of it. Asked by BEHAVIOUR, of the very
// function the relay imports, rather than by matching its definition text.
check('relay config takes its hidden-origin rule from the shared transport package',
	/\bisHiddenServiceOrigin,[\s\S]*?\} from '@morphit\/hidden-transport';/.test(relayCfg) &&
	!/function isHiddenServiceOrigin\(/.test(relayCfg));
{
	const onion = `http://${'a'.repeat(56)}.onion:8091`;
	const b32 = `http://${'b'.repeat(52)}.b32.i2p:8091`;
	check('that rule accepts self-authenticating http:// .onion and .i2p (named and .b32)',
		isHiddenServiceOrigin(onion) && isHiddenServiceOrigin(b32) && isHiddenServiceOrigin('http://morphit.i2p'));
	// The https onion is the case that matters: a clearnet host is refused by its
	// NAME whatever the scheme, so only a hidden host proves the scheme is checked.
	check('…and refuses clearnet over http, a hidden host over anything but http, and junk',
		!isHiddenServiceOrigin('http://rpc.example.com') && !isHiddenServiceOrigin(onion.replace('http://', 'https://')) &&
		!isHiddenServiceOrigin('not a url'));
}
check('relay ALLOWED_ORIGINS accepts http:// hidden-service origins (tor-only CORS boot)',
	/!o\.startsWith\('https:\/\/'\) && !o\.startsWith\('http:\/\/localhost'\) && !isHiddenServiceOrigin\(o\)/.test(relayCfg));
check('relay BLURT_RPC accepts http:// hidden-service endpoints (tor-only broadcast)',
	/!ep\.startsWith\('https:\/\/'\) && !isHiddenServiceOrigin\(ep\)/.test(relayCfg));

// v1.12.4 — a tor-only node has no clearnet domain, so the Ansible tor-only block
// must point the INDEXER's public origin at the onion too; the template renders
// https://<empty-domain> otherwise and the indexer refuses to boot on an invalid URL.
const playbook = read('ops/ansible/playbook.yml');
check('Ansible tor-only block sets MORPHIT_INDEXER_PUBLIC_ORIGIN to the onion',
	/MORPHIT_INDEXER_PUBLIC_ORIGIN = onion/.test(playbook) &&
	/MORPHIT_INDEXER_PUBLIC_ORIGIN=\{\{ morphit_onion_origin \}\}/.test(playbook));
check('i2p .b32 derivation emits a SINGLE line (no bare ".b32.i2p" line that the shell would execute)',
	/printf '%s\.b32\.i2p/.test(playbook) && !/echo \.b32\.i2p/.test(playbook));

console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} hidden-service-origin checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
