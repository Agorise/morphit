/**
 * branding-status-perms smoke (review H-17).
 *
 * When a branding config file EXISTS but is not readable as the current user
 * (root-owned, no sudo), readBrandingSettings silently returns "unset" for every
 * value — so `branding status` would tell the operator nothing is branded and
 * the build differs. It must instead detect the unreadable config and say to
 * re-run with sudo. Exercises the real decision (anyExistingFileUnreadable) with
 * injected fs, since as root accessSync never denies.
 */
import { anyExistingFileUnreadable } from '../src/commands/branding.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

const eacces = (): never => {
	const e: NodeJS.ErrnoException = new Error('EACCES');
	e.code = 'EACCES';
	throw e;
};

check(
	'existing-but-unreadable file → true (needs sudo)',
	anyExistingFileUnreadable(['/etc/morphit/morphit.config.env'], {
		exists: () => true,
		access: eacces
	}) === true
);
check(
	'all files readable → false',
	anyExistingFileUnreadable(['/a', '/b'], { exists: () => true, access: () => {} }) === false
);
check(
	'no files exist → false (genuinely unset, not a perms problem)',
	anyExistingFileUnreadable(['/a', '/b'], { exists: () => false, access: eacces }) === false
);
check(
	'mixed: one readable, one unreadable → true',
	anyExistingFileUnreadable(['/ok', '/locked'], {
		exists: () => true,
		access: (p) => {
			if (p === '/locked') eacces();
		}
	}) === true
);

console.log(
	fail === 0
		? `✓ all ${pass} branding-status-perms checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
