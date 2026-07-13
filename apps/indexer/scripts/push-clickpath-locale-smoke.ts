/**
 * push-clickpath-locale-smoke — every Web-Push `click_path` a handler
 * enqueues into push_pending MUST carry the [lang] segment, and account /
 * order / profile pages MUST carry the `@`.  There is no reroute hook
 * (apps/web/src/routes/[lang]/+layout.ts redirects only once a route has
 * matched), so a locale-less or @-less path resolves to no route and the
 * notification click lands on a 404.
 *
 * cp470 — kentest3 tapped an order notification and landed on
 * /kentest3/order-… → 404; the correct target is /en/@kentest3/order-….
 * Three enqueue sites shared the defect (chat.ts, featureBid.ts,
 * feedback.ts).  This guard keeps every click_path locale-prefixed and
 * @-correct, and fails if a new enqueue site forgets either.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/indexer

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${String((err as Error)?.message ?? err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

// Strip // line comments and block comments so a comment quoting an old
// (broken) path can't satisfy or trip an assertion.
function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(rel: string): string {
	return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

const chat = read('src/indexer/handlers/chat.ts');
const feature = read('src/indexer/handlers/featureBid.ts');
const feedback = read('src/indexer/handlers/feedback.ts');

// ── Positive: the correct locale-prefixed shapes are present ──────────
scenario('chat.ts order click_path is /${locale}/@${recipient}/${permlink}', () => {
	assert(
		chat.includes('`/${locale}/@${recipient}/${claimedPermlink}`'),
		'chat.ts order click_path is not the localized /@account/permlink shape'
	);
});
scenario('chat.ts plain-chat click_path is /${locale}/chat', () => {
	assert(chat.includes('`/${locale}/chat`'), 'chat.ts plain-chat click_path missing locale prefix');
});
scenario('featureBid.ts outbid click_path is /${locale}/my/orders#…', () => {
	assert(
		/`\/\$\{locale\}\/my\/orders#order-\$\{/.test(feature),
		'featureBid.ts outbid click_path missing locale prefix'
	);
});
scenario('feedback.ts click_path is /${locale}/@${subject}#reviews-heading', () => {
	assert(
		feedback.includes('`/${locale}/@${subject}#reviews-heading`'),
		'feedback.ts click_path is not the localized /@account#reviews-heading shape'
	);
});

// ── Negative: the old locale-less / @-less shapes must be gone ────────
scenario('chat.ts: no locale-less /${recipient}/${permlink} path', () => {
	assert(
		!chat.includes('`/${recipient}/${claimedPermlink}`'),
		'chat.ts still contains the locale-less order path'
	);
});
scenario('featureBid.ts: no locale-less /my/orders path', () => {
	assert(!/`\/my\/orders#order-\$\{/.test(feature), 'featureBid.ts still contains a locale-less /my/orders path');
});
scenario('feedback.ts: no locale-less /${subject} path', () => {
	assert(
		!feedback.includes('`/${subject}#reviews-heading`'),
		'feedback.ts still contains the locale-less /${subject} path'
	);
});

// ── Sweep: any template literal that looks like a notification click
//    target (has `@${`, `/my/orders`, or `#reviews-heading`) must be
//    locale-prefixed.  Catches a NEW enqueue site that forgets. ────────
for (const [name, src] of [
	['chat.ts', chat],
	['featureBid.ts', feature],
	['feedback.ts', feedback]
] as const) {
	const literals = src.match(/`\/[^`]*`/g) ?? [];
	for (const lit of literals) {
		if (/@\$\{|\/my\/orders|#reviews-heading/.test(lit)) {
			scenario(`${name}: click-target literal ${lit} is locale-prefixed`, () => {
				assert(lit.startsWith('`/${locale}/'), `${lit} is missing the /${'${locale}'}/ prefix`);
			});
		}
	}
}

if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} of ${scenarios} push-clickpath-locale checks FAILED`);
	process.exit(1);
}
