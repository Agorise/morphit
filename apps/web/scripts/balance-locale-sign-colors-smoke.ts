/**
 * balance-locale-sign-colors-smoke.ts
 *
 * v1.8.0 (t.txt): in Chinese financial convention a value going UP is RED and
 * a value going DOWN is GREEN (红涨绿跌) — the opposite of the Western
 * green-up/red-down that `AnimatedNumber` flashes by default. Ken asked that
 * the wallet-card balance typewriter reflect this for the zh-CN / zh-HK
 * locales.
 *
 * This smoke pins the OUTCOME so a future edit can't silently regress it:
 *   1. AnimatedNumber exposes an opt-in `localeSignColors` prop and, when it is
 *      set AND the app locale is zh-CN/zh-HK, INVERTS the gain/loss flash
 *      (an `effectiveFlash` that swaps 'gain'↔'loss'); the flash classes bind
 *      to `effectiveFlash`, not the raw `flash`.
 *   2. MyBalanceCard sets `localeSignColors` on the MONEY balances (BLURT +
 *      BP), and NOT on the mana / voting-power meter (a battery-like value that
 *      reads green-up in every locale).
 *
 * Tamper-proof: a vacuity guard asserts the anchors we grep for still exist, so
 * deleting the feature fails the smoke rather than passing on an empty match.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(__dirname, '..');
const AN = readFileSync(resolve(WEB, 'src/lib/components/AnimatedNumber.svelte'), 'utf8');
const BC = readFileSync(resolve(WEB, 'src/lib/components/MyBalanceCard.svelte'), 'utf8');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean): void {
	checks++;
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
	if (!ok) failures++;
}

console.log('\n── balance locale sign-colors smoke ─────────────────');

// 1. AnimatedNumber: the prop exists.
check('AnimatedNumber declares a localeSignColors prop', /localeSignColors\??:\s*boolean/.test(AN) && /localeSignColors\s*=\s*false/.test(AN));

// 2. The inversion is gated on the two Chinese locales AND the prop.
check(
	'inversion is gated on localeSignColors AND (zh-CN || zh-HK)',
	/localeSignColors\s*&&\s*\(\s*\$locale\s*===\s*'zh-CN'\s*\|\|\s*\$locale\s*===\s*'zh-HK'\s*\)/.test(AN)
);

// 3. There is an effectiveFlash that swaps gain↔loss, and the classes bind to it.
check("effectiveFlash swaps 'gain'↔'loss'", /flash\s*===\s*'gain'\s*\?\s*'loss'\s*:\s*'gain'/.test(AN));
check(
	'flash classes bind to effectiveFlash (not the raw flash)',
	/class:flash-gain=\{effectiveFlash === 'gain'\}/.test(AN) &&
		/class:flash-loss=\{effectiveFlash === 'loss'\}/.test(AN)
);

// 4. Vacuity guard: the flash-color CSS the inversion drives must still exist.
check('flash-gain/flash-loss colour rules still present (vacuity guard)', /\.flash-gain\s*\{/.test(AN) && /\.flash-loss\s*\{/.test(AN));

// 5. MyBalanceCard: money balances opt in; mana does not.
const moneyOptIns = (BC.match(/localeSignColors/g) ?? []).length;
check('MyBalanceCard sets localeSignColors on the 4 money balances (blurt+bp, desktop+mobile)', moneyOptIns === 4);

// The mana meter uses manaPct — assert it is NOT wrapped with the opt-in.
// (Grep each AnimatedNumber block for value={manaPct}; none should carry the prop.)
const manaBlocks = BC.match(/<AnimatedNumber[^>]*value=\{manaPct\}[^>]*\/>/g) ?? [];
const manaHasOptIn = manaBlocks.some((b) => b.includes('localeSignColors'));
check('mana / voting-power meter does NOT invert (stays green-up in every locale)', manaBlocks.length >= 1 && !manaHasOptIn);

console.log('────────────────────────────────────────────────────────');
if (failures > 0) {
	console.error(`✗ ${failures} balance-locale-sign-colors check(s) FAILED`);
	process.exit(1);
}
console.log(`✓ all ${checks} balance-locale-sign-colors scenarios passed\n`);
