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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	parseReleaseSources,
	selectReleaseAssets,
	decideTrust,
	verifyDetachedSignature,
	resolveOfflineTarball,
	parseTagFromTarballName,
	findLocalOfflineRelease,
	compareTags
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
	// The canonical primary gets the 2 built-in mirrors (codeberg.org + gitea.com)
	// gitea.com) with NO env config, so `morphit-ops upgrade` auto-rotates off
	// git.agorise.net the moment it's unreachable.
	const def = parseReleaseSources('git.agorise.net', 'agorise/morphit', undefined);
	expect('sources: canonical primary is first + flagged primary', def[0]!.isPrimary === true && def[0]!.host === 'git.agorise.net');
	expect('sources: built-in codeberg mirror present by default', def.some((s) => s.host === 'codeberg.org' && s.repo === 'agorise/morphit' && !s.isPrimary));
	expect('sources: built-in gitea.com mirror present by default', def.some((s) => s.host === 'gitea.com' && s.repo === 'agorise/morphit' && !s.isPrimary));
	expect('sources: exactly primary + 2 built-ins when no env mirrors', def.length === 3);

	// A NON-canonical primary (fork/custom) gets NO built-ins — it points its own.
	const fork = parseReleaseSources('git.myfork.net', 'me/morphit', undefined);
	expect('sources: custom primary gets no built-in mirrors', fork.length === 1 && fork[0]!.isPrimary === true);

	// Env mirrors are ADDED (after primary + built-ins); bare host reuses primary
	// repo, host/owner/repo is parsed, and none are flagged primary.
	const withM = parseReleaseSources('git.agorise.net', 'agorise/morphit', 'mirror.example, other.example/them/repo');
	expect('sources: primary still first', withM[0]!.isPrimary === true && withM[0]!.host === 'git.agorise.net');
	expect('sources: env bare host reuses primary repo', withM.some((s) => s.host === 'mirror.example' && s.repo === 'agorise/morphit' && !s.isPrimary));
	expect('sources: env host/owner/repo parsed', withM.some((s) => s.host === 'other.example' && s.repo === 'them/repo' && !s.isPrimary));
	expect('sources: env mirrors not flagged primary', withM.filter((s) => s.host === 'mirror.example' || s.host === 'other.example').every((s) => !s.isPrimary));

	// Dedup across primary + built-ins + env (scheme/trailing-slash stripped): a repeat
	// of the primary and of a built-in are dropped; mirror.example appears once.
	const dup = parseReleaseSources('git.agorise.net', 'agorise/morphit', 'git.agorise.net/agorise/morphit, codeberg.org/agorise/morphit, https://mirror.example/, mirror.example');
	expect('sources: dedup primary + dedup built-in + dedup mirror + strip scheme/slash', dup.filter((s) => s.host === 'git.agorise.net').length === 1 && dup.filter((s) => s.host === 'codeberg.org').length === 1 && dup.filter((s) => s.host === 'mirror.example').length === 1);
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

// ── offline upgrade (--from-file / MORPHIT_UPGRADE_TARBALL, cable unplugged) ──
// The offline path bypasses ALL network discovery + download and reuses the SAME
// trust matrix above: with no reachable primary there's no anchored hash, so
// decideTrust falls to the "sig or bust" cases already asserted — an UNSIGNED
// offline tarball is the "all false → refused" case, a SIGNED one is the
// "sigVerified → allowed" case. These checks pin the offline PLUMBING.
{
	// the offline-unsigned refusal is exactly the all-false decideTrust case
	expect(
		'offline unsigned tarball is refused (no primary hash, no signature)',
		decideTrust({ bytesFromPrimary: false, sigVerified: false, hashMatched: false, hashFromPrimary: false }).allowed === false
	);
	// a signed offline tarball is trusted regardless of byte source (local file)
	expect(
		'offline SIGNED tarball is trusted (gpg proof, any source)',
		decideTrust({ bytesFromPrimary: false, sigVerified: true, hashMatched: false, hashFromPrimary: false }).proof === 'gpg-signature'
	);

	// parseTagFromTarballName — version parsed from the filename
	expect('parses vX.Y.Z from an -offline tarball name', parseTagFromTarballName('morphit-v1.10.0-offline.tar.gz') === 'v1.10.0');
	expect('parses vX.Y.Z from a plain release tarball name', parseTagFromTarballName('morphit-v1.9.6.tar.gz') === 'v1.9.6');
	expect('returns null when no version is present', parseTagFromTarballName('morphit-latest.tar.gz') === null);

	// resolveOfflineTarball — null when neither flag nor env is set (online path)
	const savedEnv = process.env.MORPHIT_UPGRADE_TARBALL;
	delete process.env.MORPHIT_UPGRADE_TARBALL;
	expect('resolveOfflineTarball is null on the normal (online) path', resolveOfflineTarball({}) === null);

	// resolveOfflineTarball — resolves a real local tarball + sibling .asc + tag
	const off = mkdtempSync(join(tmpdir(), 'morphit-offline-'));
	try {
		const tb = join(off, 'morphit-v1.10.0-offline.tar.gz');
		writeFileSync(tb, Buffer.from('pretend tarball'));
		let r = resolveOfflineTarball({ 'from-file': tb });
		expect('resolveOfflineTarball resolves path + tag', r !== null && r.tag === 'v1.10.0' && r.tarballPath === tb);
		expect('resolveOfflineTarball reports no sig when .asc absent', r !== null && r.sigPath === null);
		writeFileSync(`${tb}.asc`, Buffer.from('pretend sig'));
		r = resolveOfflineTarball({ 'from-file': tb });
		expect('resolveOfflineTarball finds a sibling .asc', r !== null && r.sigPath === `${tb}.asc`);

		// env var is honoured too
		process.env.MORPHIT_UPGRADE_TARBALL = tb;
		expect('MORPHIT_UPGRADE_TARBALL env is honoured', resolveOfflineTarball({}) !== null);
		delete process.env.MORPHIT_UPGRADE_TARBALL;

		// bad inputs throw (missing file / wrong ext / no version)
		let threw = false;
		try { resolveOfflineTarball({ 'from-file': join(off, 'nope.tar.gz') }); } catch { threw = true; }
		expect('throws on a missing file', threw);
		threw = false;
		try { resolveOfflineTarball({ 'from-file': tb.replace('.tar.gz', '.zip') }); } catch { threw = true; }
		expect('throws on a non-.tar.gz path', threw);
		const noVer = join(off, 'morphit-latest.tar.gz');
		writeFileSync(noVer, Buffer.from('x'));
		threw = false;
		try { resolveOfflineTarball({ 'from-file': noVer }); } catch { threw = true; }
		expect('throws when the filename has no version', threw);
	} finally {
		rmSync(off, { recursive: true, force: true });
		if (savedEnv !== undefined) process.env.MORPHIT_UPGRADE_TARBALL = savedEnv;
	}

	// static: the offline branch must not download, and the rebuild must skip
	// npm ci on the prebuilt-bundle marker (so it is genuinely cable-unplugged)
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/commands/upgrade.ts'), 'utf8');
	expect('rebuild skips npm ci when .morphit-bundle-complete is present', /\.morphit-bundle-complete[\s\S]{0,400}?skipping npm ci/.test(src));
	expect('offline branch copies the local tarball instead of downloading', /offline !== null[\s\S]{0,600}?copyFileSync\(offline\.tarballPath/.test(src));

	// ── drop-dir detection + online→offline fallback (cp667) ──
	// compareTags: newest wins, release beats prerelease of the same X.Y.Z
	expect('compareTags: v1.10.1 newer than v1.10.0', compareTags('v1.10.1', 'v1.10.0') > 0);
	expect('compareTags: release beats its prerelease', compareTags('v1.10.0', 'v1.10.0-beta.1') > 0);
	expect('compareTags: equal tags compare 0', compareTags('v1.10.0', 'v1.10.0') === 0);

	// findLocalOfflineRelease scans MORPHIT_OFFLINE_RELEASE_DIR, needs a sibling .asc
	const drop = mkdtempSync(join(tmpdir(), 'morphit-drop-'));
	const savedDir = process.env.MORPHIT_OFFLINE_RELEASE_DIR;
	try {
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = drop;
		expect('findLocalOfflineRelease: empty dir → null', findLocalOfflineRelease('/opt/morphit') === null);
		// an UNSIGNED tarball is ignored (no .asc → not trustable offline)
		writeFileSync(join(drop, 'morphit-v1.10.0-offline.tar.gz'), Buffer.from('x'));
		expect('findLocalOfflineRelease: unsigned tarball ignored', findLocalOfflineRelease('/opt/morphit') === null);
		// sign it → now found
		writeFileSync(join(drop, 'morphit-v1.10.0-offline.tar.gz.asc'), Buffer.from('sig'));
		let f = findLocalOfflineRelease('/opt/morphit');
		expect('findLocalOfflineRelease: signed tarball found', f !== null && f.tag === 'v1.10.0');
		// a NEWER signed tarball wins
		writeFileSync(join(drop, 'morphit-v1.10.1-offline.tar.gz'), Buffer.from('x'));
		writeFileSync(join(drop, 'morphit-v1.10.1-offline.tar.gz.asc'), Buffer.from('sig'));
		f = findLocalOfflineRelease('/opt/morphit');
		expect('findLocalOfflineRelease: newest signed tarball wins', f !== null && f.tag === 'v1.10.1');
	} finally {
		rmSync(drop, { recursive: true, force: true });
		if (savedDir !== undefined) process.env.MORPHIT_OFFLINE_RELEASE_DIR = savedDir;
		else delete process.env.MORPHIT_OFFLINE_RELEASE_DIR;
	}

	// static: runUpgrade falls back to the drop-dir tarball when all sources fail
	expect(
		'runUpgrade falls back to a dropped offline tarball when the network is down',
		/latest === null[\s\S]{0,400}?findLocalOfflineRelease\(installDir\)/.test(src)
	);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-mirror smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-mirror scenarios passed`);
