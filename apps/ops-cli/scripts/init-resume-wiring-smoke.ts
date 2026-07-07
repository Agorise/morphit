/**
 * init-resume-wiring-smoke.
 *
 * Static guards on how the save-as-you-go resume feature is wired into the
 * init.ts orchestrator.  These assert BEHAVIOURAL invariants the type
 * system does not enforce — above all the safety-critical one:
 *
 *   the two SECRET steps (database connection, active key) are called
 *   BARE and are NEVER routed through `recall(...)`, so they are always
 *   re-asked and never persisted to the progress file.
 *
 * Plus: the resume offer exists, non-secret steps ARE recalled, progress
 * is saved (via recall), and the progress file is cleared on success.
 *
 * The interactive flow itself runs on a real TTY; init-progress-smoke
 * covers the persistence core.  This smoke guards the integration so a
 * future refactor can't silently start saving a secret or drop cleanup.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const initSrc = readFileSync(join(here, '../src/commands/init.ts'), 'utf8');

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, msg = ''): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}${msg ? ` — ${msg}` : ''}`);
	}
}

// ─── Resume offer + recall plumbing present ──────────────────────────
expect('imports the progress module', initSrc.includes("from '../init/progress.ts'"));
expect('loads saved progress (offers resume)', initSrc.includes('loadProgress()'));
expect('shows a resume prompt', initSrc.includes('Resume from your saved answers'));
expect('defines the recall wrapper', /async function recall</.test(initSrc));
expect('saves progress from within recall', initSrc.includes('saveProgress(progress)'));

// non-secret steps ARE routed through recall (spot-check a representative few)
for (const key of ['instanceName', 'relayAccount', 'origin', 'bunkerWeb', 'hardening', 'disabledAssets']) {
	expect(`non-secret step recalled: ${key}`, initSrc.includes(`recall('${key}'`));
}

// ─── SAFETY-CRITICAL: secret steps are BARE, never saved ─────────────
expect(
	'databaseUrl step is called bare (await stepDatabase())',
	initSrc.includes('const databaseUrl = await stepDatabase();')
);
expect(
	'activeKey step is called bare (await stepActiveKey(',
	initSrc.includes('const activeKey = await stepActiveKey(')
);
// The two secrets are deliberately NOT keys of WizardProgress (the type
// already forbids recall'ing them); assert the source never tries anyway.
expect("databaseUrl is NEVER recalled", !initSrc.includes("recall('databaseUrl'"), 'SECRET would be persisted');
expect("activeKey is NEVER recalled", !initSrc.includes("recall('activeKey'"), 'SECRET would be persisted');
expect("torOnion is NEVER recalled", !initSrc.includes("recall('torOnion'"), 'HS SECRET KEY would be persisted');
// And the secret steps are not hidden inside a recall closure either.
expect(
	'stepDatabase() is not inside a recall closure',
	!initSrc.includes('=> stepDatabase()'),
	'SECRET step wrapped — it would be saved'
);
expect(
	'stepActiveKey() is not inside a recall closure',
	!initSrc.includes('=> stepActiveKey('),
	'SECRET step wrapped — it would be saved'
);
// On resume the operator is reminded why the secrets are re-asked.
expect('secret re-ask note is wired', initSrc.includes('secretResumeNote('));

// ─── Cleanup: resume file removed once setup completes ───────────────
expect('clears the progress file (clearProgress wired)', initSrc.includes('clearProgress()'));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 init-resume-wiring smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} init-resume-wiring checks passed`);
