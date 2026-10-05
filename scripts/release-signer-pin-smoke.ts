/**
 * release-signer-pin-smoke.
 *
 * The release job trusted every `.asc` in the TAGGED tree's
 * `.forgejo/release-signers/`: a tag pusher could commit their own key there,
 * sign the tag with it, and CI would build and sign the tarball with the real
 * release key. The signing step handed the passphrase to gpg on its command
 * line.
 *
 * This EXECUTES the real step scripts from .forgejo/workflows/release.yml in a
 * scratch repository (with a bare "origin" holding main):
 *   - the tag-verification step(s) must refuse a tag signed by a key the tree
 *     ships but that is not pinned, and a pinned tag whose commit is not on
 *     main; and accept a pinned tag on main;
 *   - the signing step must refuse an unpinned key and sign with a pinned one;
 *     with no key it signs nothing and says so in its step output, and the
 *     anchor then names the pinned key that signed the tag;
 *   - the publish step must re-verify every signature the sign step made, and
 *     attach no .asc when it made none;
 * and it checks, from the parsed workflows, that the pin equals the one
 * installed nodes use (RELEASE_SIGNER_FINGERPRINTS), that no step passes a
 * passphrase on a command line, and that no step given a secret installs a
 * package.
 *
 * To watch it fail on the old workflow:
 *   MORPHIT_RELEASE_WORKFLOW=<old>/.forgejo/workflows/release.yml tsx scripts/release-signer-pin-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RELEASE_SIGNER_FINGERPRINTS } from '../packages/operator-config/src/trustAnchors.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WF =
	process.env.MORPHIT_RELEASE_WORKFLOW ?? join(REPO, '.forgejo', 'workflows', 'release.yml');

let pass = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(name);
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

interface Step {
	name?: string;
	run?: string;
	env?: Record<string, string>;
}
const wf = parseYaml(readFileSync(WF, 'utf8')) as {
	jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
};
const job = wf.jobs.release ?? Object.values(wf.jobs)[0]!;
const steps = job.steps;
// The tag gate: every step from the signer-key import up to and including the
// tag verification (the old workflow split it in two).
const gate = steps.filter(
	(s) => /^(Import authorized release-signer keys|Verify tag)/.test(s.name ?? '') && s.run
);
const signStep = steps.find((s) => (s.name ?? '').startsWith('Sign release tarball'));

// ── Parsed-workflow checks ──────────────────────────────────────────
const pinEnv = (job.env?.MORPHIT_RELEASE_SIGNERS ?? '')
	.split(/\s+/)
	.filter(Boolean)
	.map((f) => f.toUpperCase());
check(
	'the workflow pins the release signers the installed nodes trust',
	pinEnv.length > 0 &&
		pinEnv.join(' ') === [...RELEASE_SIGNER_FINGERPRINTS].map((f) => f.toUpperCase()).join(' '),
	`workflow: ${pinEnv.join(' ') || '(none)'}; operator-config: ${RELEASE_SIGNER_FINGERPRINTS.join(' ')}`
);
// The offline bundle is a release asset, not a best-effort extra: the private
// upgrade path of a zero-clearnet node depends on it and its signature.
const bundleIdx = steps.findIndex((s) => /build-offline-bundle\.sh/.test(s.run ?? ''));
const bundleStep = steps[bundleIdx] as (Step & { 'continue-on-error'?: unknown }) | undefined;
check(
	'the offline bundle is built before the signing step, and a failure fails the release',
	bundleStep !== undefined &&
		bundleStep['continue-on-error'] === undefined &&
		signStep !== undefined &&
		bundleIdx < steps.indexOf(signStep),
	bundleStep ? `step "${bundleStep.name}" at ${bundleIdx}` : 'no step builds it'
);
check(
	'the bundle is built without Docker (the release job runs in a container with no Docker)',
	/build-offline-bundle\.sh[^\n]*--without-docker/.test(bundleStep?.run ?? '')
);
const mirrorStep = steps.find((s) => (s.name ?? '').startsWith('Mirror the release'));
for (const [label, st] of [
	['the release', steps.find((s) => (s.name ?? '').startsWith('Publish Forgejo release'))],
	['the mirrors', mirrorStep]
] as const) {
	check(
		`${label} attach the offline bundle's .asc`,
		/(\$OFFLINE\.asc|offline\.tar\.gz\.asc)/.test(st?.run ?? '')
	);
}
for (const s of steps) {
	if (!s.run) continue;
	check(
		`no passphrase on a command line in "${s.name}"`,
		!/--passphrase(?!-fd)\b/.test(s.run.replace(/^\s*#.*$/gm, ''))
	);
}

// A step that is given a secret installs nothing: a package's install script,
// or the code a fresh resolution pulls in, would run with the secret in reach.
// Every workflow, every step.
for (const f of ['ci.yml', 'release.yml']) {
	const doc = parseYaml(readFileSync(join(dirname(WF), f), 'utf8')) as {
		jobs: Record<string, { steps?: Step[] }>;
	};
	for (const st of Object.values(doc.jobs).flatMap((j) => j.steps ?? [])) {
		if (!st.run || !JSON.stringify(st.env ?? {}).includes('secrets.')) continue;
		const code = st.run.replace(/^\s*#.*$/gm, '');
		check(
			`${f}: "${st.name}" (given a secret) installs no package`,
			!/\b(npm (i|install|ci|exec)|npx|pip3? install|ansible-galaxy)\b/.test(code)
		);
	}
}

const S = mkdtempSync(join(tmpdir(), 'morphit-signer-pin-'));
// A step's $GITHUB_OUTPUT, read back as key=value pairs.
const outFile = (): string => {
	const f = join(S, `out-${Math.random().toString(36).slice(2)}`);
	writeFileSync(f, '');
	return f;
};
const readOut = (f: string): Record<string, string> =>
	Object.fromEntries(
		readFileSync(f, 'utf8')
			.split('\n')
			.filter((l) => l.includes('='))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
	);
// git with no user/system config: the gpg defaults a fresh runner has.
const sh = (cmd: string, env: NodeJS.ProcessEnv = {}, cwd = join(S, 'repo')) =>
	spawnSync('bash', ['-c', cmd], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
		encoding: 'utf8'
	});
try {
	const pp = "--batch --pinentry-mode loopback --passphrase ''";
	const keys = join(S, 'keys');
	mkdirSync(keys, { mode: 0o700 });
	const K = { GNUPGHOME: keys };
	// "maintainer" (pinned in the cases that say so) and "attacker" (never pinned).
	const gen = sh(
		[
			`gpg ${pp} --quick-gen-key 'Maintainer <m@x.invalid>' ed25519 sign never`,
			`gpg ${pp} --quick-gen-key 'Attacker <a@x.invalid>' ed25519 sign never`
		].join(' && '),
		K,
		S
	);
	if (gen.status !== 0) throw new Error(`key generation failed: ${gen.stderr}`);
	const fprOf = (uid: string): string =>
		/^fpr:+([0-9A-F]{40}):/m.exec(sh(`gpg --with-colons --list-keys ${uid}`, K, S).stdout)?.[1] ??
		'';
	const MAINT = fprOf('m@x.invalid');
	const ATTACK = fprOf('a@x.invalid');

	// origin (bare) with main; the work repo carries BOTH public keys in its
	// signer directory, as a tag pusher could arrange.
	sh(`git init -q --bare origin.git`, {}, S);
	mkdirSync(join(S, 'repo', '.forgejo', 'release-signers'), { recursive: true });
	const setup = sh(
		[
			'gpg --armor --export m@x.invalid > .forgejo/release-signers/maintainer.asc',
			'gpg --armor --export a@x.invalid > .forgejo/release-signers/attacker.asc',
			'git init -q -b main . && git config user.email a@b && git config user.name a',
			`git remote add origin ${join(S, 'origin.git')}`,
			'git add . && git commit -qm init && git push -q origin main',
			`git -c user.signingkey=${MAINT} tag -s v9.9.9 -m v9.9.9`,
			`git -c user.signingkey=${ATTACK} tag -s v9.9.8 -m v9.9.8`,
			'git checkout -q -b side && echo x > side && git add side && git commit -qm side',
			`git -c user.signingkey=${MAINT} tag -s v9.9.7 -m v9.9.7`,
			'git checkout -q main',
			// A later commit on main: v9.9.9 stays on main, but HEAD moves on.
			'echo y > later && git add later && git commit -qm later && git push -q origin main',
			// A ref whose name is not the name inside the signed tag object it
			// points at (the object says "tag v9.9.9").
			'git update-ref refs/tags/v10.0.0 "$(git rev-parse refs/tags/v9.9.9)"'
		].join(' && '),
		K
	);
	if (setup.status !== 0) throw new Error(`repo setup failed: ${setup.stderr}`);

	let lastGateOut: Record<string, string> = {};
	const runGate = (tag: string, signers: string, head = `${tag}^{commit}`): boolean => {
		// actions/checkout leaves the pushed commit checked out (detached).
		sh(`git checkout -q --detach ${head}`);
		// The runner's own keyring starts empty (the gate imports what it uses).
		const home = mkdtempSync(join(S, 'gh-'));
		const out = outFile();
		const env = {
			GNUPGHOME: home,
			TAG: tag,
			MORPHIT_RELEASE_SIGNERS: signers,
			GITHUB_REF_NAME: tag,
			GITHUB_OUTPUT: out
		};
		lastGateOut = {};
		for (const st of gate) {
			writeFileSync(join(S, 'step.sh'), st.run!);
			if (sh('bash -eu ../step.sh', env).status !== 0) return false;
		}
		lastGateOut = readOut(out);
		return gate.length > 0;
	};
	check(
		'a tag signed by a key the tree ships but that is not pinned is refused',
		runGate('v9.9.8', MAINT) === false
	);
	check(
		'a tag signed by a pinned key whose commit is not on main is refused',
		runGate('v9.9.7', MAINT) === false
	);
	check('a tag signed by a pinned key on main is accepted', runGate('v9.9.9', MAINT) === true);
	check(
		'the tag gate reports the pinned key that signed the tag (the anchor of an unsigned release names it)',
		(lastGateOut.tag_signer ?? '').toUpperCase() === MAINT,
		JSON.stringify(lastGateOut)
	);
	check(
		'a tag ref whose signed tag object names another tag is refused (v10.0.0 -> object "tag v9.9.9")',
		runGate('v10.0.0', MAINT) === false
	);
	check(
		'a tag whose commit is not the commit the job checked out is refused',
		runGate('v9.9.9', MAINT, 'main') === false
	);

	// ── The distribution anchor carries the tag object that was built ──
	const anchorStep = steps.find((s) => (s.name ?? '').startsWith('Write distribution anchor'));
	if (!anchorStep?.run) throw new Error('no "Write distribution anchor" step with a run block');
	writeFileSync(join(S, 'anchor.sh'), anchorStep.run);
	sh('git checkout -q --detach v9.9.9^{commit}');
	writeFileSync(join(S, 'repo', 'morphit-v9.9.9.tar.gz'), 'release bytes\n');
	sh('sha256sum morphit-v9.9.9.tar.gz > morphit-v9.9.9.tar.gz.sha256');
	writeFileSync(join(S, 'repo', 'release-signer.fpr'), `${MAINT}\n`);
	// The offline bundle the job built before signing (fixed bytes).
	const OFF = 'morphit-v9.9.9-offline.tar.gz';
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	const offSha = sh(`sha256sum ${OFF}`).stdout.split(' ')[0]!;
	const anchorEnv = {
		TAG: 'v9.9.9',
		TARBALL: 'morphit-v9.9.9.tar.gz',
		OFFLINE: OFF,
		MORPHIT_RELEASE_SIGNERS: MAINT
	};
	const anchorFpr = (): string =>
		/^export MORPHIT_BUILD_GPG_FINGERPRINT=(.*)$/m.exec(
			existsSync(join(S, 'repo', 'distribution-anchor.env'))
				? readFileSync(join(S, 'repo', 'distribution-anchor.env'), 'utf8')
				: ''
		)?.[1] ?? '';
	// No .asc this run: the anchor names the pinned key that signed the tag.
	rmSync(join(S, 'repo', 'release-signer.fpr'), { force: true });
	const anchUnsigned = sh('bash -eu ../anchor.sh', {
		...anchorEnv,
		SIGNED: 'no',
		TAG_SIGNER: MAINT
	});
	check(
		'unsigned release: the anchor names the pinned key that signed the tag',
		anchUnsigned.status === 0 && anchorFpr() === MAINT,
		anchUnsigned.stderr.slice(-300)
	);
	rmSync(join(S, 'repo', 'distribution-anchor.env'), { force: true });
	const anchUnpinned = sh('bash -eu ../anchor.sh', {
		...anchorEnv,
		SIGNED: 'no',
		TAG_SIGNER: ATTACK
	});
	check(
		'the anchor refuses a fingerprint that is not pinned',
		anchUnpinned.status !== 0 && !existsSync(join(S, 'repo', 'distribution-anchor.env')),
		anchUnpinned.stderr.slice(-300)
	);
	writeFileSync(join(S, 'repo', 'release-signer.fpr'), `${MAINT}\n`);
	const anch = sh('bash -eu ../anchor.sh', { ...anchorEnv, SIGNED: 'yes', TAG_SIGNER: MAINT });
	const anchorText = existsSync(join(S, 'repo', 'distribution-anchor.env'))
		? readFileSync(join(S, 'repo', 'distribution-anchor.env'), 'utf8')
		: '';
	const tagObject = sh('git rev-parse refs/tags/v9.9.9').stdout.trim();
	check(
		'the distribution anchor names the signed tag object the job built (Block 4 compares it with the tag it pushed)',
		anch.status === 0 &&
			new RegExp(`^export MORPHIT_BUILD_TAG_OBJECT=${tagObject}$`, 'm').test(anchorText),
		anch.stderr.slice(-300) || anchorText
	);
	check(
		"the distribution anchor carries the offline bundle's SHA-256",
		new RegExp(`^export MORPHIT_BUILD_OFFLINE_SHA256=${offSha}$`, 'm').test(anchorText),
		anchorText
	);

	// ── The signing step ──
	if (!signStep?.run) throw new Error('no "Sign release tarball" step with a run block');
	writeFileSync(join(S, 'sign.sh'), signStep.run);
	const T = 'morphit-v9.9.9.tar.gz';
	writeFileSync(join(S, 'repo', T), 'release bytes\n');
	const secret = (uid: string): string =>
		sh(`gpg ${pp} --armor --export-secret-keys ${uid}`, K, S).stdout;
	let lastSignOut: Record<string, string> = {};
	const sign = (key: string, signers: string, keepAsc = false) => {
		if (!keepAsc) {
			rmSync(join(S, 'repo', `${T}.asc`), { force: true });
			rmSync(join(S, 'repo', `${OFF}.asc`), { force: true });
		}
		const out = outFile();
		const r = sh('bash -eu ../sign.sh', {
			GNUPGHOME: mkdtempSync(join(S, 'sh-')),
			TARBALL: T,
			OFFLINE: OFF,
			SIGNING_KEY: key,
			SIGNING_PASSPHRASE: '',
			MORPHIT_RELEASE_SIGNERS: signers,
			GITHUB_OUTPUT: out
		});
		lastSignOut = readOut(out);
		return r;
	};
	// A stale .asc (and signer file) from an earlier run in the same workspace.
	writeFileSync(join(S, 'repo', `${T}.asc`), 'stale\n');
	writeFileSync(join(S, 'repo', 'release-signer.fpr'), `${MAINT}\n`);
	const noKey = sign('', MAINT, true);
	check(
		'with no signing key the step signs nothing, removes any stale .asc, and reports signed=no',
		noKey.status === 0 &&
			lastSignOut.signed === 'no' &&
			!existsSync(join(S, 'repo', `${T}.asc`)) &&
			!existsSync(join(S, 'repo', 'release-signer.fpr')),
		`status ${noKey.status}; ${JSON.stringify(lastSignOut)}; ${noKey.stderr.slice(-300)}`
	);
	const wrongKey = sign(secret('a@x.invalid'), MAINT);
	check(
		'a signing key that is not pinned fails the release',
		wrongKey.status !== 0 && !existsSync(join(S, 'repo', `${T}.asc`))
	);
	const good = sign(secret('m@x.invalid'), MAINT);
	const goodOut = lastSignOut;
	const verifies =
		existsSync(join(S, 'repo', `${T}.asc`)) &&
		new RegExp(`VALIDSIG ${MAINT} `).test(
			sh(`gpg --batch --status-fd 1 --verify ${T}.asc ${T}`, K).stdout
		);
	check(
		'a pinned signing key signs the tarball and reports signed=yes',
		good.status === 0 && verifies && goodOut.signed === 'yes',
		good.stderr.slice(-300)
	);
	check(
		'the same step signs the offline bundle with the pinned key (an installed v1.20.2 node checks it against .forgejo/release-signers)',
		existsSync(join(S, 'repo', `${OFF}.asc`)) &&
			new RegExp(`VALIDSIG ${MAINT} `).test(
				sh(`gpg --batch --status-fd 1 --verify ${OFF}.asc ${OFF}`, K).stdout
			),
		good.stderr.slice(-300)
	);

	// ── The publish step re-verifies BOTH signatures before attaching anything ──
	const pubStep = steps.find((s) => (s.name ?? '').startsWith('Publish Forgejo release'));
	if (!pubStep?.run) throw new Error('no "Publish Forgejo release" step with a run block');
	writeFileSync(join(S, 'publish.sh'), pubStep.run);
	// No token: a publish that gets as far as asking for one has passed every check.
	const publish = (signed = 'yes') =>
		sh('bash -eu ../publish.sh', {
			GNUPGHOME: mkdtempSync(join(S, 'ph-')),
			TAG: 'v9.9.9',
			TARBALL: T,
			OFFLINE: OFF,
			SIGNED: signed,
			MORPHIT_RELEASE_SIGNERS: MAINT,
			RELEASE_TOKEN: '',
			AUTO_TOKEN: ''
		});
	const allGood = publish();
	check(
		'publish: with both tarballs signed and anchored it gets as far as the upload',
		/no token available/.test(allGood.stderr),
		allGood.stderr.slice(-300)
	);
	const noReport = publish('');
	check(
		'publish: refuses when the sign step reported neither signed=yes nor signed=no',
		noReport.status !== 0 && !/no token available/.test(noReport.stderr),
		noReport.stderr.slice(-300)
	);
	const ascButUnsigned = publish('no');
	check(
		'publish: refuses .asc files the sign step did not make',
		ascButUnsigned.status !== 0 && !/no token available/.test(ascButUnsigned.stderr),
		ascButUnsigned.stderr.slice(-300)
	);
	const offAscPath = join(S, 'repo', `${OFF}.asc`);
	const offAsc = existsSync(offAscPath) ? readFileSync(offAscPath) : null;
	rmSync(offAscPath, { force: true });
	const noOffAsc = publish();
	check(
		"publish: refuses when the offline bundle's .asc is missing",
		noOffAsc.status !== 0 && !/no token available/.test(noOffAsc.stderr),
		noOffAsc.stderr.slice(-300)
	);
	if (offAsc !== null) writeFileSync(offAscPath, offAsc);
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes, rewritten after signing\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	const rewritten = publish();
	check(
		'publish: refuses an offline bundle rewritten after signing',
		rewritten.status !== 0 && !/no token available/.test(rewritten.stderr),
		rewritten.stderr.slice(-300)
	);
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	rmSync(join(S, 'repo', OFF));
	const noBundle = publish();
	check(
		'publish: refuses when there is no offline bundle at all',
		noBundle.status !== 0 && !/no token available/.test(noBundle.stderr),
		noBundle.stderr.slice(-300)
	);
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes\n');
	// An unsigned release (no key set): no .asc anywhere, hashes anchored.
	const ascBackup = [T, OFF].map((f) => [f, readFileSync(join(S, 'repo', `${f}.asc`))] as const);
	for (const [f] of ascBackup) rmSync(join(S, 'repo', `${f}.asc`));
	const unsignedOk = publish('no');
	check(
		'publish: an unsigned release (signed=no, no .asc) whose files match the anchor gets as far as the upload',
		/no token available/.test(unsignedOk.stderr),
		unsignedOk.stderr.slice(-300)
	);
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes, rewritten\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	const unsignedRewritten = publish('no');
	check(
		'publish: an unsigned release whose file no longer matches the anchor is refused',
		unsignedRewritten.status !== 0 && !/no token available/.test(unsignedRewritten.stderr),
		unsignedRewritten.stderr.slice(-300)
	);
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	const freshUnsignedState = { exists: false, assets: [], anchor: '' };
	for (const [f, b] of ascBackup) writeFileSync(join(S, 'repo', `${f}.asc`), b);

	// ── A release that already exists for the tag (a re-run, or a tag moved back
	// to an older signed object after it was published) ──
	// A stand-in Forgejo API behind a `curl` on PATH: the release for v9.9.9
	// exists (409) with the assets in the state file; uploads are logged.
	const api = join(S, 'api');
	mkdirSync(join(api, 'bin'), { recursive: true });
	writeFileSync(
		join(api, 'bin', 'curl'),
		`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_API_STATE, 'utf8'));
let out = null, fmt = null, method = 'GET', url = '';
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-o') out = a[++i];
  else if (a[i] === '-w') fmt = a[++i];
  else if (a[i] === '-X') method = a[++i];
  else if (['-H', '-F', '--data-binary'].includes(a[i])) {
    if (a[i] === '-F') fs.appendFileSync(process.env.FAKE_API_LOG, 'UPLOAD ' + a[i + 1] + '\\n');
    i++;
  } else if (!a[i].startsWith('-')) url = a[i];
}
let code = 200, body = '';
if (method === 'POST' && /\\/releases$/.test(url)) { code = st.exists ? 409 : 201; body = JSON.stringify({ id: 7 }); }
else if (/\\/releases\\/tags\\//.test(url)) body = JSON.stringify({ id: 7, assets: st.assets });
else if (method === 'POST' && /\\/assets\\?name=/.test(url)) { code = 201; body = '{}'; }
else if (url === 'https://forge.invalid/anchor') body = st.anchor;
if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
if (fmt) process.stdout.write(fmt.replace('%{http_code}', String(code)));
`,
		{ mode: 0o755 }
	);
	const anchorNow = readFileSync(join(S, 'repo', 'distribution-anchor.env'), 'utf8');
	const publishTo = (state: object, signed = 'yes') => {
		writeFileSync(join(api, 'state.json'), JSON.stringify(state));
		writeFileSync(join(api, 'log'), '');
		const r = sh('bash -eu ../publish.sh', {
			GNUPGHOME: mkdtempSync(join(S, 'ph-')),
			PATH: `${join(api, 'bin')}:${process.env.PATH ?? ''}`,
			FAKE_API_STATE: join(api, 'state.json'),
			FAKE_API_LOG: join(api, 'log'),
			TAG: 'v9.9.9',
			TARBALL: T,
			OFFLINE: OFF,
			SIGNED: signed,
			MORPHIT_RELEASE_SIGNERS: MAINT,
			RELEASE_TOKEN: 't',
			AUTO_TOKEN: '',
			GITHUB_API_URL: 'https://forge.invalid/api/v1',
			GITHUB_REPOSITORY: 'o/r'
		});
		return {
			r,
			uploads: readFileSync(join(api, 'log'), 'utf8').trim().split('\n').filter(Boolean)
		};
	};
	const anchorAsset = [
		{ name: 'distribution-anchor.env', browser_download_url: 'https://forge.invalid/anchor' }
	];
	const moved = publishTo({
		exists: true,
		assets: anchorAsset,
		anchor: anchorNow.replace(
			/MORPHIT_BUILD_TAG_OBJECT=[0-9a-f]+/,
			`MORPHIT_BUILD_TAG_OBJECT=${'b'.repeat(40)}`
		)
	});
	check(
		'publish: a release for this tag already published from ANOTHER tag object (the tag was moved back) gets nothing attached',
		moved.r.status !== 0 && moved.uploads.length === 0 && /moved/.test(moved.r.stderr),
		`status ${moved.r.status}; uploads ${moved.uploads.join(', ')}; ${moved.r.stderr.slice(-300)}`
	);
	const rerun = publishTo({ exists: true, assets: anchorAsset, anchor: anchorNow });
	check(
		'publish: a re-run for the same tag object attaches, the anchor first',
		rerun.r.status === 0 && /distribution-anchor\.env/.test(rerun.uploads[0] ?? ''),
		`status ${rerun.r.status}; uploads ${rerun.uploads.join(', ')}; ${rerun.r.stderr.slice(-300)}`
	);
	const noAnchor = publishTo({
		exists: true,
		assets: [{ name: T, browser_download_url: 'https://forge.invalid/t' }],
		anchor: ''
	});
	check(
		'publish: a release that has assets but no anchor naming its tag object gets nothing attached',
		noAnchor.r.status !== 0 && noAnchor.uploads.length === 0,
		`status ${noAnchor.r.status}; uploads ${noAnchor.uploads.join(', ')}`
	);
	const fresh = publishTo({ exists: false, assets: [], anchor: '' });
	check(
		'publish: a new release gets all seven assets',
		fresh.r.status === 0 && fresh.uploads.length === 7,
		`status ${fresh.r.status}; uploads ${fresh.uploads.join(', ')}; ${fresh.r.stderr.slice(-300)}`
	);
	for (const [f] of ascBackup) rmSync(join(S, 'repo', `${f}.asc`));
	const freshUnsigned = publishTo(freshUnsignedState, 'no');
	check(
		'publish: a new unsigned release gets the five assets that are not signatures',
		freshUnsigned.r.status === 0 &&
			freshUnsigned.uploads.length === 5 &&
			!freshUnsigned.uploads.some((u) => /\.asc\b/.test(u)),
		`status ${freshUnsigned.r.status}; uploads ${freshUnsigned.uploads.join(', ')}; ${freshUnsigned.r.stderr.slice(-300)}`
	);
	for (const [f, b] of ascBackup) writeFileSync(join(S, 'repo', `${f}.asc`), b);

	// The mirror step applies the same rule (best-effort: it warns and skips).
	if (!mirrorStep?.run) throw new Error('no "Mirror the release" step with a run block');
	writeFileSync(join(S, 'mirror.sh'), mirrorStep.run);
	const mirrorTo = (state: object) => {
		writeFileSync(join(api, 'state.json'), JSON.stringify(state));
		writeFileSync(join(api, 'log'), '');
		const r = sh('bash -u ../mirror.sh', {
			PATH: `${join(api, 'bin')}:${process.env.PATH ?? ''}`,
			FAKE_API_STATE: join(api, 'state.json'),
			FAKE_API_LOG: join(api, 'log'),
			TAG: 'v9.9.9',
			TARBALL: T,
			OFFLINE: OFF,
			CODEBERG_TOKEN: 't',
			GITEA_COM_TOKEN: '' // no token for the gitea.com mirror: the step skips it
		});
		return {
			r,
			uploads: readFileSync(join(api, 'log'), 'utf8').trim().split('\n').filter(Boolean)
		};
	};
	const mMoved = mirrorTo({
		exists: true,
		assets: anchorAsset,
		anchor: anchorNow.replace(
			/MORPHIT_BUILD_TAG_OBJECT=[0-9a-f]+/,
			`MORPHIT_BUILD_TAG_OBJECT=${'b'.repeat(40)}`
		)
	});
	check(
		'mirror: a mirror release published from another tag object gets nothing attached (warned)',
		mMoved.uploads.length === 0 && /tag was moved/.test(mMoved.r.stdout),
		`uploads ${mMoved.uploads.join(', ')}; ${mMoved.r.stdout.slice(-300)}`
	);
	const mSame = mirrorTo({ exists: true, assets: anchorAsset, anchor: anchorNow });
	check(
		'mirror: the same tag object attaches there, the anchor first',
		/distribution-anchor\.env/.test(mSame.uploads[0] ?? '') && mSame.uploads.length === 7,
		`uploads ${mSame.uploads.join(', ')}`
	);

	// A pinned key whose signatures come from a signing SUBKEY (VALIDSIG names
	// the subkey first, the pinned primary last) must sign too: rotating to such
	// a key must never stop a release.
	const sub = sh(
		[
			`gpg ${pp} --quick-gen-key 'Subsigner <s@x.invalid>' ed25519 cert never`,
			`gpg ${pp} --quick-add-key "$(gpg --with-colons --list-keys s@x.invalid | awk -F: '/^fpr/ {print $10; exit}')" ed25519 sign never`
		].join(' && '),
		K,
		S
	);
	const SUBPRIMARY = fprOf('s@x.invalid');
	const bySub = sub.status === 0 ? sign(secret('s@x.invalid'), SUBPRIMARY) : sub;
	check(
		'a pinned key that signs with a subkey signs the tarball',
		bySub.status === 0 && existsSync(join(S, 'repo', `${T}.asc`)),
		bySub.stderr.slice(-300)
	);
} finally {
	rmSync(S, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`✗ ${failures.length} release-signer-pin scenario(s) failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} release-signer-pin scenarios passed`);
