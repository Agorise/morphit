/**
 * release-publish-reverify-smoke.
 *
 * The release job ran `actions/upload-artifact@v3` — referenced by a movable
 * TAG — after the tarball, .sha256, .asc and distribution-anchor.env were
 * written and before they were published. A moved tag could rewrite the
 * tarball, its .sha256 and the anchor consistently; the primary then published
 * them and the ceremony anchored the poisoned SHA on-chain.
 *
 * This EXECUTES the real "Publish Forgejo release" step script from
 * .forgejo/workflows/release.yml against a scratch repo with a throwaway
 * signer: the genuine files must pass the new re-verification (and go on to
 * the publish, which stops at "no token" here), a consistently rewritten
 * tarball or an anchor for different bytes must stop before anything is
 * published. With no signing key (the sign step reports signed=no) nothing
 * can detect a consistent rewrite of tarball, .sha256 and anchor; the files
 * must still match the anchor, and no .asc is attached. It also checks every
 * `uses:` in the workflows is pinned to a full commit SHA.
 *
 * To watch it fail on the old workflow:
 *   MORPHIT_RELEASE_WORKFLOW=<old>/.forgejo/workflows/release.yml npx tsx scripts/release-publish-reverify-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
	uses?: string;
}
const wf = parseYaml(readFileSync(WF, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
const publish = steps.find((s) => (s.name ?? '').startsWith('Publish Forgejo release'));
if (!publish?.run) {
	console.log('✗ no "Publish Forgejo release" step with a run block');
	process.exit(1);
}

const S = mkdtempSync(join(tmpdir(), 'morphit-publish-reverify-'));
const sh = (cmd: string, env: NodeJS.ProcessEnv = {}, cwd = join(S, 'repo')) =>
	spawnSync('bash', ['-c', cmd], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
try {
	const gnupg = join(S, 'gnupg');
	mkdirSync(gnupg, { mode: 0o700 });
	mkdirSync(join(S, 'repo', '.forgejo', 'release-signers'), { recursive: true });
	writeFileSync(join(S, 'publish.sh'), publish.run);
	const G = { GNUPGHOME: gnupg };
	const pp = "--batch --pinentry-mode loopback --passphrase ''";
	const setup = sh(
		[
			`gpg ${pp} --quick-gen-key 'Signer <s@x.invalid>' ed25519 sign never`,
			'gpg --armor --export s@x.invalid > .forgejo/release-signers/s.asc',
			'git init -q . && git config user.email a@b && git config user.name a',
			'git add . && git commit -qm init && git tag v9.9.9'
		].join(' && '),
		G
	);
	if (setup.status !== 0) throw new Error(`setup failed: ${setup.stderr}`);

	const T = 'morphit-v9.9.9.tar.gz';
	// The signed offline bundle is published with the tarball (and checked the same way).
	const OFF = 'morphit-v9.9.9-offline.tar.gz';
	writeFileSync(join(S, 'repo', OFF), 'offline bundle bytes\n');
	sh(`sha256sum ${OFF} > ${OFF}.sha256`);
	const offSha = readFileSync(join(S, 'repo', `${OFF}.sha256`), 'utf8').split(/\s/)[0];
	const files = (content: string, anchor?: string): void => {
		writeFileSync(join(S, 'repo', T), content);
		sh(`sha256sum ${T} > ${T}.sha256`);
		const sha = anchor ?? readFileSync(join(S, 'repo', `${T}.sha256`), 'utf8').split(/\s/)[0];
		writeFileSync(
			join(S, 'repo', 'distribution-anchor.env'),
			`export MORPHIT_BUILD_SOURCE_SHA256=${sha}\nexport MORPHIT_BUILD_OFFLINE_SHA256=${offSha}\n`
		);
	};
	files('genuine release bytes\n');
	sh(`gpg ${pp} --armor --detach-sign -o ${T}.asc ${T}`, G);
	sh(`gpg ${pp} --armor --detach-sign -o ${OFF}.asc ${OFF}`, G);
	const fpr =
		/^fpr:+([0-9A-F]{40}):/m.exec(sh('gpg --with-colons --list-keys', G).stdout)?.[1] ?? '';
	// The signing key has left the runner by the time the publish step runs.
	rmSync(gnupg, { recursive: true, force: true });
	mkdirSync(gnupg, { mode: 0o700 });

	// Tokens empty: the step's publish part stops with "no token available",
	// which is how a run that got PAST the verification shows itself here.
	// MORPHIT_RELEASE_SIGNERS is the job-level pin; here it names the throwaway key.
	// SIGNED is the sign step's output (yes: it signed both files).
	const run = (signers = fpr, signed = 'yes') =>
		sh('bash -eu ../publish.sh', {
			...G,
			TAG: 'v9.9.9',
			TARBALL: T,
			OFFLINE: OFF,
			SIGNED: signed,
			MORPHIT_RELEASE_SIGNERS: signers,
			RELEASE_TOKEN: '',
			AUTO_TOKEN: ''
		});
	const reachedPublish = (r: ReturnType<typeof run>): boolean =>
		/no token available/.test(r.stdout + r.stderr);

	const genuine = run();
	check(
		'the genuine signed tarball passes and goes on to be published',
		reachedPublish(genuine),
		genuine.stderr.slice(-400)
	);

	const unpinned = run('0'.repeat(40));
	check(
		'a good signature from a key the tag ships but that is not pinned is not published',
		!reachedPublish(unpinned) && unpinned.status !== 0,
		unpinned.stdout.slice(-400)
	);

	const ascBytes = readFileSync(join(S, 'repo', `${T}.asc`));
	rmSync(join(S, 'repo', `${T}.asc`));
	const stripped = run();
	check(
		'a signature the sign step made but that is gone by publish time is not published around',
		!reachedPublish(stripped) && stripped.status !== 0,
		stripped.stdout.slice(-400)
	);
	// No signing key set: the sign step signed nothing (signed=no).
	const offAscBytes = readFileSync(join(S, 'repo', `${OFF}.asc`));
	rmSync(join(S, 'repo', `${OFF}.asc`));
	const unsigned = run(fpr, 'no');
	check(
		'an unsigned release (signed=no) whose files match the anchor goes on to be published',
		reachedPublish(unsigned),
		unsigned.stderr.slice(-400)
	);
	files('genuine release bytes\n', 'f'.repeat(64));
	const unsignedBadAnchor = run(fpr, 'no');
	check(
		'an unsigned release with an anchor that names different bytes is not published',
		!reachedPublish(unsignedBadAnchor) && unsignedBadAnchor.status !== 0,
		unsignedBadAnchor.stdout.slice(-400)
	);
	files('genuine release bytes\n');
	writeFileSync(join(S, 'repo', `${T}.asc`), ascBytes);
	writeFileSync(join(S, 'repo', `${OFF}.asc`), offAscBytes);

	files('REWRITTEN release bytes\n'); // tarball, .sha256 and anchor all consistent; old .asc
	const tampered = run();
	check(
		'a tarball rewritten after signing (with matching .sha256 + anchor) is not published',
		!reachedPublish(tampered) && tampered.status !== 0,
		tampered.stdout.slice(-400)
	);

	files('genuine release bytes\n', 'f'.repeat(64));
	const badAnchor = run();
	check(
		'an anchor that names different bytes is not published',
		!reachedPublish(badAnchor) && badAnchor.status !== 0,
		badAnchor.stdout.slice(-400)
	);
} finally {
	rmSync(S, { recursive: true, force: true });
}

// Every action is pinned to a commit, not a movable tag.
const wfDir = dirname(WF);
for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
	const doc = parseYaml(readFileSync(join(wfDir, f), 'utf8')) as {
		jobs?: Record<string, { steps?: Step[] }>;
	};
	for (const st of Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? [])) {
		if (st.uses === undefined) continue;
		check(
			`${f}: ${st.uses.split('@')[0]} is pinned to a commit`,
			/@[0-9a-f]{40}$/.test(st.uses),
			st.uses
		);
	}
}

if (failures.length > 0) {
	console.log(`✗ ${failures.length} release-publish-reverify scenario(s) failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} release-publish-reverify scenarios passed`);
