#!/usr/bin/env tsx
/**
 * Morphit — push-privacy honesty smoke (v1.7.7, t.txt #6).
 *
 * A privacy control that does nothing is worse than no control: it converts a
 * cautious user's care into false confidence, on the one panel where that costs
 * the most.
 *
 * WHAT HAPPENED. Settings offered "Self-hosted only" under "Push privacy level".
 * The relay validated `privacy_mode` (api/push.ts), wrote it to the DB
 * (policy/pushSubscriptions.ts) — and **nothing ever read it back**.
 * `pushSender.ts` never looked at it; the indexer never saw it. So a
 * privacy-focused user picked the private option and Chrome kept delivering
 * through Google FCM exactly as before, while the FAQ told them "no Google, no
 * Mozilla, no third parties ever see that you received a ping".
 *
 * It also CANNOT be made real under Web Push: `pushManager.subscribe()` returns
 * an endpoint minted by the BROWSER's push service, and there is no API to
 * redirect it. UnifiedPush is the only design where a user genuinely picks their
 * own push server — a feature, not a radio button.
 *
 * Ken chose: remove the option, fix the FAQ.
 *
 * These checks pin the OUTCOME, so the option cannot creep back without the
 * delivery path that would make it true:
 *   1. the settings radio offers only what works
 *   2. the client never claims a mode nothing implements
 *   3. the FAQ does not make the promise again
 *   4. IF `self_hosted` ever returns, `pushSender` must actually branch on it
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
/** Comments must never count as evidence — a guard that documents a bug must not
 *  thereby whitelist it (the lesson from public-doc-drift-smoke). */
const strip = (s: string): string =>
	s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, ' ');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const settings = strip(read('apps/web/src/lib/components/NotificationSettings.svelte'));
const nudge = strip(read('apps/web/src/lib/components/ChatNotificationNudge.svelte'));
const prefs = strip(read('apps/web/src/lib/notifications/preferences.ts'));
const sender = strip(read('apps/relay/src/policy/pushSender.ts'));
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	faq: { entries: Record<string, { a: string }> };
	settings: { notifications: Record<string, string> };
};

// ── 1. the radio offers only what works ────────────────────────────
check(
	'1 the push-privacy radio does NOT offer self_hosted',
	!/'self_hosted'/.test(settings),
	'the option must not exist while nothing downstream implements it'
);
check(
	'2 …and still offers standard + off',
	/'standard'/.test(settings) && /'off'/.test(settings)
);
check('3 the PushPrivacy type excludes self_hosted', !/'self_hosted'/.test(prefs));

// ── 2. the client never claims a mode nothing implements ───────────
check('4 settings subscribes as standard', !/self_hosted/.test(settings));
check('5 the chat nudge subscribes as standard', !/self_hosted/.test(nudge));

// ── 3. the FAQ does not make the promise again ─────────────────────
const faq = en.faq.entries['push_notifications_privacy']?.a ?? '';
check('6 the FAQ entry still exists', faq.length > 200);
check(
	'7 the FAQ does NOT promise that no third party sees your pings',
	!/no third parties ever see|no Google, no Mozilla/i.test(faq),
	'this was false: privacy_mode was stored and never read'
);
check(
	'8 the FAQ says plainly that the BROWSER picks the push service',
	/browser picks that push service|browser picks/i.test(faq)
);
check(
	'9 …and names the removal rather than quietly dropping it',
	/did nothing|It did nothing/i.test(faq)
);
check(
	'10 …and keeps the true part: content is e2e-encrypted, only metadata leaks',
	/end-to-end encrypted/i.test(faq) && /metadata/i.test(faq)
);
check(
	'11 …and gives the one honest mitigation (turn push off; badges stay local)',
	/turn push off/i.test(faq) && /never leave your browser/i.test(faq)
);
check(
	'12 the dead self-hosted label is gone from the locale',
	en.settings.notifications['channel_push_privacy_self'] === undefined
);

// ── 4. the trap: self_hosted may only return WITH a delivery path ──
// This is the check that matters in a year. If someone re-adds the option
// because it "should" exist, this fails until pushSender actually honours it.
check(
	'13 if self_hosted ever returns to the client, pushSender MUST branch on it',
	!/'self_hosted'/.test(settings) || /privacy_mode|privacyMode/.test(sender),
	'the option is only honest once delivery actually respects it — otherwise it is decoration'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} push-privacy-honesty checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} push-privacy-honesty checks FAILED`); process.exit(1); }
