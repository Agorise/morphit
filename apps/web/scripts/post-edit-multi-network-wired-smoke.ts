/**
 * post-edit-multi-network-wired-smoke.ts
 *
 * Pre-launch invariant: multi-network assets (USDT, USDC, DAI) must
 * carry their sub-network (asset_network) correctly through BOTH order
 * creation and order editing — but the two flows differ:
 *
 *   • CREATE (/post): the user CHOOSES the network, so the route must
 *     import + mount the network picker, gate submit on a chosen
 *     network, and emit asset_network in the broadcast payload.
 *
 *   • EDIT (/post/edit): the network is IMMUTABLE in a 15-minute
 *     replace — the indexer rejects a change with
 *     `replace_asset_network_change_forbidden`. So the edit route must
 *     NOT mount an interactive picker. cp401: mounting one let the user
 *     change the network, the broadcast "succeeded" (the page showed
 *     "saved"), and the indexer silently rejected the replace — the
 *     edit never applied. Instead the edit route HYDRATES the network
 *     read-only from the loaded order and still EMITS asset_network in
 *     the payload, so the immutability check matches
 *     (v.asset_network === target.asset_network).
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp36 Bob-3 finding, revised cp401):
 *
 * /post/edit originally shipped with ZERO multi-network wiring (cp35),
 * so editing a USDT/USDC/DAI order broadcast an orderReplace without
 * asset_network → `asset_network_required_for_<asset>`. cp36 added the
 * pickers to BOTH routes. cp401 then found that an editable network (or
 * side/asset/fiat) on the edit page is itself the bug: those fields are
 * immutable in a replace, so the picker was removed and the network is
 * now shown read-only. This smoke was rewritten to encode the
 * emit-not-mount invariant for the edit route.
 *
 * Adding a new multi-network asset is a 3-step gate:
 *   1. Add the asset to ASSET_TICKERS in asset-registry.
 *   2. Add a MULTI_NETWORK_ASSETS entry below.
 *   3. Run smokes — fails until the CREATE route mounts a picker and
 *      every route (create AND edit) emits asset_network.
 *
 * Self-test on tamper: comment out the /post picker mount → fail; OR
 * mount a picker on /post/edit → fail (read-only invariant).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// The multi-network assets, their picker component, $state var, and the
// hydration typeguard. Keep in sync with $lib/assets/networks.ts.
const MULTI_NETWORK_ASSETS: ReadonlyArray<{
	readonly asset: string;
	readonly picker: string;
	readonly stateVar: string;
	readonly guard: string;
}> = [
	{ asset: 'USDT', picker: 'UsdtNetworkPicker', stateVar: 'usdtNetwork', guard: 'isUsdtNetwork' },
	{ asset: 'USDC', picker: 'UsdcNetworkPicker', stateVar: 'usdcNetwork', guard: 'isUsdcNetwork' },
	{ asset: 'DAI', picker: 'DaiNetworkPicker', stateVar: 'daiNetwork', guard: 'isDaiNetwork' }
];

// CREATE routes let the user pick the network → picker required.
const CREATE_ROUTES: ReadonlyArray<{ readonly path: string; readonly label: string }> = [
	{ path: 'apps/web/src/routes/[lang]/post/+page.svelte', label: '/post (order create)' }
];

// EDIT routes replace an existing order → network is immutable, shown
// read-only. Picker must NOT be mounted; asset_network must still be
// hydrated + emitted.
const EDIT_ROUTES: ReadonlyArray<{ readonly path: string; readonly label: string }> = [
	{ path: 'apps/web/src/routes/[lang]/post/edit/[permlink]/+page.svelte', label: '/post/edit (order replace)' }
];

interface Scenario {
	readonly name: string;
	readonly run: () => string | null;
}

const scenarios: Scenario[] = [];

// ─── CREATE routes: full picker wiring ─────────────────────────────
for (const route of CREATE_ROUTES) {
	const absPath = resolve(REPO_ROOT, route.path);

	scenarios.push({
		name: `${route.label}: file exists at expected path`,
		run: () => (existsSync(absPath) ? null : `not found: ${route.path}`)
	});

	for (const { asset, picker, stateVar } of MULTI_NETWORK_ASSETS) {
		scenarios.push({
			name: `${route.label}: imports ${picker}`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				if (
					!src.includes(`import ${picker} from`) &&
					!src.includes(`from '$components/${picker}.svelte'`)
				) {
					return `missing import for ${picker}`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: mounts ${picker} + declares ${stateVar}`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				if (!src.includes(`<${picker}`)) return `${picker} is imported but never mounted`;
				if (!src.includes(`let ${stateVar} = $state`)) return `state var '${stateVar}' not declared`;
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: gates submit on ${stateVar} for ${asset} orders`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				const gatePattern = `(asset !== '${asset}' || ${stateVar} !== null)`;
				if (!src.includes(gatePattern)) {
					return `submit gate does not require ${stateVar} for ${asset} orders (expected literal: ${gatePattern})`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: emits ${stateVar} via assetNetwork field on broadcast`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				const emitPattern = `asset === '${asset}' && ${stateVar} !== null`;
				if (!src.includes(emitPattern)) {
					return `OrderFormInput does not emit ${stateVar} for ${asset} (expected substring: ${emitPattern})`;
				}
				return null;
			}
		});
	}
}

// ─── EDIT routes: read-only network (emit, don't mount) ────────────
for (const route of EDIT_ROUTES) {
	const absPath = resolve(REPO_ROOT, route.path);

	scenarios.push({
		name: `${route.label}: file exists at expected path`,
		run: () => (existsSync(absPath) ? null : `not found: ${route.path}`)
	});

	for (const { asset, picker, stateVar, guard } of MULTI_NETWORK_ASSETS) {
		scenarios.push({
			name: `${route.label}: declares ${stateVar} (needed to hydrate + emit)`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				if (!src.includes(`let ${stateVar} = $state`)) return `state var '${stateVar}' not declared`;
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: hydrates ${stateVar} read-only from the loaded order (${guard})`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				if (!src.includes(`${guard}(netRaw)`)) {
					return `does not hydrate ${stateVar} from order.asset_network via ${guard}(netRaw)`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: still gates save on ${stateVar} for ${asset} orders`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				const gatePattern = `(asset !== '${asset}' || ${stateVar} !== null)`;
				if (!src.includes(gatePattern)) {
					return `save gate does not require ${stateVar} for ${asset} orders (expected literal: ${gatePattern})`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: emits ${stateVar} via assetNetwork field on broadcast (immutability match)`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				const emitPattern = `asset === '${asset}' && ${stateVar} !== null`;
				if (!src.includes(emitPattern)) {
					return `OrderFormInput does not emit ${stateVar} for ${asset} (expected substring: ${emitPattern})`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: does NOT mount ${picker} (network is immutable/read-only in a replace)`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				if (src.includes(`<${picker}`)) {
					return `${picker} is mounted on the edit route — the network is immutable in a replace, so it must be read-only (mounting a picker re-introduces the silent-rejection bug)`;
				}
				return null;
			}
		});
	}
}

// ─── Cross-route consistency ───────────────────────────────────────
for (const { picker } of MULTI_NETWORK_ASSETS) {
	// Every CREATE route mounts the picker, or none do (catches an
	// asymmetric future addition of a second create route).
	scenarios.push({
		name: `cross-route consistency: every CREATE route mounts ${picker} OR none do`,
		run: () => {
			const mounted: string[] = [];
			const notMounted: string[] = [];
			for (const route of CREATE_ROUTES) {
				const absPath = resolve(REPO_ROOT, route.path);
				if (!existsSync(absPath)) continue;
				const src = readFileSync(absPath, 'utf8');
				if (src.includes(`<${picker}`)) mounted.push(route.label);
				else notMounted.push(route.label);
			}
			if (mounted.length > 0 && notMounted.length > 0) {
				return `asymmetric mount: ${picker} present in [${mounted.join(', ')}] but missing in [${notMounted.join(', ')}]`;
			}
			return null;
		}
	});

	// No EDIT route mounts the picker (read-only network invariant).
	scenarios.push({
		name: `cross-route consistency: no EDIT route mounts ${picker}`,
		run: () => {
			const mounted: string[] = [];
			for (const route of EDIT_ROUTES) {
				const absPath = resolve(REPO_ROOT, route.path);
				if (!existsSync(absPath)) continue;
				const src = readFileSync(absPath, 'utf8');
				if (src.includes(`<${picker}`)) mounted.push(route.label);
			}
			if (mounted.length > 0) {
				return `${picker} mounted on edit route(s) [${mounted.join(', ')}] — must be read-only`;
			}
			return null;
		}
	});
}

let failed = 0;
for (const s of scenarios) {
	const err = s.run();
	if (err) {
		console.error(`  ✗ ${s.name}: ${err}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n  ${failed}/${scenarios.length} scenarios FAILED`);
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
// scenarios in the suite summary.
console.log(`✓ all ${scenarios.length} post-edit-multi-network-wired scenarios passed`);
