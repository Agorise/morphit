/**
 * feature-pills-fiat-smoke — cp453 (t.txt #3)
 *
 * The "🚀 Feature this order!" form: (a) the 6h/24h/72h duration pills gained a
 * subtle hover, and (b) the cost preview shows the fee in the user's DEFAULT
 * fiat (Settings), falling back to USD when there's no preference or no FX table.
 * Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(
	join(repo, 'apps/web/src/lib/components/FeatureBidForm.svelte'),
	'utf8'
);

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// (a) duration pills have a subtle hover effect.
check(
	'the duration pills gained a hover effect (border + unselected bg)',
	/hover:border-morphit-emerald\/70/.test(src) && /hover:bg-morphit-emerald\/5/.test(src)
);

// (b) the cost preview converts to the user's default fiat via the FX table.
check(
	'the fee is converted to the user default fiat (userPreferences.fiat + usdToFiat + FX)',
	/userPreferences\.fiat/.test(src) &&
		/usdToFiat\(/.test(src) &&
		/fetchFxRates\(/.test(src) &&
		/totalFiatDisplay/.test(src)
);

// (b2) it still falls back to USD when there's no fiat pref / no FX.
check(
	'falls back to USD when there is no fiat preference or FX table',
	/if \(!fiat \|\| fiat === 'USD' \|\| totalUsd === null \|\| fxTable === null\) return null/.test(
		src
	) && /\{:else if totalUsdDisplay\}/.test(src)
);

// The stale "no persisted user fiat preference exists" comment must be gone.
check(
	'the stale "no persisted user fiat preference" comment is removed',
	!/No persisted user fiat preference exists/.test(src)
);

if (failures === 0) {
	console.log('✓ all 4 feature-pills-fiat scenarios passed');
} else {
	console.log(`\n✗ ${failures}/4 feature-pills-fiat scenarios failed`);
	process.exit(1);
}
