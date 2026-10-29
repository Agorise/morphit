#!/usr/bin/env tsx
/**
 * post-flow-ux — v1.21.17 (owner's report from posting on a branded instance).
 *
 * 1. Pressing Continue at the bottom of step 3 opened step 4 already scrolled
 *    down, its top out of sight — and every later step (password, posting,
 *    done, error) the same: the post page swaps its content by `phase`, and
 *    only a navigation scrolls to the top. Same for editing an order and the
 *    2FA set-up.
 * 2. "Set up a featured bid" opened My Orders with the order ringed; the
 *    Feature form then had to be opened by hand. It now opens by itself.
 * 3. Posting failed with "indexer /v1/account/:name/keys timed out"; the two
 *    signing paths now ask once more before failing (accountKeys.test.ts
 *    covers the behaviour; this pins that they use it).
 * 4. The wallet card's background was the stock Tailwind emerald, green on a
 *    gold-branded instance. Brand surfaces take the brand token.
 *
 * Tamper tests (each must turn this red): drop the phase effect or its
 * preventScroll; scroll on leaving 'loading' on the edit/2FA pages; stop
 * opening the Feature form from ?featuring=, or open it without the
 * featurable check; point the success link elsewhere; sign with the plain key
 * lookup; put a stock dark green back under a brand border.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');
const post = read('src/routes/[lang]/post/+page.svelte');
const edit = read('src/routes/[lang]/post/edit/[permlink]/+page.svelte');
const twofa = read('src/routes/[lang]/settings/security/2fa/+page.svelte');
const onboarding = read('src/routes/[lang]/onboarding/+page.svelte');
const orders = read('src/routes/[lang]/my/orders/+page.svelte');
const binding = read('src/lib/blurt/accountBinding.ts');
const unlock = read('src/lib/components/UnlockActiveKeyModal.svelte');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean): void => {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) passed++;
	else failed++;
};

// 1 — every step opens at its top
check(
	'post: each phase opens at its top',
	/import \{ topOnChange \} from '\$lib\/ui\/pageTop';/.test(post) &&
		/const phaseTop = topOnChange<Phase>\(\);\s*\$effect\(\(\) => phaseTop\(phase\)\);/.test(post)
);
check(
	'post: focusing the password field does not scroll it into view',
	/function focusOnMount\(node: HTMLElement\): void \{[\s\S]{0,200}node\.focus\(\{ preventScroll: true \}\);/.test(
		post
	) && !/node\.focus\(\);/.test(post)
);
for (const [name, src, quiet, effect] of [
	[
		'edit order',
		edit,
		`['loading', 'retrying_indexer']`,
		`$effect(() => phaseTop(phase === 'saving' ? 'ready' : phase));`
	],
	['2FA', twofa, `['loading']`, `$effect(() => phaseTop(phase));`]
] as const) {
	check(
		`${name}: each screen opens at its top, the first load stays put`,
		/import \{ topOnChange \} from '\$lib\/ui\/pageTop';/.test(src) &&
			src.includes(`const phaseTop = topOnChange<Phase>({ quietFrom: ${quiet} });`) &&
			src.includes(effect)
	);
}
check(
	'onboarding: each stage still opens at its top',
	/\$effect\(\(\) => \{\s*void stage;\s*window\.scrollTo\(0, 0\);\s*\}\);/.test(onboarding)
);

// 2 — the featured-bid link opens the Feature form
check(
	'post: "Set up a featured bid" names the order it was about',
	/href=\{lp\(successPermlink \? `\/my\/orders\?featuring=\$\{successPermlink\}` : '\/my\/orders'\)\}/.test(
		post
	)
);
check(
	"my orders: ?featuring= opens that order's Feature form once it can be featured",
	/const featuringTarget = \$derived\.by\(\(\) => \{[\s\S]{0,200}items\.find\(\(x\) => x\.permlink === featuringPermlink\)/.test(
		orders
	) &&
		/if \(o === null \|\| !featureFormOpenable\(o, isLive\(o\), paidPermlinks\.has\(o\.permlink\)\)\) return;\s*untrack\(\(\) => \{\s*featuringHandled = true;\s*if \(pendingFeaturePermlink !== null\) return;\s*pendingFeaturePermlink = o\.permlink;\s*void ensureFeatureRateFetched\(\);\s*scrollToFeatureForm\(o\.permlink\);/.test(
			orders
		)
);
check(
	'my orders: it keeps reading the orders until then (long enough for a BTC/XMR fee), and says so',
	/const wait = featuringNextPollMs\(Date\.now\(\) - featuringStartedMs\);\s*if \(wait === null\) \{\s*featuringHandled = true;\s*return;\s*\}\s*timer = setTimeout\(\(\) => \{\s*void silentRefetch\(\);\s*next\(\);\s*\}, wait\);/.test(
		orders
	) &&
		/\{:else if featuringWaiting && o\.permlink === featuringPermlink && !paidPermlinks\.has\(o\.permlink\)\}[\s\S]{0,400}\$_\('my_orders\.order\.feature_opens_when_fee_confirmed'\)/.test(
			orders
		)
);
check(
	'my orders: the #feature= hand-off uses the same check',
	/if \(action\.kind === 'feature'\) \{\s*if \(featureFormOpenable\(o, isLive\(o\), paidPermlinks\.has\(o\.permlink\)\)\) \{/.test(
		orders
	)
);

// 3 — signing paths retry the key lookup once
check(
	'posting: the forward key check asks again once before failing',
	/const authorities = await fetchAccountKeysForSigning\(/.test(binding) &&
		!/await fetchAccountKeys\(/.test(binding)
);
check(
	'active-key window: asks again once before "lookup failed"',
	/const keys = await fetchAccountKeysForSigning\(/.test(unlock) &&
		!/await fetchAccountKeys\(/.test(unlock)
);

// 4 — brand surfaces take the brand token, not stock greens
const files: string[] = [];
const walk = (d: string): void => {
	for (const n of readdirSync(join(WEB, d))) {
		const p = join(d, n);
		if (statSync(join(WEB, p)).isDirectory()) walk(p);
		else if (p.endsWith('.svelte')) files.push(p);
	}
};
walk('src');
const mixed: string[] = [];
for (const f of files) {
	for (const m of read(f).matchAll(/class="([^"]*)"/g)) {
		const cls = m[1]!;
		if (
			/morphit-(emerald|teal)/.test(cls) &&
			/\bdark:bg-(emerald|teal|green)-\d{2,3}\b/.test(cls)
		) {
			mixed.push(`${f}: ${cls.slice(0, 80)}`);
		}
	}
}
check(
	`no brand-bordered surface has a stock green dark background${mixed.length ? ` (${mixed.join('; ')})` : ''}`,
	mixed.length === 0 && files.length > 50
);
check(
	'the wallet card is tinted with the brand colour',
	/class="card border border-morphit-emerald\/30 [^"]*dark:bg-morphit-emerald\/\[0\.05\]"/.test(
		read('src/lib/components/MyBalanceCard.svelte')
	)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} post-flow-ux scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} post-flow-ux scenarios FAILED`);
process.exit(1);
