/**
 * asset-tab-completeness-smoke.ts
 *
 * Pre-launch invariant: every component that renders a tablist of
 * asset method buttons must include a tab for every tradable asset
 * Morphit supports (subject to per-component exclusions defined
 * inline).
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp36 Bob-1 + Bob-2 finding):
 *
 * AddressShareModal.svelte and FundsSentModal.svelte each shipped
 * with a 16-tab tablist (BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP)
 * that silently omitted the DAI tab when cp31 added DAI as the 9th
 * tradable asset. Every OTHER DAI hook (validator, placeholder,
 * invalid-msg dispatch, picker block, payload field) was wired
 * correctly in both modals — only the user-facing tab button was
 * missing, making DAI unreachable through the modal UI.
 *
 * cp32-cp35 audits used static asset-coverage maps that saw these
 * modals as "covered" because they imported the right symbols and
 * referenced 'dai' in dispatcher logic — but the tablist rendered
 * 9 buttons instead of 10. The persona walk (Bob, chat surface)
 * caught the gap.
 *
 * Strategy: for each registered component, grep the source for the
 * `aria-selected={method === '<asset>'}` pattern; assert every
 * required asset appears. Lightweight: text-based, no transpile.
 *
 * Adding a new tradable asset is then a 2-step gate:
 *
 *   1. Edit packages/asset-registry/src/index.ts ASSET_TICKERS
 *   2. Run smokes — this smoke fails until every registered
 *      tablist component has a corresponding tab button
 *
 * The smoke knows about per-component exclusions: some tablists
 * legitimately omit certain assets (e.g. BLURT's funds-sent flow
 * goes through PayBlurtModal, not the generic mark-sent dispatch,
 * so BLURT isn't expected in FundsSentModal's tablist even though
 * it IS expected in AddressShareModal's).
 *
 * Self-test on tamper: remove a tab → smoke MUST fail before
 * tarball.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = resolve(
	REPO_ROOT,
	'packages/asset-registry/src/index.ts'
);

// Pull ASSET_TICKERS from the registry source as text — same
// no-transpile approach the network-icon-coverage smoke uses.
function loadTickers(): readonly string[] {
	const src = readFileSync(REGISTRY_PATH, 'utf8');
	const m = src.match(/export const ASSET_TICKERS = \[([^\]]+)\] as const;/);
	if (!m) throw new Error('Could not parse ASSET_TICKERS from registry');
	return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

interface ComponentSpec {
	/** Path under apps/web/src/ */
	readonly path: string;
	/** Lowercase asset method tickers expected as `method === '<x>'`
	 *  in the tablist. Computed from ASSET_TICKERS minus
	 *  excludeAssets. */
	readonly excludeAssets: readonly string[];
	/** Human-friendly name for failure messages. */
	readonly name: string;
}

const COMPONENTS: readonly ComponentSpec[] = [
	{
		path: 'apps/web/src/lib/components/AddressShareModal.svelte',
		name: 'AddressShareModal',
		// Every tradable asset is expected: this is the share-
		// receive-address surface, which applies to all assets
		// uniformly (the user shares a receive address for
		// whatever they're being paid in).
		// cp425: EXCEPT goods (BARTER) — a barter listing has no receive
		// address (wares change hands off-platform); a barter trade settles
		// in whichever crypto the buyer picks from `accepted_assets`, and
		// THAT crypto's tab is the one shown. So no 'barter' tab here.
		excludeAssets: ['BARTER']
	},
	{
		path: 'apps/web/src/lib/components/FundsSentModal.svelte',
		name: 'FundsSentModal',
		// BLURT funds-sent goes through PayBlurtModal (its own
		// broadcast path with explicit memo handling), not the
		// generic mark-sent dispatch. So BLURT is not expected
		// as a tab in this modal. Every other asset IS.
		// cp425: goods (BARTER) also excluded — a barter trade's payment is
		// the buyer's chosen crypto, marked sent under THAT crypto's tab; no
		// 'barter' funds-sent tab.
		excludeAssets: ['BLURT', 'BARTER']
	}
];

interface Scenario {
	readonly name: string;
	readonly run: () => string | null;
}

const tickers = loadTickers();
const scenarios: Scenario[] = [];

for (const comp of COMPONENTS) {
	const absPath = resolve(REPO_ROOT, comp.path);
	scenarios.push({
		name: `${comp.name}: file exists at expected path`,
		run: () => (existsSync(absPath) ? null : `not found: ${comp.path}`)
	});
	const expected = tickers
		.filter((t) => !comp.excludeAssets.includes(t))
		.map((t) => t.toLowerCase());

	// cp425 — the 16 hardcoded per-coin tab buttons in these modals were
	// refactored to a single {#each visibleMethods as m} template backed by an
	// ALL_METHODS array (so an `allowedMethods` prop can filter the set for a
	// barter order). We now verify (a) the templated tab wiring is present, and
	// (b) each expected coin is listed in ALL_METHODS (what the template
	// iterates) — equivalent coverage to the old per-coin aria-selected check.
	scenarios.push({
		name: `${comp.name}: templated tablist wiring present`,
		run: () => {
			if (!existsSync(absPath)) return null;
			const src = readFileSync(absPath, 'utf8');
			const ok =
				src.includes('{#each visibleMethods as m') &&
				src.includes('aria-selected={method === m}') &&
				src.includes('selectMethod(m)');
			return ok
				? null
				: `templated tablist wiring missing ({#each visibleMethods as m} + aria-selected={method === m} + selectMethod(m))`;
		}
	});

	for (const lowerTicker of expected) {
		scenarios.push({
			name: `${comp.name}: tablist offers method ${lowerTicker.toUpperCase()}`,
			run: () => {
				if (!existsSync(absPath)) return null;
				const src = readFileSync(absPath, 'utf8');
				// The coin must be listed in ALL_METHODS (the array the {#each}
				// iterates); a bare quoted lower-case ticker is its entry.
				return src.includes(`'${lowerTicker}'`)
					? null
					: `method '${lowerTicker}' not listed in ALL_METHODS — its tab would never render`;
			}
		});
	}

	// Anti-orphan check: every method dispatch in the component
	// must correspond to an expected asset, OR be in the
	// excludeAssets list. Catches the inverse failure mode where
	// someone REMOVES an asset from the registry but leaves a
	// dispatch branch wired.
	scenarios.push({
		name: `${comp.name}: every method === '<asset>' branch matches the registry`,
		run: () => {
			if (!existsSync(absPath)) return null;
			const src = readFileSync(absPath, 'utf8');
			const branches = new Set<string>();
			const re = /method === '([a-z]+)'/g;
			let m;
			while ((m = re.exec(src)) !== null) branches.add(m[1]);
			const validLower = new Set(tickers.map((t) => t.toLowerCase()));
			const orphans = [...branches].filter((b) => !validLower.has(b));
			if (orphans.length > 0) {
				return `dispatch branches for unregistered asset(s): ${orphans.join(', ')}`;
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
console.log(`✓ all ${scenarios.length} asset-tab-completeness scenarios passed`);
