/**
 * native-translations-snapshot-rebuild.ts
 *
 * Deliberate-action script: regenerates
 * `apps/web/scripts/native-translations-snapshot.json` from the
 * current state of `apps/web/src/lib/i18n/locales/*.json`.
 *
 * The snapshot is the FLOOR that
 * `native-translations-floor-smoke.ts` checks against. Run this
 * whenever you intentionally ship new native translations (a
 * translator pass, a per-locale revamp, etc.) — the smoke would
 * otherwise either keep flagging the old floor as the target or
 * accidentally accept future regressions.
 *
 * NOT registered in `scripts/run-smokes.sh` — this is a manual
 * tool, not part of the suite.
 *
 * Usage:
 *   cd apps/web && tsx scripts/native-translations-snapshot-rebuild.ts
 *
 * The rebuild is byte-for-byte deterministic given the input
 * locale files (keys are sorted, output uses tab indentation
 * matching the locale JSON convention). The diff against the
 * existing snapshot is what you commit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const LOCALES_DIR = resolve(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const SNAPSHOT_PATH = resolve(__dirname, 'native-translations-snapshot.json');

const LOCALES = ['es', 'fr', 'de', 'it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK'];

function flatten(d: unknown, prefix = ''): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (d === null || typeof d !== 'object') return out;
	for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
		const full = prefix ? `${prefix}.${k}` : k;
		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			Object.assign(out, flatten(v, full));
		} else {
			out[full] = v;
		}
	}
	return out;
}

const enRaw = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf8'));
const enFlat = flatten(enRaw);

const natives: Record<string, string[]> = {};
const counts: Record<string, number> = {};

for (const locale of LOCALES) {
	const raw = JSON.parse(readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf8'));
	const flat = flatten(raw);
	const keys = Object.keys(flat)
		.filter((k) => k in enFlat && flat[k] !== enFlat[k])
		.sort();
	natives[locale] = keys;
	counts[locale] = keys.length;
}

const out = {
	_meta: {
		description:
			'Snapshot of (key, locale) pairs where the locale value differs ' +
			'from the canonical English value. Captured as the floor that ' +
			'native-translations-floor-smoke.ts checks against to prevent ' +
			'the LL #46 regression class (overwriting a native translation ' +
			'with EN-fallback).',
		baseline_taken_at: new Date().toISOString().slice(0, 10),
		en_total_leaves: Object.keys(enFlat).length,
		native_pair_counts_per_locale: counts,
		regenerate_with:
			'tsx apps/web/scripts/native-translations-snapshot-rebuild.ts ' +
			'(deliberate action; rebuilds this file from the current state ' +
			'of the locales).',
		how_smoke_uses_this:
			'native-translations-floor-smoke loads this snapshot, then for ' +
			'every (locale, key) pair listed under "natives" verifies the ' +
			'current locale file still has a value different from EN. Any ' +
			'regression (locale value became EN-identical) FAILS the smoke. ' +
			'Adding new natives is fine — they just need a regenerate when ' +
			'they ship, which is the same discipline as committing the new ' +
			'translations themselves.'
	},
	natives
};

writeFileSync(SNAPSHOT_PATH, JSON.stringify(out, null, '\t') + '\n');
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`Rebuilt snapshot:`);
console.log(`  EN total leaves: ${Object.keys(enFlat).length}`);
for (const loc of LOCALES) {
	console.log(`  ${loc}: ${counts[loc]} natives`);
}
console.log(`  Total native pairs: ${total}`);
console.log(`Wrote ${SNAPSHOT_PATH}`);
