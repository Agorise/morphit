/**
 * saveSecrets.ts (cp600) — show the operator the secrets Morphit GENERATED
 * during install (the database passwords, and anything else minted for them)
 * and make them stop and save them somewhere safe + OFFLINE before continuing.
 *
 * Why a hard stop: these are minted with full cryptographic entropy and shown
 * ONCE.  Morphit also writes them onto this machine, but a copy in an offline
 * password manager is the operator's safety net for recovery or moving the node
 * — and losing them can mean losing access to the node's database.
 */
import { ask } from './prompt.ts';

export interface SecretToSave {
	readonly label: string;
	readonly value: string;
	/** Optional one-line hint about what this secret is for. */
	readonly note?: string;
}

/** The word the operator must type to acknowledge they saved the secrets.
 *  Case-insensitive + trimmed.  A typed word (not y/n) is a deliberate speed
 *  bump so this can't be reflex-dismissed.  PURE. */
export function isSavedConfirmation(input: string): boolean {
	return input.trim().toLowerCase() === 'saved';
}

/** Render the "save these now" block.  PURE (no I/O) so it is unit-tested.
 *  Deliberately explicit: shown once, store OFFLINE in a password manager
 *  (e.g. KeePass), never email/cloud. */
export function formatSecretsToSave(secrets: readonly SecretToSave[]): string {
	const rule = '\u2550'.repeat(64);
	const lines: string[] = [];
	lines.push(rule);
	lines.push('  SAVE THESE NOW \u2014 they are shown only ONCE');
	lines.push(rule);
	lines.push('');
	lines.push('  Morphit generated these secrets for your node. They are stored on');
	lines.push('  this machine, but keep your OWN copy in case you ever need to');
	lines.push('  recover your node or move it to another computer.');
	lines.push('');
	for (const s of secrets) {
		lines.push(`  ${s.label}:`);
		lines.push(`      ${s.value}`);
		if (s.note !== undefined && s.note !== '') lines.push(`      (${s.note})`);
		lines.push('');
	}
	lines.push('  HOW TO SAVE THEM SAFELY:');
	lines.push('    \u2022 Put them in a password manager kept OFFLINE \u2014 KeePass or');
	lines.push('      KeePassXC is a free, offline choice that works everywhere.');
	lines.push('    \u2022 Do NOT email them to yourself, and do NOT store them in the cloud.');
	lines.push('    \u2022 Anyone who has these can reach your node\u2019s database.');
	lines.push('');
	lines.push(rule);
	return lines.join('\n');
}

/** Show the block, then block until the operator confirms they saved everything
 *  by typing the confirmation word.  Interactive; the pure helpers above are
 *  what the smoke pins.  `deps` is injectable for testing. */
export async function promptSaveSecrets(
	secrets: readonly SecretToSave[],
	deps: { print?: (s: string) => void; askFn?: typeof ask } = {}
): Promise<void> {
	if (secrets.length === 0) return;
	const print = deps.print ?? ((s: string): void => console.log(s));
	const askFn = deps.askFn ?? ask;
	print(formatSecretsToSave(secrets));
	while (true) {
		const ans = await askFn('Type SAVED once you have stored these somewhere safe and offline');
		if (isSavedConfirmation(ans)) return;
		print('  Please save the secrets above first, then type SAVED to continue.\n');
	}
}
