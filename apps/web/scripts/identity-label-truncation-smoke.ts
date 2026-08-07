#!/usr/bin/env tsx
/**
 * Morphit — IdentityLabel truncation smoke (v1.7.7, t.txt #9).
 *
 * Ken photographed a chat card where "Super loong display name" ran past the
 * card edge into the Restore button, while the RE: line directly beneath it
 * truncated at "RE: I'm bu…". Two lines in the same card, disagreeing about how
 * much room they had.
 *
 * THE CAUSE, and why it is worth a guard rather than a one-line fix and a shrug:
 * `IdentityLabel`'s root was `inline-flex` with no `min-w-0` / `max-w-full`.
 * That is TWO independent reasons to refuse to shrink — an inline-flex box sizes
 * to its content, AND a flex item defaults to `min-width: auto` ("never smaller
 * than my content"). So the root ignored the width its parent handed it, and
 * every `min-w-0 truncate` INSIDE the component never saw a constraint to
 * truncate against. The truncation wasn't missing. It was INERT.
 *
 * That is the whole trap: the fix looks present in the markup. You can read
 * `truncate` on the name span, believe the component truncates, and be wrong —
 * because correctness lives in the CHAIN, not in any single element. One
 * `min-width: auto` anywhere above pins everything below it.
 *
 * IdentityLabel renders in 18 files. A regression here is silent (text simply
 * overflows on a narrow screen; nothing errors, no test fails), and only ever
 * shows up in a screenshot from a phone.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const id = read('apps/web/src/lib/components/IdentityLabel.svelte');
const page = read('apps/web/src/routes/[lang]/chat/+page.svelte');

// ── the shrink chain, top to bottom ─────────────────────────────────
check(
	'1 the inbox card gives IdentityLabel a bounded column',
	/<div class="flex min-w-0 flex-1 flex-col gap-0\.5">/.test(page),
	'without min-w-0 here the column itself refuses to shrink and nothing below can truncate'
);
check(
	'2 IdentityLabel root can shrink (min-w-0 + max-w-full on the inline-flex)',
	/<span class="group inline-flex min-w-0 max-w-full items-center/.test(id),
	'inline-flex sizes to content AND flex items default to min-width:auto — both must be overridden'
);
check(
	'3 the name anchor can shrink',
	/<a[\s\S]{0,80}?class="inline-flex min-w-0 max-w-full items-baseline/.test(id)
);
check(
	'4 the no-href name span can shrink',
	/<span class="inline-flex min-w-0 max-w-full items-baseline">/.test(id)
);
check(
	'5 the name itself still truncates',
	/<span class="min-w-0 truncate">\{@render nameText\(\)\}<\/span>/.test(id),
	'this line looked correct the whole time it was doing nothing'
);
check(
	'6 the key/handle branch also truncates',
	/<span class="inline-flex min-w-0 flex-col leading-tight">[\s\S]{0,120}?<span class="truncate">/.test(id)
);

// ── the RE: line must agree with the name line ──────────────────────
check(
	'7 the RE: row can shrink',
	/<div class="flex min-w-0 items-baseline gap-1 text-xs/.test(page)
);
check(
	'8 the order title truncates rather than overflowing',
	/<span class="min-w-0 truncate">\{orderTitle\}<\/span>/.test(page)
);
check(
	'9 the status badge never shrinks (it is short and must stay legible)',
	/<span class="flex-none">\(\{orderStatusLabel\(convo\.order\)\}\)<\/span>/.test(page)
);

// ── t.txt #9: the feedback row ──────────────────────────────────────
check(
	'10 the feedback row does NOT show the "I rated @x:" label',
	!/<span class="font-medium"\s*>\{\$_\('profile\.given_rated'/.test(page),
	'it wrapped to a second line, pushed the stars down, and starved the comment of width'
);
check(
	'11 …but a screen reader still gets the sentence',
	/class="sr-only"[\s\S]{0,120}?profile\.given_rated/.test(page),
	'removing a VISUAL label must not remove the meaning'
);
check(
	'12 the stars never shrink',
	/<span class="flex-none text-morphit-emerald" aria-hidden="true"/.test(page),
	'flex-none is what hands the leftover width to the comment'
);
check(
	'13 the feedback row does not wrap (it truncates at the edge instead)',
	/<div class="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">/.test(page) &&
		!/flex flex-wrap items-baseline gap-1 text-xs text-ink-500/.test(page),
	'flex-wrap let the row grow a second line instead of the comment truncating honestly'
);
check(
	'14 the comment still truncates',
	/<span[^>]*\bclass="min-w-0 truncate text-ink-500 dark:text-ink-400"[^>]*>\{fb\.record\.comment\}<\/span/.test(page)
);


// ── t.txt #6: review cards ────────────────────────────────────────
// [KEN]: "no need to show the (@username) in parenthesis, and be sure to
// truncate the display name line since it is too wide for mobile. the layout of
// those feedback/review cards on mobile is attrocious."
const profile = read('apps/web/src/routes/[lang]/[x+40][account=account]/+page.svelte');

check(
	'15 review cards do NOT repeat the handle in parentheses',
	!/showHandleAfterName/.test(profile),
	'it cost half a phone-width to repeat what the key underneath already answers better'
);
check(
	'16 …and the prop that drew it is gone entirely, not just unused',
	!/showHandleAfterName/.test(id.replace(/<!--[\s\S]*?-->/g, '')),
	'a prop with no callers is cruft the compiler cannot see'
);
check(
	'17 the reviewer is still identified — by KEY, which is the real identity',
	/publicKeyString=\{reviewerProfileMap\[fb\.reviewer\]\?\.posting_pubkey \?\? undefined\}/.test(
		profile
	),
	'a display name is user-chosen and not unique; removing the handle is only safe because the key stays'
);
check(
	'18 …and the label still links to the account',
	/href=\{lp\(`\/@\$\{fb\.reviewer\}`\)\}/.test(profile),
	'the handle is one tap away, which is where it belongs on a narrow screen'
);
check(
	'19 the key-bearing branch stacks name over key and truncates the name',
	/<span class="inline-flex min-w-0 flex-col leading-tight">\s*<span class="truncate">\{@render nameText\(\)\}<\/span>/.test(
		id
	),
	'this is the branch review cards take (publicKeyString is set); min-w-0 on the COLUMN is what lets the name shrink'
);
check(
	'20 the key itself is truncated head…tail, so it never drives the width',
	/truncatePublicKey/.test(id),
	'an untruncated BLT key is wider than most display names and would keep the column wide on its own'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} identity-label-truncation checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} identity-label-truncation checks FAILED`); process.exit(1); }
