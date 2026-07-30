/**
 * save-secrets-smoke.ts (cp600) — pins the PURE pieces of saveSecrets.ts: the
 * "save these offline" block content + the typed-confirmation gate.  The
 * interactive prompt is Beelink/UX territory; the content + gate must stay
 * correct so the operator is actually told to vault their generated secrets
 * offline and can't reflex past it.
 */
import {
	formatSecretsToSave,
	isSavedConfirmation,
	type SecretToSave
} from '../apps/ops-cli/src/init/saveSecrets.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 save-secrets smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

const secrets: SecretToSave[] = [
	{ label: 'Database password (indexer)', value: 'AAA-indexer-secret-000', note: 'read-only marketplace data' },
	{ label: 'Database password (relay)', value: 'BBB-relay-secret-111' }
];
const block = formatSecretsToSave(secrets);

// ── content ───────────────────────────────────────────────────────
check('warns the secrets are shown only ONCE', /shown only ONCE/i.test(block) || /only ONCE/i.test(block));
check('shows every label AND its value', secrets.every((s) => block.includes(s.label) && block.includes(s.value)));
check('includes the optional note when present', block.includes('read-only marketplace data'));
check('tells them to use an OFFLINE password manager', /OFFLINE/.test(block));
check('names KeePass (and KeePassXC) as the concrete offline choice', /KeePass/.test(block) && /KeePassXC/.test(block));
check('warns against email / cloud', /email/i.test(block) && /cloud/i.test(block));
check('explains the stakes (access to the database)', /database/i.test(block));

// ── confirmation gate (typed word, not y/n) ───────────────────────
check('accepts "SAVED"', isSavedConfirmation('SAVED'));
check('accepts lower/mixed case + surrounding spaces', isSavedConfirmation('saved') && isSavedConfirmation('  SaVeD  '));
check('rejects "y" / "yes" (must be the explicit word)', !isSavedConfirmation('y') && !isSavedConfirmation('yes'));
check('rejects empty + arbitrary text', !isSavedConfirmation('') && !isSavedConfirmation('ok done'));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} save-secrets checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} save-secrets checks failed`);
	process.exit(1);
}
