#!/usr/bin/env tsx
/**
 * Regression smoke: every explorer op-label render forwards dec.values.
 *
 * decorateOp() (lib/explorer/decorate.ts) returns { labelKey, values? } for
 * each chain op; the i18n string `explorer.op.label.<labelKey>` interpolates
 * placeholders like {voter}/{author}/{account} from `values`. All three
 * explorer views (tx, block, account) render this label. If a view calls
 *   $_(`explorer.op.label.${dec.labelKey}`)
 * WITHOUT the `{ values: dec.values }` argument, the placeholders render
 * literally — e.g. "@{voter} upvoted @{author}".
 *
 * That is exactly the cp406 block-view bug this pins: the tx + account views
 * forwarded dec.values, but the block view had dropped it. Fails if any
 * explorer view ever renders the op label without forwarding dec.values.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

const VIEWS = [
	'apps/web/src/routes/[lang]/explorer/tx/[id=trxid]/+page.svelte',
	'apps/web/src/routes/[lang]/explorer/block/[num=blocknum]/+page.svelte',
	'apps/web/src/routes/[lang]/explorer/account/[name=account]/+page.svelte'
];

// The correct render form: labelKey interpolated AND values forwarded.
const GOOD = 'explorer.op.label.${dec.labelKey}`, dec.values ? { values: dec.values } : undefined)';
// The bare (buggy) form: labelKey with the template literal closed straight
// into `)` — no values argument.
const BARE = /explorer\.op\.label\.\$\{dec\.labelKey\}`\)/;

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${e instanceof Error ? e.message : String(e)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

for (const rel of VIEWS) {
	const view = rel.split('/explorer/')[1].split('/')[0]; // tx | block | account
	scenario(`${view} view forwards dec.values to the op label`, () => {
		const src = readFileSync(join(REPO, rel), 'utf8');
		assert(
			src.includes('explorer.op.label.${dec.labelKey}'),
			`${view}: op-label render not found — did the render move or the key change?`
		);
		assert(
			src.includes(GOOD),
			`${view}: op label must forward dec.values (expected \`${GOOD}\`)`
		);
		assert(
			!BARE.test(src),
			`${view}: found a bare explorer.op.label render with no values argument — {voter}/{author}/… will show literally`
		);
	});
}

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
