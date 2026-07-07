/**
 * init-progress-smoke.
 *
 * Unit-tests the wizard "save-as-you-go" progress store (init/progress.ts):
 *   - round-trips the NON-SECRET answers,
 *   - the CRITICAL safety property: a private key / DB password can NEVER
 *     reach the progress file (type omits them AND saveProgress hard-strips
 *     them) — asserted by feeding an object that DOES carry secrets and
 *     proving none of that material lands on disk,
 *   - the file is written owner-only (no group/world access),
 *   - absent / corrupt / wrong-version files load as null,
 *   - clearProgress removes the file.
 *
 * The interactive resume PROMPT (offer / reuse / re-ask secrets) runs on a
 * real TTY and is not exercised here; this covers the persistence core it
 * relies on.
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the progress file at a throwaway HOME so we never touch a real
// operator's resume file.  progressFilePath() reads homedir() (which
// honours $HOME on POSIX) at call time, so setting this before any call
// is sufficient even with static imports.
process.env.HOME = mkdtempSync(join(tmpdir(), 'morphit-init-progress-'));

import {
	type WizardProgress,
	progressFilePath,
	saveProgress,
	loadProgress,
	loadProgressSavedAt,
	clearProgress,
	describeAge
} from '../src/init/progress.ts';

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

// A representative set of NON-SECRET answers (every field here is config,
// also written to the 0600 config file at the end anyway).
const sample: WizardProgress = {
	instanceName: 'morphit.io',
	tagline: 'free markets, no middleman',
	relayAccount: { name: 'morphit', account: null, chainLookupSucceeded: false },
	feesAccount: 'morphit-fees',
	dailyCeiling: 25,
	contactUrl: null,
	origin: 'https://morphit.io',
	bunkerWeb: { enabled: true },
	matrix: { alertMxid: '@agorise:matrix.org', groupRoomAlias: '#agorise:matrix.org' }
};

// 1 — absent file → null
clearProgress();
expect('loadProgress() is null when no file exists', loadProgress() === null);
expect('loadProgressSavedAt() is null when no file exists', loadProgressSavedAt() === null);

// 2 — round-trip
saveProgress(sample);
expect('progress file exists after save', existsSync(progressFilePath()));
{
	const back = loadProgress();
	let ok = false;
	try {
		assert.deepStrictEqual(back, sample);
		ok = true;
	} catch {
		ok = false;
	}
	expect('saveProgress + loadProgress round-trips the answers', ok);
	expect('loadProgressSavedAt() returns an ISO timestamp', !!loadProgressSavedAt());
}

// 3 — file is owner-only (no group/world bits)
{
	const mode = statSync(progressFilePath()).mode & 0o777;
	expect('progress file is owner-only (no group/world access)', (mode & 0o077) === 0, `mode=${mode.toString(8)}`);
}

// 4 — CRITICAL: secrets can NEVER reach the file.  Feed an object that DOES
// carry a DB password + a private key (cast past the type) and prove none
// of that material is written, and that load() returns it stripped.
{
	const withSecrets = {
		...sample,
		databaseUrl: 'postgres://dbuser:SUPERSECRETPW@localhost:5432/morphit',
		activeKey: {
			mode: 'plaintext',
			plaintextWif: '5JLEAKEDPRIVATEKEYdeadbeefdeadbeefdeadbeefdeadbeef',
			envelope: undefined,
			passphraseHint: 'my-secret-hint'
		},
		torOnion: {
			address: 'efjprum3peosirjsilqv6lvlns3476t3njpngaexsyhangeb3mjo7sad.onion',
			secretKeyFile: 'TORHSPRIVATEKEYMATERIALdeadbeef',
			publicKeyFile: 'pub',
			hostnameFile: 'host',
			publicKey: 'pk'
		}
	};
	saveProgress(withSecrets as unknown as WizardProgress);
	const raw = readFileSync(progressFilePath(), 'utf8');
	for (const needle of [
		'SUPERSECRETPW',
		'5JLEAKEDPRIVATEKEY',
		'databaseUrl',
		'activeKey',
		'plaintextWif',
		'envelope',
		'passphraseHint',
		'my-secret-hint',
		'torOnion',
		'TORHSPRIVATEKEYMATERIAL',
		'secretKeyFile'
	]) {
		expect(`secret-exclusion: "${needle}" is absent from the file`, !raw.includes(needle), 'SECRET LEAK');
	}
	const back = (loadProgress() ?? {}) as Record<string, unknown>;
	expect('loaded progress has no databaseUrl', !('databaseUrl' in back));
	expect('loaded progress has no activeKey', !('activeKey' in back));
	expect('loaded progress has no torOnion', !('torOnion' in back));
	// the non-secret fields survive
	expect('non-secret instanceName still present alongside stripped secrets', back.instanceName === 'morphit.io');
}

// 5 — corrupt / wrong-version files load as null (never throw)
{
	writeFileSync(progressFilePath(), 'this is not json {{{', { mode: 0o600 });
	expect('corrupt file loads as null', loadProgress() === null);
	writeFileSync(
		progressFilePath(),
		JSON.stringify({ version: 999, savedAt: new Date().toISOString(), answers: { instanceName: 'x' } }),
		{ mode: 0o600 }
	);
	expect('incompatible-version file loads as null', loadProgress() === null);
}

// 6 — clearProgress removes the file
clearProgress();
expect('clearProgress() removes the file', !existsSync(progressFilePath()));
expect('loadProgress() is null after clear', loadProgress() === null);

// 7 — describeAge sanity
expect('describeAge(null) is friendly', describeAge(null) === 'a previous run');
expect('describeAge(now) reads "just now"', describeAge(new Date().toISOString()) === 'just now');
{
	const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	expect('describeAge(10m ago) mentions minutes', /minute/.test(describeAge(tenMinAgo)));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 init-progress smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} init-progress checks passed`);
