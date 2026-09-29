/**
 * waf-broadcast-probe smoke (review B9).
 *
 * The WAF self-heal probes /v1/broadcast and reports whether a real-sized
 * upload fits. It USED to treat any code that was not 413 as "OK" — including
 * `000`, which curl returns when it could not connect at all (e.g. morphitir,
 * whose clearnet is filtered upstream). Reporting "broadcast body limit OK" for
 * a box it never reached is alarm/assurance about an unverified condition. Only
 * a real HTTP answer is conclusive.
 */
import { classifyBroadcastProbe } from '../src/commands/upgrade.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

check('413 → too-large', classifyBroadcastProbe('413') === 'too-large');
check('200 → fits', classifyBroadcastProbe('200') === 'fits');
check('403 → fits (reached the edge, not a size limit)', classifyBroadcastProbe('403') === 'fits');
check(
	'000 (connect failure) → unreachable, NOT fits',
	classifyBroadcastProbe('000') === 'unreachable'
);
check('empty (no response) → unreachable', classifyBroadcastProbe('') === 'unreachable');
check('502 (edge error) → unreachable, NOT fits', classifyBroadcastProbe('502') === 'unreachable');

console.log(
	fail === 0 ? `✓ all ${pass} waf-broadcast-probe checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
