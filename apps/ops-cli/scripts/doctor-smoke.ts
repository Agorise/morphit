/**
 * doctor-smoke (cp194)
 *
 * Guards the `morphit-ops doctor` command and the `--check-config`
 * contract it depends on. doctor is a READ-ONLY preflight that tells
 * an operator whether the indexer + relay will boot with the config
 * on disk — so the things that must never regress are:
 *
 *   1. `tsx apps/indexer/src/main.ts --check-config` exits 0 on a
 *      valid config and 1 (printing the validation error) on a bad
 *      one, WITHOUT touching the DB / opening a port.
 *   2. `tsx apps/relay/src/main.ts --check-config` does the same and
 *      NEVER prompts for a passphrase (it runs before unlockActiveKey),
 *      so doctor can't hang.
 *   3. doctor reports ✓ for a good install (exit 0) and ✗ with the
 *      offending lines for a bad one (exit 1) — including the two
 *      bug classes the first real operator hit: a missing required
 *      indexer var, and a non-allowlisted key in morphit.config.env.
 *
 * The check uses the SERVICES' real loaders (via spawn), so it can
 * never drift from what the services actually require — which is the
 * whole reason doctor is trustworthy.
 */

import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PLAINTEXT_WIF = '5J' + 'a'.repeat(50);

let passed = 0;
let failed = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	passed++;
};
const bad = (m: string, d = '') => {
	console.error(`  ✗ ${m}${d ? `\n      ${d}` : ''}`);
	failed++;
};

/** A complete, correct morphit.env for both services. */
function goodEnv(keyPath: string): string {
	return [
		'MORPHIT_INDEXER_DATABASE_URL=postgres://u:p@localhost:5432/morphit_indexer',
		'MORPHIT_INDEXER_RELAY_ACCOUNT=tester',
		'MORPHIT_INDEXER_FEE_RECIPIENT=tester',
		'MORPHIT_INDEXER_CHAIN_ID=cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.blurt.world',
		'MORPHIT_INDEXER_PUBLIC_ORIGIN=https://tester.example',
		'MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY=BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		'MORPHIT_RELAY_DATABASE_URL=postgres://u:p@localhost:5432/morphit_indexer',
		'MORPHIT_RELAY_ACCOUNT=tester',
		`MORPHIT_RELAY_ACTIVE_KEY_FILE=${keyPath}`,
		'MORPHIT_RELAY_BLURT_RPC=https://rpc.blurt.world',
		''
	].join('\n');
}

/** Build a throwaway install dir: symlinks to the real apps/
 *  node_modules/packages, a plaintext key (0600), and env files built
 *  for that key path. `buildEnv(keyPath)` returns the morphit.env body.
 *  Returns the dir. */
function makeInstall(
	buildEnv: (keyPath: string) => string,
	configEnvContent: string
): string {
	const dir = mkdtempSync(join(tmpdir(), 'doctor-smoke-'));
	symlinkSync(join(REPO, 'apps'), join(dir, 'apps'));
	symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
	symlinkSync(join(REPO, 'packages'), join(dir, 'packages'));
	const keyPath = join(dir, 'keystore.wif');
	writeFileSync(keyPath, PLAINTEXT_WIF);
	chmodSync(keyPath, 0o600);
	writeFileSync(join(dir, 'morphit.env'), buildEnv(keyPath));
	writeFileSync(join(dir, 'morphit.config.env'), configEnvContent);
	return dir;
}

function runDoctor(dir: string): { code: number; out: string } {
	// Strip any tsx/loader injection from the parent (this smoke runs
	// under tsx) so the spawned plain-`node` bundle starts cleanly.
	const childEnv = { ...process.env };
	delete childEnv.NODE_OPTIONS;
	delete (childEnv as Record<string, string | undefined>).TSX_TSCONFIG_PATH;
	const r = spawnSync('node', [join(REPO, 'apps', 'ops-cli', 'dist', 'main.js'), 'doctor', '--no-color'], {
		cwd: dir,
		env: childEnv,
		encoding: 'utf8',
		timeout: 90_000,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const created: string[] = [];
try {
	// Pre-req: the bundled CLI must exist (operators run `node
	// dist/main.js`, and run-smokes.sh does not build ops-cli first).
	// Build it here so this smoke is self-sufficient in CI, exactly as
	// compiled-bundle-smoke does.
	const bundlePath = join(REPO, 'apps', 'ops-cli', 'dist', 'main.js');
	{
		const b = spawnSync(process.execPath, [join(REPO, 'apps', 'ops-cli', 'scripts', 'build.mjs')], {
			cwd: join(REPO, 'apps', 'ops-cli'),
			encoding: 'utf8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		if (b.status === 0 && existsSync(bundlePath)) {
			ok('ops-cli bundle built (dist/main.js present)');
		} else {
			bad('could not build ops-cli bundle — doctor-smoke needs it', (b.stderr ?? '').slice(0, 300));
			throw new Error('bundle build failed');
		}
	}
	// ── Scenario 1: good install → both ✓, exit 0 ──────────────
	{
		const dir = makeInstall(goodEnv, '# operator-tunable\n');
		created.push(dir);
		const { code, out } = runDoctor(dir);
		if (code === 0 && /indexer: will start/.test(out) && /relay: will start/.test(out)) {
			ok('good install → both services validate (exit 0)');
		} else {
			bad('good install did not report both services OK', `exit=${code}\n${out.slice(0, 400)}`);
		}
		// the relay key-type note should appear (plaintext here)
		if (/active key: plaintext/.test(out)) ok('relay reports key type (plaintext) without decrypting');
		else bad('relay key-type note missing', out.slice(0, 300));
	}

	// ── Scenario 2: missing required indexer vars → indexer ✗ ──
	{
		const buildEnv = (keyPath: string) =>
			goodEnv(keyPath)
				.split('\n')
				.filter(
					(l) =>
						!l.startsWith('MORPHIT_INDEXER_PUBLIC_ORIGIN') &&
						!l.startsWith('MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY')
				)
				.join('\n');
		const dir = makeInstall(buildEnv, '# operator-tunable\n');
		created.push(dir);
		const { code, out } = runDoctor(dir);
		if (code === 1 && /indexer: will NOT start/.test(out) && /MORPHIT_INDEXER_PUBLIC_ORIGIN/.test(out)) {
			ok('missing required indexer vars → indexer flagged ✗ with the offending var (exit 1)');
		} else {
			bad('missing-required-vars not caught as expected', `exit=${code}\n${out.slice(0, 400)}`);
		}
	}

	// ── Scenario 3: non-allowlisted key in config.env → ✗ ──────
	{
		const dir = makeInstall(goodEnv, 'MORPHIT_RELAY_SIGNUP_DAILY_CEILING=50\n');
		created.push(dir);
		const { code, out } = runDoctor(dir);
		if (code === 1 && /allowlist/i.test(out)) {
			ok('non-allowlisted key in morphit.config.env → flagged with the allowlist error (exit 1)');
		} else {
			bad('allowlist violation not caught as expected', `exit=${code}\n${out.slice(0, 400)}`);
		}
	}

	// ── Scenario 4: not an install dir → exit 2, helpful message ─
	{
		const dir = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
		created.push(dir);
		const { code, out } = runDoctor(dir);
		if (code === 2 && /install directory/i.test(out)) {
			ok('non-install directory → exit 2 with guidance (no crash)');
		} else {
			bad('empty dir not handled as expected', `exit=${code}\n${out.slice(0, 300)}`);
		}
	}

	// ── Scenario 5 (static): doctor mutates nothing — assert the
	//    command source contains no write/spawn-start primitives that
	//    could change the box. It may spawn `npm start -- --check-config`
	//    (which exits), but must not run migrations, write files under
	//    the install, or start a long-lived server.
	{
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(join(REPO, 'apps/ops-cli/src/commands/doctor.ts'), 'utf8');
		const writeBad = /writeFileSync|mkdirSync|rmSync|unlinkSync|chmodSync|symlinkSync/.test(src);
		if (!writeBad) ok('doctor source performs no filesystem mutation (read-only)');
		else bad('doctor source contains a filesystem-mutating call — doctor must be read-only');
	}

	// ── Scenario 6: SECURITY — plaintext key → ⚠ warning ───────
	{
		const dir = makeInstall(goodEnv, '# operator-tunable\n');
		created.push(dir);
		// makeInstall writes a PLAINTEXT WIF (starts with '5'), 0600.
		const { code, out } = runDoctor(dir);
		if (code === 0 && /active key encryption/i.test(out) && /PLAINTEXT/i.test(out)) {
			ok('plaintext key → security warns (encryption advisory), boot still OK (exit 0)');
		} else {
			bad('plaintext-key security warning missing', `exit=${code}\n${out.slice(0, 400)}`);
		}
		// and it must NOT leak the key material
		if (!out.includes(PLAINTEXT_WIF)) ok('security check does not print key material');
		else bad('SECURITY: doctor output contained the key WIF — must never print key material');
	}

	// ── Scenario 7: SECURITY — encrypted key → ✓ ───────────────
	{
		const dir = makeInstall(goodEnv, '# operator-tunable\n');
		created.push(dir);
		// Overwrite the key file with an encrypted-envelope shape ('{' first).
		const { writeFileSync: wf, chmodSync: ch } = await import('node:fs');
		const keyPath = join(dir, 'keystore.wif');
		wf(keyPath, '{"v":1,"kdf":"scrypt","salt":"x","ct":"y"}');
		ch(keyPath, 0o600);
		const { code, out } = runDoctor(dir);
		if (code === 0 && /active key encryption[^\n]*encrypted envelope/i.test(out)) {
			ok('encrypted key → security reports ✓ (encrypted envelope)');
		} else {
			bad('encrypted-key security ✓ missing', `exit=${code}\n${out.slice(0, 400)}`);
		}
	}

	// ── Scenario 8: SECURITY — world-readable morphit.env → ⚠ ──
	{
		const dir = makeInstall(goodEnv, '# operator-tunable\n');
		created.push(dir);
		const { chmodSync: ch } = await import('node:fs');
		ch(join(dir, 'morphit.env'), 0o644);
		const { code, out } = runDoctor(dir);
		if (/morphit\.env permissions/i.test(out) && /0644|group\/other/i.test(out)) {
			ok('world-readable morphit.env → security warns about permissions');
		} else {
			bad('world-readable morphit.env warning missing', `exit=${code}\n${out.slice(0, 400)}`);
		}
	}
} finally {
	for (const d of created) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\ndoctor smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} doctor scenarios passed`);
