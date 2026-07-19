/**
 * footer-contact-flash-smoke — cp453 (t.txt #5)
 *
 * The footer used to print "Operated by <instance>"; that line is removed, and a
 * "Contact" link now sits at the end of the footer nav (after FAQ). Clicking it
 * lands on the instances page with ?highlight=current, which flashes the current
 * instance's card border (bright green) five times so the eye finds the instance
 * you're actually on. Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

const layout = read('apps/web/src/routes/[lang]/+layout.svelte');
const instances = read('apps/web/src/routes/[lang]/instances/+page.svelte');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	footer: Record<string, string>;
};

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// 1. The "Operated by" line is gone from the footer + the key is removed.
check('footer no longer renders the "Operated by" line', !/footer\.operated_by/.test(layout));
check('footer.operated_by key is removed from en.json', en.footer.operated_by === undefined);

// 2. A Contact link exists in the footer, pointing at the instances page with the
//    highlight signal, and it sits AFTER the FAQ link.
check(
	'footer has a Contact link → /instances?highlight=current',
	/\{lp\('\/instances'\)\}\?highlight=current[\s\S]*?footer\.contact/.test(layout) &&
		Boolean(en.footer.contact)
);
const faqIdx = layout.indexOf("lp('/faq')");
const contactIdx = layout.indexOf('highlight=current');
check('the Contact link comes after the FAQ link', faqIdx !== -1 && contactIdx > faqIdx);

// 3. The instances page reacts to ?highlight=current by flashing the CURRENT card.
check(
	'instances page reacts to highlight=current once the snapshot arrives + drives flashCurrent',
	/searchParams\.get\('highlight'\)/.test(instances) &&
		/snapshotReceived/.test(instances) &&
		/flashCurrent = true/.test(instances)
);
check(
	'the flash class is applied only to the current instance card',
	/flashCurrent &&\s*isCurrentInstance\(inst\)\s*\?\s*'flash-instance'/.test(instances)
);

// 4. The flash is a bright-green border that pulses exactly 3 times (v1.8.0:
//    slowed from 5×0.45s to 3×2s and recoloured amber → brand emerald).
check(
	'a flash-instance keyframe pulses the border 3 times in brand emerald',
	/@keyframes flash-instance-border/.test(instances) &&
		/animation: flash-instance-border [^;]* 3;/.test(instances) &&
		/#00da69/i.test(instances)
);

if (failures === 0) {
	console.log('✓ all 7 footer-contact-flash scenarios passed');
} else {
	console.log(`\n✗ ${failures}/7 footer-contact-flash scenarios failed`);
	process.exit(1);
}
