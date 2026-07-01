/**
 * upgrade-mirror-smoke (beta5).
 *
 * Covers the new mirror-fallback + source-independent integrity logic in
 * `morphit-ops upgrade`:
 *
 *   - parseReleaseSources: primary-first, dedup, `host` vs `host/owner/repo`.
 *   - selectReleaseAssets: tarball + sha256 + optional `.asc`.
 *   - decideTrust: the SECURITY-critical matrix — a verified signature
 *     trusts any byte source; otherwise the hash must come from the
 *     trusted primary; otherwise REFUSE (mirror-only, unsigned).
 *   - verifyDetachedSignature: a REAL gpg round-trip with a throwaway
 *     key (skipped if gpg isn't installed) — proves the verify path
 *     accepts a good signature from a shipped key and rejects a forgery.
 *
 * The live release fetch against git.agorise.net is NOT exercised here
 * (network-restricted); the orchestration around these pieces is what
 * ships, and these are the parts where a mistake would be dangerous.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	parseReleaseSources,
	selectReleaseAssets,
	decideTrust,
	verifyDetachedSignature
} from '../src/commands/upgrade.ts';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};
const expect = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d));

const asset = (name: string) => ({ name, browser_download_url: `https://h/${name}`, size: 1 });

// ── parseReleaseSources ─────────────────────────────────────────────
{
	const only = parseReleaseSources('git.agorise.net', 'agorise/morphit', undefined);
	expect('sources: primary only when no mirrors', only.length === 1 && only[0]!.isPrimary === true);

	const withM = parseReleaseSources('git.agorise.net', 'agorise/morphit', 'mirror.example, codeberg.org/agorise/morphit');
	expect('sources: primary first', withM[0]!.isPrimary === true && withM[0]!.host === 'git.agorise.net');
	expect('sources: bare host reuses primary repo', withM[1]!.host === 'mirror.example' && withM[1]!.repo === 'agorise/morphit');
	expect('sources: host/owner/repo parsed', withM[2]!.host === 'codeberg.org' && withM[2]!.repo === 'agorise/morphit');
	expect('sources: mirrors not flagged primary', withM[1]!.isPrimary === false && withM[2]!.isPrimary === false);

	const dup = parseReleaseSources('git.agorise.net', 'agorise/morphit', 'git.agorise.net/agorise/morphit, https://mirror.example/, mirror.example');
	expect('sources: dedup primary + dedup mirror + strip scheme/trailing-slash', dup.length === 2 && dup[1]!.host === 'mirror.example');
}

// ── selectReleaseAssets ─────────────────────────────────────────────
{
	const full = selectReleaseAssets([asset('morphit-v1.tar.gz'), asset('morphit-v1.tar.gz.sha256'), asset('morphit-v1.tar.gz.asc'), asset('notes.txt')]);
	expect('assets: picks tarball+sha+sig', !!full && full.tarball.name.endsWith('.tar.gz') && full.sha.name.endsWith('.sha256') && full.sig?.name.endsWith('.asc') === true);

	const noSig = selectReleaseAssets([asset('morphit-v1.tar.gz'), asset('morphit-v1.tar.gz.sha256')]);
	expect('assets: sig optional (null when absent)', !!noSig && noSig.sig === null);

	const noSha = selectReleaseAssets([asset('morphit-v1.tar.gz')]);
	expect('assets: null when sha missing', noSha === null);
}

// ── decideTrust (security matrix) ───────────────────────────────────
expect(
	'trust: verified signature trusts ANY source (mirror bytes ok)',
	decideTrust({ bytesFromPrimary: false, sigVerified: true, hashMatched: false, hashFromPrimary: false }).allowed === true
);
expect(
	'trust: primary HTTPS + hash match → allowed',
	(() => {
		const t = decideTrust({ bytesFromPrimary: true, sigVerified: false, hashMatched: true, hashFromPrimary: true });
		return t.allowed && t.proof === 'primary-https-hash';
	})()
);
expect(
	'trust: mirror bytes + primary-anchored hash → allowed',
	(() => {
		const t = decideTrust({ bytesFromPrimary: false, sigVerified: false, hashMatched: true, hashFromPrimary: true });
		return t.allowed && t.proof === 'primary-anchored-hash';
	})()
);
expect(
	'trust: REFUSE when unsigned + no primary anchor (mirror-only)',
	decideTrust({ bytesFromPrimary: false, sigVerified: false, hashMatched: false, hashFromPrimary: false }).allowed === false
);
expect(
	'trust: REFUSE even if hash "matched" but NOT from primary (mirror self-checksum)',
	decideTrust({ bytesFromPrimary: false, sigVerified: false, hashMatched: true, hashFromPrimary: false }).allowed === false
);

// ── verifyDetachedSignature: real gpg round-trip (gated) ────────────
const haveGpg = spawnSync('which', ['gpg'], { stdio: 'pipe' }).status === 0;
if (!haveGpg) {
	console.log('  \u26a0 gpg not installed — skipping signature round-trip (logic above still covered)');
} else {
	const work = mkdtempSync(join(tmpdir(), 'morphit-sig-test-'));
	const gnupg = join(work, 'gnupg');
	mkdirSync(gnupg, { recursive: true });
	spawnSync('chmod', ['700', gnupg], { stdio: 'ignore' });
	const env = { ...process.env, GNUPGHOME: gnupg };
	try {
		// 1. Generate a throwaway signing key.
		spawnSync('gpg', ['--homedir', gnupg, '--batch', '--passphrase', '', '--quick-generate-key', 'Morphit Test Signer <test@morphit.invalid>', 'default', 'default', 'never'], { stdio: 'pipe', env, timeout: 30000 });
		// 2. Export its PUBLIC key into a fake install's release-signers dir.
		const installDir = join(work, 'install');
		const signers = join(installDir, '.forgejo', 'release-signers');
		mkdirSync(signers, { recursive: true });
		const pub = spawnSync('gpg', ['--homedir', gnupg, '--armor', '--export', 'test@morphit.invalid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
		writeFileSync(join(signers, 'test-signer.asc'), pub.stdout as string);
		// 3. Create a "tarball" + detached signature.
		const tarball = join(work, 'morphit-vtest.tar.gz');
		writeFileSync(tarball, Buffer.from('pretend tarball bytes'));
		spawnSync('gpg', ['--homedir', gnupg, '--batch', '--yes', '--armor', '--detach-sign', '--output', `${tarball}.asc`, tarball], { stdio: 'pipe', env, timeout: 20000 });

		// 4. GOOD signature → verifyDetachedSignature returns true.
		const good = verifyDetachedSignature(installDir, tarball, `${tarball}.asc`);
		expect('gpg: valid signature from a shipped key verifies', good === true);

		// 5. Tamper the tarball → signature must FAIL.
		writeFileSync(tarball, Buffer.from('tampered tarball bytes'));
		const tampered = verifyDetachedSignature(installDir, tarball, `${tarball}.asc`);
		expect('gpg: tampered tarball fails verification', tampered === false);

		// 6. Signature by a key NOT shipped → must FAIL (empty signers dir).
		const emptyInstall = join(work, 'empty-install');
		mkdirSync(join(emptyInstall, '.forgejo', 'release-signers'), { recursive: true });
		writeFileSync(tarball, Buffer.from('pretend tarball bytes')); // restore original so sig is otherwise valid
		const unknownSigner = verifyDetachedSignature(emptyInstall, tarball, `${tarball}.asc`);
		expect('gpg: signature from a non-shipped key is rejected', unknownSigner === false);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-mirror smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-mirror scenarios passed`);
