/**
 * ipfs-gateway-onion-smoke (v1.16.2)
 *
 * Pins the wiring that lets a clearnet-censored node fetch a release over
 * another instance's .onion/.i2p at /ipfs/<cid> — WITHOUT reaching clearnet.
 *
 * The runtime behaviour (Kubo actually serving the pinned CID over the bridge)
 * can only be verified on a live box that runs IPFS hosting; this smoke instead
 * locks the invariants that make it safe + correct in code:
 *
 *   • Gateway.NoFetch=true is always set — the gateway serves ONLY pinned
 *     content, so exposing it is not an open proxy and a hidden-only node never
 *     reaches clearnet IPFS peers to satisfy a gateway request.
 *   • the gateway bind is loopback by default and only binds all-interfaces
 *     when morphit_ipfs_gateway_expose is true (default false).
 *   • both nginx vhosts route /ipfs + /ipns to the gateway and degrade to a
 *     clean 404 (never a scary 502) when the gateway is not reachable.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name: string): void => {
	pass++;
};
const check = (name: string, cond: boolean): void => {
	if (cond) ok(name);
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

// ── ipfs role defaults ──
const defaults = raw('ops/ansible/roles/ipfs/defaults/main.yml');
check('defaults: gateway loopback bind unchanged', defaults.includes('morphit_ipfs_gateway_addr: "/ip4/127.0.0.1/tcp/8082"'));
check('defaults: expose toggle defaults TRUE (v1.16.10 — every instance a Tor/I2P seeder)', /morphit_ipfs_gateway_expose:\s*true/.test(defaults));
check('defaults: exposed bind is all-interfaces :8082', /morphit_ipfs_gateway_expose_addr:\s*"\/ip4\/0\.0\.0\.0\/tcp\/8082"/.test(defaults));

// ── ipfs role tasks ──
const tasks = raw('ops/ansible/roles/ipfs/tasks/main.yml');
check('tasks: Gateway.NoFetch is set', /Gateway\.NoFetch/.test(tasks));
check('tasks: Gateway.NoFetch value is true', /key:\s*"Gateway\.NoFetch",\s*value:\s*"true"/.test(tasks));
check('tasks: gateway bind honours the expose toggle', tasks.includes('morphit_ipfs_gateway_expose | bool') && tasks.includes('ternary(morphit_ipfs_gateway_expose_addr, morphit_ipfs_gateway_addr)'));

// ── frontend nginx (containerised — reaches gateway over the Docker bridge) ──
const fe = raw('ops/bunkerweb/frontend/nginx.conf');
check('frontend: /ipfs/ location present', /location \/ipfs\/ \{/.test(fe));
check('frontend: /ipns/ location present', /location \/ipns\/ \{/.test(fe));
check('frontend: gateway upstream is host.docker.internal:8082', (fe.match(/host\.docker\.internal:8082/g) ?? []).length >= 2);

// ── v1.16.10 upgrade self-heal: auto-expose on existing instances ──
const up = raw('apps/ops-cli/src/commands/upgrade.ts');
// Called from the shared heal list since the final v1.18.0 review (runSelfHeals).
check('upgrade: self-heals IPFS gateway exposure + is called', /function healIpfsGatewayExposure\(/.test(up) && /\(\) => healIpfsGatewayExposure\(\)/.test(up) && /await runSelfHeals\(\)/.test(up));
check('upgrade: exposes the all-interfaces bind :8082', /\/ip4\/0\.0\.0\.0\/tcp\/8082/.test(up));
check('upgrade: sets NoFetch true BEFORE the bind (never briefly an open proxy)', /Gateway\.NoFetch.*true/.test(up) && up.indexOf('NoFetch') < up.indexOf("Addresses.Gateway', EXPOSE_ADDR"));
check('upgrade: VERIFIES the gateway is live on the bridge (curl 127.0.0.1:8082)', /127\.0\.0\.1:8082/.test(up));
check('upgrade: no-ops on a non-IPFS box (repo presence gate)', /repoCandidates/.test(up) && /not an IPFS-hosting node/.test(up));
check('frontend: intercepts errors to a clean 404', fe.includes('proxy_intercept_errors on;') && /location @ipfs_unavailable \{[\s\S]*?return 404;/.test(fe));

// ── bare-metal nginx (single host — reaches gateway on loopback) ──
const bm = raw('ops/nginx/web.conf');
check('bare-metal: /ipfs/ location present', /location \/ipfs\/ \{/.test(bm));
check('bare-metal: /ipns/ location present', /location \/ipns\/ \{/.test(bm));
check('bare-metal: gateway upstream is 127.0.0.1:8082', (bm.match(/127\.0\.0\.1:8082/g) ?? []).length >= 2);
check('bare-metal: intercepts errors to a clean 404', bm.includes('proxy_intercept_errors on;') && /location @ipfs_unavailable \{[\s\S]*?return 404;/.test(bm));

console.log(
	fail === 0
		? `✓ all ${pass} ipfs-gateway-onion checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
