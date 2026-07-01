/**
 * canonical-treasury-smoke (cp315)
 *
 * Guards the economic spine of the project: the three canonical
 * treasury accounts (BLURT @morphit-fees, BTC, XMR) and the wiring
 * that pins them into (a) the indexer fee-verification defaults and
 * (b) the on-chain release-op builder.  If any of these drift, the
 * treasury silently stops being paid — the exact failure this
 * smoke exists to make loud.
 *
 * Scenarios:
 *   1. CANONICAL_TREASURY holds the exact, expected address values
 *      (a bare edit to the constant fails here, on purpose).
 *   2. The canonical BTC/XMR addresses pass the REAL
 *      @morphit/release-schema validateTreasury (the same validator
 *      the on-chain release op is checked against at launch).
 *   3. Address shapes match the release-schema mainnet regexes
 *      (explicit shape guard mirroring releaseValidate.ts).
 *   4. The indexer config schema defaults resolve to the canonical
 *      values when the env is unset, and DISABLE (empty) when the
 *      env is set to an explicit empty string.
 *   5. STATIC drift guard: config/index.ts wires the three defaults
 *      to CANONICAL_TREASURY.{blurt,btc,xmr} (not a literal / '').
 *   6. STATIC drift guard: release-build-payload.ts seeds the BTC
 *      and XMR builder prompts from CANONICAL_TREASURY.
 *   7. CROSS-SURFACE parity: the frontend FEE_RECIPIENT literal
 *      equals CANONICAL_TREASURY.blurt.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTreasury } from '@morphit/release-schema';
import { CANONICAL_TREASURY } from '../src/config/canonicalTreasury.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};

// Expected canonical values — duplicated here ON PURPOSE so a typo
// or accidental edit to the constant trips this guard.
const EXPECT = {
	blurt: 'morphit-fees',
	btc: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk',
	xmr: '84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe'
};

// Mirrors of the release-schema mainnet shape regexes.
const BTC_MAINNET_ADDRESS_RE = /^(bc1[a-z0-9]+|[13][1-9A-HJ-NP-Za-km-z]+)$/;
const XMR_MAINNET_ADDRESS_RE = /^[48][0-9A-Za-z]{94}$/;

// ── 1. constant values ────────────────────────────────────────
if (CANONICAL_TREASURY.blurt === EXPECT.blurt) ok('CANONICAL_TREASURY.blurt === @morphit-fees');
else bad('CANONICAL_TREASURY.blurt drifted', `got ${CANONICAL_TREASURY.blurt}`);
if (CANONICAL_TREASURY.btc === EXPECT.btc) ok('CANONICAL_TREASURY.btc matches expected address');
else bad('CANONICAL_TREASURY.btc drifted', `got ${CANONICAL_TREASURY.btc}`);
if (CANONICAL_TREASURY.xmr === EXPECT.xmr) ok('CANONICAL_TREASURY.xmr matches expected address');
else bad('CANONICAL_TREASURY.xmr drifted', `got ${CANONICAL_TREASURY.xmr}`);

// ── 2. real validateTreasury ──────────────────────────────────
const vt = validateTreasury({
	btc: { address: CANONICAL_TREASURY.btc, satoshis: 416 },
	xmr: { address: CANONICAL_TREASURY.xmr, piconero: '781250000' }
});
if (vt.ok) ok('validateTreasury accepts the canonical treasury block (release-op ready)');
else bad('validateTreasury REJECTED the canonical block', `reason ${(vt as { reason: string }).reason}`);

// ── 3. shape regexes ──────────────────────────────────────────
if (BTC_MAINNET_ADDRESS_RE.test(CANONICAL_TREASURY.btc) && CANONICAL_TREASURY.btc.length <= 100)
	ok('canonical BTC matches mainnet bech32/legacy shape');
else bad('canonical BTC fails mainnet shape', CANONICAL_TREASURY.btc);
if (XMR_MAINNET_ADDRESS_RE.test(CANONICAL_TREASURY.xmr))
	ok('canonical XMR matches mainnet 95-char 4/8 shape');
else bad('canonical XMR fails mainnet shape', CANONICAL_TREASURY.xmr);

// ── 4. config schema default behaviour ────────────────────────
const schema = z.object({
	fee: z.string().min(3).max(16).default(CANONICAL_TREASURY.blurt),
	btc: z.string().default(CANONICAL_TREASURY.btc),
	xmr: z.string().default(CANONICAL_TREASURY.xmr)
});
const unset = schema.parse({});
if (
	unset.fee === CANONICAL_TREASURY.blurt &&
	unset.btc === CANONICAL_TREASURY.btc &&
	unset.xmr === CANONICAL_TREASURY.xmr
)
	ok('unset env → schema defaults to canonical treasury (all 3)');
else bad('unset env did NOT default to canonical', JSON.stringify(unset));
const disabled = schema.parse({ btc: '', xmr: '' });
if (disabled.btc === '' && disabled.xmr === '')
	ok('explicit empty env → BTC/XMR disabled (operator escape hatch preserved)');
else bad('explicit empty env did not disable', JSON.stringify(disabled));

// ── 5. config wiring static guard ─────────────────────────────
const configSrc = readFileSync(join(REPO, 'apps/indexer/src/config/index.ts'), 'utf-8');
for (const key of ['blurt', 'btc', 'xmr'] as const) {
	if (configSrc.includes(`.default(CANONICAL_TREASURY.${key})`))
		ok(`config/index.ts wires ${key} default to CANONICAL_TREASURY.${key}`);
	else
		bad(
			`config/index.ts no longer wires ${key} to CANONICAL_TREASURY`,
			'a literal or empty default would silently re-break the treasury'
		);
}

// ── 6. release-builder seed static guard ──────────────────────
const builderSrc = readFileSync(join(REPO, 'apps/indexer/scripts/release-build-payload.ts'), 'utf-8');
if (builderSrc.includes('CANONICAL_TREASURY.btc') && builderSrc.includes('CANONICAL_TREASURY.xmr'))
	ok('release-build-payload.ts seeds BTC+XMR prompts from CANONICAL_TREASURY');
else bad('release-builder no longer seeds from CANONICAL_TREASURY', 'launch ceremony loses typo-proofing');

// ── 7. frontend FEE_RECIPIENT parity ──────────────────────────
const feeSrc = readFileSync(join(REPO, 'apps/web/src/lib/orders/fee.ts'), 'utf-8');
if (feeSrc.includes(`export const FEE_RECIPIENT = '${CANONICAL_TREASURY.blurt}'`))
	ok('frontend FEE_RECIPIENT literal matches CANONICAL_TREASURY.blurt');
else bad('frontend FEE_RECIPIENT diverged from CANONICAL_TREASURY.blurt', 'BLURT fees would split to the wrong account');

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
