/**
 * instances-current-by-origin-smoke — v1.4.9 (t.txt #1)
 *
 * The instances directory highlights "the instance you are on" (card ring +
 * badge + sort-to-top + the footer Contact-link flash). It MUST identify the
 * current instance by ORIGIN, not by any single Blurt account field: the
 * canonical instance runs three separate accounts (@morphit operator,
 * @morphit-relay relay, @morphit-fees fees), and the old
 * `entry.operator_account === $instance.relay_account` check was ALWAYS false
 * there — so the highlight and the flash never fired.
 *
 * Pin the origin match and pin that the account comparison stays gone. Also pin
 * that the footer link actually carries ?highlight=current (the flash trigger).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(repo, p), 'utf8');

// Strip line + block comments so the doc-comment that *describes* the old bug
// (it names `operator_account`/`relay_account`) can't trip the regression pin.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const pageRaw = read('apps/web/src/routes/[lang]/instances/+page.svelte');
const page = stripComments(pageRaw);
const layout = stripComments(read('apps/web/src/routes/[lang]/+layout.svelte'));

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// 1. isCurrentInstance matches by normalized origin.
check(
	'isCurrentInstance compares normalized origins (normOrigin(entry.origin) === currentOrigin)',
	/normOrigin\(entry\.origin\)/.test(page) && /=== currentOrigin/.test(page)
);
check(
	'currentOrigin is derived from the browser location (window.location.origin)',
	/currentOrigin\s*=\s*normOrigin\(browser \? window\.location\.origin/.test(page)
);
// normOrigin must canonicalize via the URL origin (not a raw string compare).
check(
	'normOrigin canonicalizes via new URL(raw).origin',
	/new URL\(raw\)\.origin/.test(page)
);

// 2. The regressed account comparison must NOT come back (in code, not comments).
check(
	'NO account-field comparison for current-instance (operator_account === …relay_account)',
	!/operator_account\s*===\s*\$?instance\.relay_account/.test(page)
);
check(
	'the current-instance sort uses isCurrentInstance(a)/isCurrentInstance(b)',
	/isCurrentInstance\(a\)/.test(page) && /isCurrentInstance\(b\)/.test(page)
);

// 3. The footer Contact link carries the flash trigger.
check(
	'footer Contact link lands on /instances with ?highlight=current',
	/highlight=current/.test(layout)
);

// 4. The flash is the brand emerald (v1.8.0: recoloured from the warm
//    amber-yellow #f59e0b to #00da69 so the highlight matches the palette),
//    and never the older green (#22c55e) or the retired amber.
check(
	'flash color is brand emerald (#00da69), not amber (#f59e0b) or old green (#22c55e)',
	/#00da69/i.test(pageRaw) && !/#f59e0b/i.test(pageRaw) && !/#22c55e/i.test(pageRaw)
);
check(
	'the flash keyframe + .flash-instance animation are still present',
	/@keyframes flash-instance-border/.test(pageRaw) &&
		/:global\(\.flash-instance\)/.test(pageRaw)
);

if (failures === 0) {
	console.log(`✓ all ${total} instances-current-by-origin scenarios passed`);
} else {
	console.log(`\n✗ ${failures} of ${total} instances-current-by-origin checks FAILED`);
	process.exit(1);
}
