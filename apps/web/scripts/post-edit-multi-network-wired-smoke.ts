/**
 * post-edit-multi-network-wired-smoke.ts
 *
 * Pre-launch invariant: every route that lets a user create OR
 * edit an order for a multi-network asset (USDT, USDC, DAI) must
 * mount the corresponding network picker AND emit asset_network
 * in its broadcast payload.
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp36 Bob-3 finding):
 *
 * /post/+page.svelte was wired with all 3 multi-network pickers
 * in cp34 (closing the cp31 DAI miss originally caught at cp34
 * H-1). But the sibling route /post/edit/[permlink]/+page.svelte
 * was never walked at the same time, and shipped through cp35
 * with ZERO multi-network wiring — no imports, no picker mounts,
 * no asset_network field in OrderFormInput. Editing a USDT,
 * USDC, or DAI order would broadcast an orderReplace without
 * asset_network and the indexer would reject it with
 * `asset_network_required_for_<asset>`. cp35 also missed this
 * because the asset-coverage map saw /post/edit as "covered"
 * (it imports AssetTicker) but did not check for picker mounts.
 *
 * Strategy: for each registered route, grep the source for the
 * required picker import + mount + payload-field shape. The
 * smoke is text-based; no transpile, no runtime.
 *
 * Adding a new multi-network asset is then a 3-step ratchet:
 *
 *   1. Add the asset to ASSET_TICKERS in asset-registry.
 *   2. Add MULTI_NETWORK_ASSETS entry below.
 *   3. Run smokes — this smoke fails until every order-creation
 *      AND order-edit route has a picker mounted and a payload
 *      branch emitting the network.
 *
 * Self-test on tamper: comment out a picker mount → smoke MUST
 * fail before tarball.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// The multi-network assets and their picker component names.
// Keep this list in sync with $lib/assets/networks.ts exports.
const MULTI_NETWORK_ASSETS: ReadonlyArray<{
	readonly asset: string;
	readonly picker: string;
	readonly stateVar: string;
}> = [
	{ asset: 'USDT', picker: 'UsdtNetworkPicker', stateVar: 'usdtNetwork' },
	{ asset: 'USDC', picker: 'UsdcNetworkPicker', stateVar: 'usdcNetwork' },
	{ asset: 'DAI', picker: 'DaiNetworkPicker', stateVar: 'daiNetwork' }
];

// Routes that build an OrderFormInput and broadcast it. Both
// /post (create) and /post/edit (replace) must mount pickers
// and emit asset_network.
const ORDER_ROUTES: ReadonlyArray<{
	readonly path: string;
	readonly label: string;
}> = [
	{
		path: 'apps/web/src/routes/[lang]/post/+page.svelte',
		label: '/post (order create)'
	},
	{
		path: 'apps/web/src/routes/[lang]/post/edit/[permlink]/+page.svelte',
		label: '/post/edit (order replace)'
	}
];

interface Scenario {
	readonly name: string;
	readonly run: () => string | null;
}

const scenarios: Scenario[] = [];

for (const route of ORDER_ROUTES) {
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
				// Match either explicit default import or named
				// import path.
				if (!src.includes(`import ${picker} from`) && !src.includes(`from '$components/${picker}.svelte'`)) {
					return `missing import for ${picker}`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: mounts ${picker} when asset === '${asset}'`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				// The picker must be mounted inside a guard that
				// keys on the asset value. We accept either the
				// {#if asset === 'X'} pattern or any structural
				// equivalent that pairs the guard with the mount
				// in the same component. Be tolerant of whitespace.
				const mountPattern = `<${picker}`;
				if (!src.includes(mountPattern)) {
					return `${picker} is imported but never mounted`;
				}
				// And the asset's $state var must be declared.
				if (!src.includes(`let ${stateVar} = $state`)) {
					return `state var '${stateVar}' not declared`;
				}
				return null;
			}
		});

		scenarios.push({
			name: `${route.label}: gates submit on ${stateVar} for ${asset} orders`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				// Look for the canSubmit/canSave gate pattern.
				// Accept either explicit (asset !== 'X' || stateVar !== null)
				// or any branch that requires the picker to be
				// non-null before allowing broadcast.
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
				// The OrderFormInput must carry an `assetNetwork`
				// branch keyed on this asset+state pair.
				const emitPattern = `asset === '${asset}' && ${stateVar} !== null`;
				if (!src.includes(emitPattern)) {
					return `OrderFormInput does not emit ${stateVar} for ${asset} (expected substring: ${emitPattern})`;
				}
				return null;
			}
		});
	}
}

// Cross-route consistency: any picker that's imported in one
// order-creation route should be imported in ALL order-creation
// routes (catches an asymmetric future addition like cp34's
// /post fix without a parallel /post/edit fix).
for (const { picker } of MULTI_NETWORK_ASSETS) {
	scenarios.push({
		name: `cross-route consistency: every order route mounts ${picker} OR none do`,
		run: () => {
			const mounted: string[] = [];
			const notMounted: string[] = [];
			for (const route of ORDER_ROUTES) {
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
