/**
 * upgrade-mirror-smoke (beta5).
 *
 * Covers the new mirror-fallback + source-independent integrity logic in
 * `morphit-ops upgrade`:
 *
 *   - parseReleaseSources: primary-first, dedup, `host` vs `host/owner/repo`.
 *   - selectReleaseAssets: tarball + sha256 + optional `.asc`.
 *   - integrityGate: the SECURITY-critical matrix — a pinned signature or
 *     @morphit's signed on-chain hash makes a tarball installable; the
 *     primary's .sha256 alone never does; any known hash must match.
 *   - verifyDetachedSignature: a REAL gpg round-trip with a throwaway
 *     key (skipped if gpg isn't installed) — proves the verify path
 *     accepts a good signature from a PINNED key and rejects a forgery and
 *     a good signature from a key that is shipped but not pinned.
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
	integrityGate,
	verifyDetachedSignature,
	resolveOfflineTarball,
	parseTagFromTarballName,
	findLocalOfflineRelease,
	compareTags,
	stripInheritedNpmOffline
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
	expect(
		'sources: canonical primary is first + flagged primary',
		def[0]!.isPrimary === true && def[0]!.host === 'git.agorise.net'
	);
	expect(
		'sources: built-in codeberg mirror present by default',
		def.some((s) => s.host === 'codeberg.org' && s.repo === 'agorise/morphit' && !s.isPrimary)
	);
	expect(
		'sources: built-in gitea.com mirror present by default',
		def.some((s) => s.host === 'gitea.com' && s.repo === 'agorise/morphit' && !s.isPrimary)
	);
	expect('sources: exactly primary + 2 built-ins when no env mirrors', def.length === 3);

	// A NON-canonical primary (fork/custom) gets NO built-ins — it points its own.
	const fork = parseReleaseSources('git.myfork.net', 'me/morphit', undefined);
	expect(
		'sources: custom primary gets no built-in mirrors',
		fork.length === 1 && fork[0]!.isPrimary === true
	);

	// Env mirrors are ADDED (after primary + built-ins); bare host reuses primary
	// repo, host/owner/repo is parsed, and none are flagged primary.
	const withM = parseReleaseSources(
		'git.agorise.net',
		'agorise/morphit',
		'mirror.example, other.example/them/repo'
	);
	expect(
		'sources: primary still first',
		withM[0]!.isPrimary === true && withM[0]!.host === 'git.agorise.net'
	);
	expect(
		'sources: env bare host reuses primary repo',
		withM.some((s) => s.host === 'mirror.example' && s.repo === 'agorise/morphit' && !s.isPrimary)
	);
	expect(
		'sources: env host/owner/repo parsed',
		withM.some((s) => s.host === 'other.example' && s.repo === 'them/repo' && !s.isPrimary)
	);
	expect(
		'sources: env mirrors not flagged primary',
		withM
			.filter((s) => s.host === 'mirror.example' || s.host === 'other.example')
			.every((s) => !s.isPrimary)
	);

	// Dedup across primary + built-ins + env (scheme/trailing-slash stripped): a repeat
	// of the primary and of a built-in are dropped; mirror.example appears once.
	const dup = parseReleaseSources(
		'git.agorise.net',
		'agorise/morphit',
		'git.agorise.net/agorise/morphit, codeberg.org/agorise/morphit, https://mirror.example/, mirror.example'
	);
	expect(
		'sources: dedup primary + dedup built-in + dedup mirror + strip scheme/slash',
		dup.filter((s) => s.host === 'git.agorise.net').length === 1 &&
			dup.filter((s) => s.host === 'codeberg.org').length === 1 &&
			dup.filter((s) => s.host === 'mirror.example').length === 1
	);
}

// ── selectReleaseAssets ─────────────────────────────────────────────
{
	const full = selectReleaseAssets([
		asset('morphit-v1.tar.gz'),
		asset('morphit-v1.tar.gz.sha256'),
		asset('morphit-v1.tar.gz.asc'),
		asset('notes.txt')
	]);
	expect(
		'assets: picks tarball+sha+sig',
		!!full &&
			full.tarball.name.endsWith('.tar.gz') &&
			full.sha.name.endsWith('.sha256') &&
			full.sig?.name.endsWith('.asc') === true
	);

	const noSig = selectReleaseAssets([
		asset('morphit-v1.tar.gz'),
		asset('morphit-v1.tar.gz.sha256')
	]);
	expect('assets: sig optional (null when absent)', !!noSig && noSig.sig === null);

	const noSha = selectReleaseAssets([asset('morphit-v1.tar.gz')]);
	expect('assets: null when sha missing', noSha === null);

	// a 1.10.1+ release ships BOTH the slim tarball AND the -offline
	// bundle (each with its own .sha256/.asc). An online upgrade must pick the
	// SLIM tarball and the SLIM tarball's .sha256 — NOT cross them (that caused a
	// false "SHA-256 mismatch" on a mirror fallback). Order the -offline assets
	// FIRST to prove selection isn't just "first .tar.gz".
	const both = selectReleaseAssets([
		asset('morphit-v1.10.2-offline.tar.gz'),
		asset('morphit-v1.10.2-offline.tar.gz.sha256'),
		asset('morphit-v1.10.2-offline.tar.gz.asc'),
		asset('morphit-v1.10.2.tar.gz'),
		asset('morphit-v1.10.2.tar.gz.sha256'),
		asset('morphit-v1.10.2.tar.gz.asc')
	]);
	expect(
		'assets: prefers the SLIM tarball when -offline is also present',
		both?.tarball.name === 'morphit-v1.10.2.tar.gz'
	);
	expect(
		'assets: pairs the SLIM tarball with its OWN .sha256 (not the offline one)',
		both?.sha.name === 'morphit-v1.10.2.tar.gz.sha256'
	);
	expect(
		'assets: pairs the SLIM tarball with its OWN .asc',
		both?.sig?.name === 'morphit-v1.10.2.tar.gz.asc'
	);

	// the synthetic --from-file release has ONLY the -offline tarball → must still
	// select it (fallback), paired with ITS matching .sha256.
	const offlineOnly = selectReleaseAssets([
		asset('morphit-v1.10.2-offline.tar.gz'),
		asset('morphit-v1.10.2-offline.tar.gz.sha256')
	]);
	expect(
		'assets: falls back to -offline when it is the only tarball',
		offlineOnly?.tarball.name === 'morphit-v1.10.2-offline.tar.gz' &&
			offlineOnly?.sha.name === 'morphit-v1.10.2-offline.tar.gz.sha256'
	);
}

// ── integrityGate (security matrix) ─────────────────────────────────
{
	const H = 'a'.repeat(64);
	const g = (o: Partial<Parameters<typeof integrityGate>[0]>) =>
		integrityGate({
			signature: 'absent',
			chainHash: null,
			primaryHash: null,
			actualHash: H,
			hidden: null,
			...o
		});
	expect(
		'trust: pinned signature trusts ANY source (mirror bytes ok)',
		g({ signature: 'valid' }).proof === 'gpg-signature'
	);
	expect(
		'trust: signed on-chain hash match → allowed',
		g({ chainHash: H }).proof === 'onchain-anchored-sha256'
	);
	expect(
		'trust: REFUSE an unsigned tarball the primary alone vouches for',
		g({ primaryHash: H }).allowed === false
	);
	expect('trust: REFUSE when unsigned + no anchor (mirror-only)', g({}).allowed === false);
	expect(
		'trust: REFUSE when chain and primary disagree',
		g({ chainHash: H, primaryHash: 'b'.repeat(64) }).allowed === false
	);
	expect(
		'trust: a valid signature does not override a chain mismatch',
		g({ signature: 'valid', chainHash: 'b'.repeat(64) }).allowed === false
	);
}

// ── verifyDetachedSignature: real gpg round-trip (gated) ────────────
const haveGpg = spawnSync('which', ['gpg'], { stdio: 'pipe' }).status === 0;
if (!haveGpg) {
	console.log(
		'  \u26a0 gpg not installed — skipping signature round-trip (logic above still covered)'
	);
} else {
	const work = mkdtempSync(join(tmpdir(), 'morphit-sig-test-'));
	const gnupg = join(work, 'gnupg');
	mkdirSync(gnupg, { recursive: true });
	spawnSync('chmod', ['700', gnupg], { stdio: 'ignore' });
	const env = { ...process.env, GNUPGHOME: gnupg };
	try {
		// 1. Generate a throwaway signing key.
		spawnSync(
			'gpg',
			[
				'--homedir',
				gnupg,
				'--batch',
				'--passphrase',
				'',
				'--quick-generate-key',
				'Morphit Test Signer <test@morphit.invalid>',
				'default',
				'default',
				'never'
			],
			{ stdio: 'pipe', env, timeout: 30000 }
		);
		// 2. Export its PUBLIC key into a fake install's release-signers dir.
		const installDir = join(work, 'install');
		const signers = join(installDir, '.forgejo', 'release-signers');
		mkdirSync(signers, { recursive: true });
		const pub = spawnSync(
			'gpg',
			['--homedir', gnupg, '--armor', '--export', 'test@morphit.invalid'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }
		);
		writeFileSync(join(signers, 'test-signer.asc'), pub.stdout as string);
		// 3. Create a "tarball" + detached signature.
		const tarball = join(work, 'morphit-vtest.tar.gz');
		writeFileSync(tarball, Buffer.from('pretend tarball bytes'));
		spawnSync(
			'gpg',
			[
				'--homedir',
				gnupg,
				'--batch',
				'--yes',
				'--armor',
				'--detach-sign',
				'--output',
				`${tarball}.asc`,
				tarball
			],
			{ stdio: 'pipe', env, timeout: 20000 }
		);

		const fpr =
			/^fpr:+([0-9A-F]{40}):/m.exec(
				spawnSync('gpg', ['--homedir', gnupg, '--with-colons', '--list-keys'], {
					encoding: 'utf8',
					env
				}).stdout ?? ''
			)?.[1] ?? '';
		// 4. GOOD signature from a PINNED key → true; the same key shipped but
		//    not pinned → false.
		const good = verifyDetachedSignature(installDir, tarball, `${tarball}.asc`, [fpr]);
		expect('gpg: valid signature from a pinned key verifies', good === true);
		const unpinned = verifyDetachedSignature(installDir, tarball, `${tarball}.asc`);
		expect('gpg: a good signature from a shipped but unpinned key is rejected', unpinned === false);

		// 5. Tamper the tarball → signature must FAIL.
		writeFileSync(tarball, Buffer.from('tampered tarball bytes'));
		const tampered = verifyDetachedSignature(installDir, tarball, `${tarball}.asc`, [fpr]);
		expect('gpg: tampered tarball fails verification', tampered === false);

		// 6. Signature by a key NOT shipped → must FAIL (empty signers dir).
		const emptyInstall = join(work, 'empty-install');
		mkdirSync(join(emptyInstall, '.forgejo', 'release-signers'), { recursive: true });
		writeFileSync(tarball, Buffer.from('pretend tarball bytes')); // restore original so sig is otherwise valid
		const unknownSigner = verifyDetachedSignature(emptyInstall, tarball, `${tarball}.asc`, [fpr]);
		expect('gpg: signature from a non-shipped key is rejected', unknownSigner === false);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// ── offline upgrade (--from-file / MORPHIT_UPGRADE_TARBALL, cable unplugged) ──
// The offline path bypasses ALL release-host discovery + download and reuses
// the SAME trust matrix above (the signed on-chain record, read through the
// node's own indexer, or a pinned signature). These checks pin the offline
// PLUMBING.
{
	// parseTagFromTarballName — version parsed from the filename
	expect(
		'parses vX.Y.Z from an -offline tarball name',
		parseTagFromTarballName('morphit-v1.10.0-offline.tar.gz') === 'v1.10.0'
	);
	expect(
		'parses vX.Y.Z from a plain release tarball name',
		parseTagFromTarballName('morphit-v1.9.6.tar.gz') === 'v1.9.6'
	);
	expect(
		'returns null when no version is present',
		parseTagFromTarballName('morphit-latest.tar.gz') === null
	);

	// resolveOfflineTarball — null when neither flag nor env is set (online path)
	const savedEnv = process.env.MORPHIT_UPGRADE_TARBALL;
	delete process.env.MORPHIT_UPGRADE_TARBALL;
	expect(
		'resolveOfflineTarball is null on the normal (online) path',
		resolveOfflineTarball({}) === null
	);

	// resolveOfflineTarball — resolves a real local tarball + sibling .asc + tag
	const off = mkdtempSync(join(tmpdir(), 'morphit-offline-'));
	try {
		const tb = join(off, 'morphit-v1.10.0-offline.tar.gz');
		writeFileSync(tb, Buffer.from('pretend tarball'));
		let r = resolveOfflineTarball({ 'from-file': tb });
		expect(
			'resolveOfflineTarball resolves path + tag',
			r !== null && r.tag === 'v1.10.0' && r.tarballPath === tb
		);
		expect(
			'resolveOfflineTarball reports no sig when .asc absent',
			r !== null && r.sigPath === null
		);
		writeFileSync(`${tb}.asc`, Buffer.from('pretend sig'));
		r = resolveOfflineTarball({ 'from-file': tb });
		expect('resolveOfflineTarball finds a sibling .asc', r !== null && r.sigPath === `${tb}.asc`);

		// env var is honoured too
		process.env.MORPHIT_UPGRADE_TARBALL = tb;
		expect('MORPHIT_UPGRADE_TARBALL env is honoured', resolveOfflineTarball({}) !== null);
		delete process.env.MORPHIT_UPGRADE_TARBALL;

		// bad inputs throw (missing file / wrong ext / no version)
		let threw = false;
		try {
			resolveOfflineTarball({ 'from-file': join(off, 'nope.tar.gz') });
		} catch {
			threw = true;
		}
		expect('throws on a missing file', threw);
		threw = false;
		try {
			resolveOfflineTarball({ 'from-file': tb.replace('.tar.gz', '.zip') });
		} catch {
			threw = true;
		}
		expect('throws on a non-.tar.gz path', threw);
		const noVer = join(off, 'morphit-latest.tar.gz');
		writeFileSync(noVer, Buffer.from('x'));
		threw = false;
		try {
			resolveOfflineTarball({ 'from-file': noVer });
		} catch {
			threw = true;
		}
		expect('throws when the filename has no version', threw);
	} finally {
		rmSync(off, { recursive: true, force: true });
		if (savedEnv !== undefined) process.env.MORPHIT_UPGRADE_TARBALL = savedEnv;
	}

	// static: the offline branch must not download, and the rebuild must skip
	// npm ci on the prebuilt-bundle marker (so it is genuinely cable-unplugged)
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '../src/commands/upgrade.ts'),
		'utf8'
	);
	expect(
		'rebuild skips npm ci when .morphit-bundle-complete is present',
		/\.morphit-bundle-complete[\s\S]{0,400}?(?:skipping npm ci|nothing to download)/.test(src)
	);
	expect(
		'offline branch copies the local tarball instead of downloading',
		/offline !== null[\s\S]{0,600}?copyFileSync\(offline\.tarballPath/.test(src)
	);

	// ── drop-dir detection + online→offline fallback ──
	// compareTags: newest wins, release beats prerelease of the same X.Y.Z
	expect('compareTags: v1.10.1 newer than v1.10.0', compareTags('v1.10.1', 'v1.10.0') > 0);
	expect('compareTags: release beats its prerelease', compareTags('v1.10.0', 'v1.10.0-beta.1') > 0);
	expect('compareTags: equal tags compare 0', compareTags('v1.10.0', 'v1.10.0') === 0);

	// findLocalOfflineRelease scans MORPHIT_OFFLINE_RELEASE_DIR; the .asc is optional
	// (an unsigned bundle is checked against the signed on-chain offline_sha256)
	const drop = mkdtempSync(join(tmpdir(), 'morphit-drop-'));
	const savedDir = process.env.MORPHIT_OFFLINE_RELEASE_DIR;
	try {
		process.env.MORPHIT_OFFLINE_RELEASE_DIR = drop;
		expect(
			'findLocalOfflineRelease: empty dir → null',
			findLocalOfflineRelease('/opt/morphit') === null
		);
		// an UNSIGNED bundle is found, with no signature path
		writeFileSync(join(drop, 'morphit-v1.10.0-offline.tar.gz'), Buffer.from('x'));
		let f = findLocalOfflineRelease('/opt/morphit');
		expect(
			'findLocalOfflineRelease: unsigned bundle found (sigPath null)',
			f !== null && f.tag === 'v1.10.0' && f.sigPath === null
		);
		// its .asc is picked up when present
		writeFileSync(join(drop, 'morphit-v1.10.0-offline.tar.gz.asc'), Buffer.from('sig'));
		f = findLocalOfflineRelease('/opt/morphit');
		expect('findLocalOfflineRelease: sibling .asc found', f !== null && f.sigPath !== null);
		// a NEWER signed tarball wins
		writeFileSync(join(drop, 'morphit-v1.10.1-offline.tar.gz'), Buffer.from('x'));
		writeFileSync(join(drop, 'morphit-v1.10.1-offline.tar.gz.asc'), Buffer.from('sig'));
		f = findLocalOfflineRelease('/opt/morphit');
		expect(
			'findLocalOfflineRelease: newest signed tarball wins',
			f !== null && f.tag === 'v1.10.1'
		);
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
// ── strip an inherited npm offline flag before spawning child npm ──
// Regression for the morphitlat ENOTCACHED failure: the ansible launcher runs
// the CLI via `npm exec --offline`, exporting npm_config_offline=true, which
// forced the upgrade's `npm ci` cache-only and broke every online upgrade that
// pulled a dependency not already cached. runUpgrade now strips it.
{
	const env: Record<string, string | undefined> = {
		npm_config_offline: 'true',
		npm_config_prefer_offline: 'true',
		NPM_CONFIG_OFFLINE: 'true',
		NPM_CONFIG_PREFER_OFFLINE: 'true',
		PATH: '/usr/bin',
		npm_config_cache: '/var/cache/npm'
	};
	const cleared = stripInheritedNpmOffline(env as NodeJS.ProcessEnv);
	expect(
		'cp674: all four offline flag variants are stripped',
		env.npm_config_offline === undefined &&
			env.npm_config_prefer_offline === undefined &&
			env.NPM_CONFIG_OFFLINE === undefined &&
			env.NPM_CONFIG_PREFER_OFFLINE === undefined
	);
	expect('cp674: it reports the keys it cleared', cleared.length === 4);
	expect(
		'cp674: unrelated env (PATH, npm cache) is preserved',
		env.PATH === '/usr/bin' && env.npm_config_cache === '/var/cache/npm'
	);
}
{
	const clean: Record<string, string | undefined> = { PATH: '/usr/bin' };
	const cleared = stripInheritedNpmOffline(clean as NodeJS.ProcessEnv);
	expect(
		'cp674: no-op when no offline flag is present',
		cleared.length === 0 && clean.PATH === '/usr/bin'
	);
}

// ── chdir to a stable dir before the rename-swap ──
// The launcher runs us with cwd inside the install dir; renaming it to the
// backup leaves a stale cwd, and every shell spawned afterward prints
// "getcwd: cannot access parent directories" — harmless but trust-eroding.
// runUpgrade must chdir('/') BEFORE renameSync(installDir, backupDir).
{
	const src = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
	const chdirIdx = src.indexOf("process.chdir('/')");
	const renameIdx = src.indexOf('renameSync(installDir, backupDir)');
	expect(
		'cp685: upgrade chdirs to a stable dir before the rename-swap',
		chdirIdx !== -1 && renameIdx !== -1 && chdirIdx < renameIdx
	);
}

// ── a clean, trust-preserving upgrade output ──
// quiet npm's unactionable "deprecated" warnings during the upgrade.
// raise the frontend build's chunk-size warning limit for upgrades.
{
	const src = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
	expect('cp686: upgrade quiets npm to error loglevel', /npm_config_loglevel = 'error'/.test(src));
	expect(
		'cp687: upgrade sets MORPHIT_QUIET_BUILD for the frontend build',
		/MORPHIT_QUIET_BUILD = '1'/.test(src)
	);
	const vite = readFileSync(new URL('../../web/vite.config.js', import.meta.url), 'utf8');
	expect(
		'cp687: vite raises chunkSizeWarningLimit only under MORPHIT_QUIET_BUILD',
		/MORPHIT_QUIET_BUILD === '1'\s*\?\s*\d+\s*:\s*500/.test(vite)
	);
}

// ── retry served-frontend verify (container just restarted) ──
{
	const src = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
	expect(
		'cp688: served-frontend verify retries before giving up',
		/(?:servedVersion|\bv) === null && attempt < \d+/.test(src) &&
			/resolveServedVersion\(plan, webRoot\)/.test(src)
	);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-mirror smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-mirror scenarios passed`);
