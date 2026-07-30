/**
 * support-operator-matrix-removed-smoke — cp453 (t.txt #6)
 *
 * The Support page's "Chat with the operator on Matrix" card was removed (its
 * three support.operator_matrix_* keys retired). The unrelated
 * `operator_matrix_room` schema field — used by the about-this-instance surface —
 * must NOT be touched. Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

const support = read('apps/web/src/routes/[lang]/support/+page.svelte');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	support: Record<string, unknown>;
};

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

check(
	'the Support page no longer renders the operator-Matrix card',
	!/operator_matrix/.test(support)
);
check(
	'the three support.operator_matrix_* keys are removed',
	en.support.operator_matrix_title === undefined &&
		en.support.operator_matrix_body === undefined &&
		en.support.operator_matrix_cta === undefined
);
check(
	'the unrelated operator_matrix_room schema field is untouched (still referenced somewhere)',
	// It must NOT have been collaterally removed — it still lives in the
	// instance/about surfaces. Confirm the string exists in the repo config schema.
	/operator_matrix_room/.test(read('apps/web/src/lib/stores/instance.ts'))
);

if (failures === 0) {
	console.log('✓ all 3 support-operator-matrix-removed scenarios passed');
} else {
	console.log(`\n✗ ${failures}/3 support-operator-matrix-removed scenarios failed`);
	process.exit(1);
}
