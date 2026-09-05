/**
 * operator-tag-guard-smoke (v1.16.5)
 *
 * The federation tag is immutable: a re-register under a different tag is
 * rejected on-chain as `tag_immutable` and silently changes nothing. `register`
 * now pre-flights this against the local indexer (operatorTagGuard) so it can't
 * emit a doomed op. This pins both the pure decision and the wiring.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operatorTagConflict } from '../src/lib/operatorTagGuard.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

// ── pure decision ──
check('different tag → conflict (would be rejected)', operatorTagConflict('morphitlat-relay', 'morphitlat') === true);
check('same tag → no conflict (normal update)', operatorTagConflict('morphitlat-relay', 'morphitlat-relay') === false);
check('not registered (null) → no conflict (first register)', operatorTagConflict(null, 'anything') === false);
check('unverifiable (null) never blocks', operatorTagConflict(null, 'morphit.io') === false);

// ── wiring: register.ts pre-flights the guard and refuses on conflict ──
const reg = readFileSync(join(REPO, 'apps/ops-cli/src/commands/register.ts'), 'utf8');
check('register imports the guard', /operatorTagConflict|fetchRegisteredTag/.test(reg) && /operatorTagGuard/.test(reg));
check('register fetches the existing on-chain tag', /fetchRegisteredTag\(account\)/.test(reg));
check('register refuses on tag conflict (returns before broadcast)', /if \(operatorTagConflict\([\s\S]{0,1200}?return 1;/.test(reg));
check('conflict message names tag_immutable', /tag_immutable/.test(reg));
// the guard must run BEFORE the broadcast
const guardIdx = reg.indexOf('operatorTagConflict(');
const broadcastIdx = reg.indexOf('broadcastCustomJson({');
check('guard runs before the broadcast', guardIdx > 0 && broadcastIdx > 0 && guardIdx < broadcastIdx);

console.log(
	fail === 0 ? `✓ all ${pass} operator-tag-guard checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
