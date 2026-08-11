#!/usr/bin/env tsx
/**
 * directory-card-hidden-service — cp703 (Layer 4 of the hidden-service epic).
 *
 * The federated-directory card must present onion-only nodes correctly:
 *   - the title links to SOMETHING reachable, preferring the origin then the
 *     operator's advertised hidden services in order (Tor → named I2P → I2P b32
 *     → Lokinet) — never a dead title;
 *   - a hidden-service (or absent) origin shows "No clearnet reliance" instead
 *     of a bare onion string;
 *   - the "Indexed block" row is gone from every card.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; }
};

console.log('\n── directory-card-hidden-service (cp703) ──────────────\n');
const page = read('apps/web/src/routes/[lang]/instances/+page.svelte');
check('title-link falls through Tor → named I2P → I2P b32 → Lokinet',
	/function titleHref/.test(page) && /a\.tor, a\.i2p_name, a\.i2p_b32, a\.lokinet/.test(page));
check('title uses the fallback (not the raw origin) for the link',
	/\{@const safeOrigin = titleHref\(inst\)\}/.test(page));
check('hidden-service / absent origin shows "No clearnet reliance"',
	/isHiddenServiceOrigin\(inst\.origin\)/.test(page) && /instances\.no_clearnet/.test(page));
check('the "Indexed block" row was removed from the card',
	!/indexed_block/.test(page));

// 10-locale parity for the new label
const locs = readdirSync(join(REPO, 'apps/web/src/lib/i18n/locales')).filter((f) => f.endsWith('.json'));
let parity = locs.length === 10;
for (const f of locs) {
	const nc = (JSON.parse(read(`apps/web/src/lib/i18n/locales/${f}`)).instances || {}).no_clearnet;
	if (typeof nc !== 'string' || nc.length === 0) parity = false;
}
check('all 10 locales carry instances.no_clearnet', parity);

console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} directory-card-hidden-service checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
