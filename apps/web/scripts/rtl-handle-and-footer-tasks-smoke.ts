/**
 * t.txt (v1.9.15, Ken) — locks in four UI/i18n rules delivered in one batch:
 *
 *   Task 1  RTL @handle isolation — an @{handle} slot renders LEFT-TO-RIGHT
 *           ("@alice", never "alice@") in EVERY locale. Enforced at i18n load
 *           time (a transform wraps every @{var} in LTR-isolate marks) and at
 *           the two inline non-i18n render sites (profile <h1>, backup card).
 *           "set in stone" — a translator or a new string can't reintroduce it.
 *   Task 2  The "🎉 Featured" auction card self-hides when nothing is featured
 *           (no live featured order AND no clearing-price history) instead of
 *           showing an empty "be the first" card.
 *   Task 5  The footer link block is 5 titled, responsive columns; the
 *           "Peer-to-peer…" tagline and the "Also reachable via" heading are gone.
 *   Task 6  The run-a-node "See the repo" button points at /download.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHandleString, isolateAtHandles, LRI, PDI } from '../src/lib/i18n/rtlHandle';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(WEB, rel), 'utf8');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

let passed = 0;
let failed = 0;
function check(desc: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${desc}`);
	} else {
		failed++;
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── rtl-handle-and-footer-tasks (t.txt v1.9.15) ──\n');

// ─── Task 1: the isolate transform behaves ──────────────────────
check(
	'isolateHandleString wraps @{peer} in LTR-isolate marks',
	isolateHandleString('Message @{peer}…') === `Message ${LRI}@{peer}${PDI}…`
);
check(
	'isolateHandleString is idempotent (no double-wrap)',
	isolateHandleString(isolateHandleString('hi @{account}!')) === isolateHandleString('hi @{account}!')
);
check(
	'isolateHandleString leaves ICU {n, plural, …} untouched',
	isolateHandleString('{n, plural, one {# item} other {# items}}') ===
		'{n, plural, one {# item} other {# items}}'
);
check(
	'a bare {peer} (no @) is left alone — only @handles are isolated',
	isolateHandleString('sent to {peer}') === 'sent to {peer}'
);
check(
	'isolateAtHandles recurses into nested objects + arrays',
	(() => {
		const t = isolateAtHandles({ x: 'hi @{account}', y: { z: 'yo @{peer}' }, arr: ['@{author}'], n: 5 });
		return (
			t.x === `hi ${LRI}@{account}${PDI}` &&
			t.y.z === `yo ${LRI}@{peer}${PDI}` &&
			t.arr[0] === `${LRI}@{author}${PDI}` &&
			t.n === 5
		);
	})()
);

// ─── Task 1: the rule is wired structurally ─────────────────────
const idx = read('src/lib/i18n/index.ts');
check(
	'i18n loader applies isolateAtHandles to every registered locale',
	/isolateAtHandles\(/.test(idx) && /register\(/.test(idx) && /import.*rtlHandle/.test(idx)
);
const css = read('src/app.css');
check(
	'.ltr-in-rtl class exists (unicode-bidi:isolate + direction:ltr)',
	/\.ltr-in-rtl\s*\{[\s\S]*?unicode-bidi:\s*isolate[\s\S]*?direction:\s*ltr[\s\S]*?\}/.test(css)
);
const profile = read('src/routes/[lang]/explorer/account/[name=account]/+page.svelte');
check(
	'profile <h1> @{account} is LTR-isolated via ltr-in-rtl',
	/<bdi class="ltr-in-rtl">@\{account\}<\/bdi>/.test(profile)
);
const backup = read('src/lib/components/SeedBackupPrint.svelte');
check(
	'backup-card @{accountName} is LTR-isolated via ltr-in-rtl',
	/<bdi class="ltr-in-rtl">@\{accountName\}<\/bdi>/.test(backup)
);
// Sanity: the transform actually has targets — @handles ARE used in strings.
const enHandles = (read('src/lib/i18n/locales/en.json').match(/@\{(account|peer|author|name)\}/g) ?? [])
	.length;
check(`en.json has @handle interpolations for the transform to cover (${enHandles})`, enHandles > 10);

// ─── Task 5: footer is 5 titled responsive columns ──────────────
const layout = read('src/routes/[lang]/+layout.svelte');
check('footer "Peer-to-peer…" tagline render removed', !layout.includes('footer.tagline'));
check('footer "Also reachable via" heading render removed', !layout.includes('footer.reachable_via'));
check(
	'footer link block is a responsive grid (2→3→5 columns)',
	/aria-label="Footer"[^>]*class="grid[^"]*grid-cols-2[^"]*sm:grid-cols-3[^"]*lg:grid-cols-5/.test(
		layout
	)
);
for (const k of ['col_federation', 'col_resources', 'col_security', 'col_media', 'col_support']) {
	check(`footer renders column header footer.${k}`, layout.includes(`footer.${k}`));
}
// Canary + PGP share one line (Ken).
check(
	'Canary and PGP sit on the same line',
	/footer\.canary'[\s\S]{0,220}footer\.pgp_keys'/.test(layout)
);

// ─── Task 5: locale parity for the 5 new headers, 2 removed keys ─
for (const loc of LOCALES) {
	const foot = (JSON.parse(read(`src/lib/i18n/locales/${loc}.json`)) as { footer: Record<string, unknown> })
		.footer;
	for (const k of ['col_federation', 'col_resources', 'col_security', 'col_media', 'col_support']) {
		check(`${loc}: footer.${k} present + non-empty`, typeof foot[k] === 'string' && (foot[k] as string).length > 0);
	}
	check(`${loc}: footer.tagline key removed`, !('tagline' in foot));
	check(`${loc}: footer.reachable_via key removed`, !('reachable_via' in foot));
}

// ─── Task 2: the Featured card self-hides when empty ────────────
const fah = read('src/lib/components/FeaturedAuctionHistory.svelte');
check(
	'FeaturedAuctionHistory computes a showCard gate (history OR live count)',
	/showCard\s*=\s*\$derived\([^)]*hasAnyClearing[^)]*liveFeaturedCount/.test(fah)
);
check(
	'FeaturedAuctionHistory display:none-hides the card when !showCard (child stays mounted)',
	/class:hidden=\{!showCard\}/.test(fah)
);

// ─── Task 6: run-a-node repo button → /download ─────────────────
const ran = read('src/routes/[lang]/run-a-node/+page.svelte');
check(
	'run-a-node "See the repo" button links to /download',
	ran.includes(`href={lp('/download')} class="btn-primary btn-shine"`) && ran.includes('run_a_node.cta_repo')
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} rtl-handle-and-footer-tasks checks passed` : '✗ rtl-handle-and-footer-tasks FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
