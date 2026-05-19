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
 * with a 14-tab tablist (BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL)
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
		excludeAssets: []
	},
	{
		path: 'apps/web/src/lib/components/FundsSentModal.svelte',
		name: 'FundsSentModal',
		// BLURT funds-sent goes through PayBlurtModal (its own
		// broadcast path with explicit memo handling), not the
		// generic mark-sent dispatch. So BLURT is not expected
		// as a tab in this modal. Every other asset IS.
		excludeAssets: ['BLURT']
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

	for (const lowerTicker of expected) {
		scenarios.push({
			name: `${comp.name}: tablist contains tab for ${lowerTicker.toUpperCase()}`,
			run: () => {
				if (!existsSync(absPath)) return null; // covered above
				const src = readFileSync(absPath, 'utf8');
				// We look for both the aria-selected pattern AND
				// the selectMethod(<asset>) onclick, since either
				// alone could be a typo. Both must appear.
				const ariaPattern = `aria-selected={method === '${lowerTicker}'}`;
				const onclickPattern = `selectMethod('${lowerTicker}')`;
				if (!src.includes(ariaPattern)) {
					return `missing aria-selected wiring for method='${lowerTicker}' (expected literal: ${ariaPattern})`;
				}
				if (!src.includes(onclickPattern)) {
					return `missing onclick wiring for selectMethod('${lowerTicker}') — tab button likely missing`;
				}
				return null;
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
