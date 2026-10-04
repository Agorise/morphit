/**
 * canary-verify-smoke.
 *
 * scripts/canary/verify.ts said "OK" for any text that started with the
 * canary header, carried a recent Generated: line and contained the two
 * PGP armor lines — a forged, unsigned canary passed. It now runs gpg and
 * requires a good signature by the fingerprint given on the command line,
 * and checks freshness on the SIGNED text only.
 *
 * Two real gpg keys are made in a scratch keyring; the real CLI is run.
 *   MORPHIT_CANARY_VERIFY=<other copy> tsx scripts/canary-verify-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const VERIFY = resolve(process.env.MORPHIT_CANARY_VERIFY ?? join(HERE, 'canary', 'verify.ts'));
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const S = mkdtempSync(join(tmpdir(), 'canary-verify-smoke-'));
const GNUPGHOME = join(S, 'gnupg');
mkdirSync(GNUPGHOME, { mode: 0o700 });
const env = { ...process.env, GNUPGHOME, LC_ALL: 'C' };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const gpg = (args: string[], input?: string) =>
	spawnSync('gpg', ['--batch', ...args], { env, input, encoding: 'utf8' });
function key(uid: string): string {
	gpg(['--passphrase', '', '--quick-gen-key', uid, 'ed25519', 'sign', '1y']);
	const out = gpg(['--with-colons', '--list-keys', uid]).stdout;
	return /^fpr:+([0-9A-F]{40}):/m.exec(out)![1]!;
}
const OPERATOR = key('Canary Operator <canary@example.org>');
const OTHER = key('Somebody Else <else@example.org>');
writeFileSync(join(S, 'operator.asc'), gpg(['--armor', '--export', OPERATOR]).stdout);

const stamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const body = (generated: Date): string =>
	[
		'=== MORPHIT CANARY ===',
		'',
		'Operator: Example',
		'Origin: https://example.org',
		`Generated: ${stamp(generated)}`,
		`Valid through: ${stamp(new Date(generated.getTime() + 14 * 86400_000))}`,
		'Blurt head: 1 abc',
		'BTC head: 2 def',
		'News: a headline',
		''
	].join('\n');
function sign(text: string, fpr: string): string {
	writeFileSync(join(S, 'in.txt'), text);
	gpg([
		'--yes',
		'--local-user',
		fpr,
		'--clearsign',
		'--output',
		join(S, 'out.asc'),
		join(S, 'in.txt')
	]);
	return readFileSync(join(S, 'out.asc'), 'utf8');
}
function run(text: string, args: string[], extraEnv: Record<string, string> = {}): number | null {
	const f = join(S, `c-${Math.random().toString(36).slice(2)}.txt`);
	writeFileSync(f, text);
	return spawnSync(TSX, [VERIFY, f, ...args], {
		env: { ...env, ...extraEnv },
		encoding: 'utf8',
		timeout: 60_000
	}).status;
}

const now = new Date();
const good = sign(body(now), OPERATOR);
const forged =
	body(now) +
	'-----BEGIN PGP SIGNATURE-----\n\niQEzBAEBCAAdFiEEforgedforgedforged\n=abcd\n-----END PGP SIGNATURE-----\n';

console.log('\n── canary verify smoke ───────────────────────────────────\n');
check('signed by the given key, fresh → OK (exit 0)', run(good, ['--fingerprint', OPERATOR]) === 0);
check(
	'same, against only the operator’s published key file → OK',
	run(good, ['--fingerprint', OPERATOR, '--key-file', join(S, 'operator.asc')], {
		GNUPGHOME: join(S, 'empty')
	}) === 0
);
check(
	'a forged canary with a made-up signature block → FAIL',
	run(forged, ['--fingerprint', OPERATOR]) === 1
);
check(
	'signed by another key → FAIL',
	run(sign(body(now), OTHER), ['--fingerprint', OPERATOR]) === 1
);
check(
	'signed, then a line changed → FAIL',
	run(good.replace('a headline', 'another headline'), ['--fingerprint', OPERATOR]) === 1
);
check(
	'a fresh unsigned line added around a stale signed canary → FAIL (stale)',
	run(
		`Generated: ${stamp(now)}\n` + sign(body(new Date(now.getTime() - 30 * 86400_000)), OPERATOR),
		['--fingerprint', OPERATOR]
	) === 1
);
check('no --fingerprint → FAIL', run(good, []) === 1);
check(
	'gpg missing → FAIL',
	run(good, ['--fingerprint', OPERATOR], { PATH: dirname(process.execPath) }) === 1
);
check('--structure-only never says OK (exit 3)', run(body(now), ['--structure-only']) === 3);

// generate.sh reads its template from scripts/canary/ (the old place,
// apps/web/static/, served it publicly), and still from the old place in a
// tree that has not moved it. Run in a scratch tree with no tools on PATH: it
// must get past the template lookup to the tool check. Only the coreutils it
// needs before that check are on PATH (no gpg).
const BIN = join(S, 'bin');
mkdirSync(BIN);
for (const tool of ['dirname', 'mkdir', 'cat']) {
	const at = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
	if (at) symlinkSync(at, join(BIN, tool));
}
const GENERATE = resolve(
	process.env.MORPHIT_CANARY_GENERATE ?? join(HERE, 'canary', 'generate.sh')
);
const genIn = (templateAt: string): string => {
	const tree = mkdtempSync(join(S, 'tree-'));
	mkdirSync(join(tree, 'scripts', 'canary'), { recursive: true });
	writeFileSync(join(tree, 'scripts', 'canary', 'generate.sh'), readFileSync(GENERATE));
	mkdirSync(join(tree, dirname(templateAt)), { recursive: true });
	writeFileSync(join(tree, templateAt), 'Generated: {{GENERATED}}\n');
	const r = spawnSync('/bin/bash', [join(tree, 'scripts', 'canary', 'generate.sh')], {
		encoding: 'utf8',
		env: {
			PATH: BIN,
			MORPHIT_CANARY_PGP_KEY_ID: 'X',
			MORPHIT_CANARY_OPERATOR_NAME: 'X',
			MORPHIT_CANARY_INSTANCE_ORIGIN: 'https://node.test',
			MORPHIT_CANARY_OPERATOR_ACCOUNT: 'x',
			MORPHIT_CANARY_OUT: join(tree, 'out', 'canary.txt')
		}
	});
	return `${r.stdout}${r.stderr}`;
};
for (const at of ['scripts/canary/canary.txt.template', 'apps/web/static/canary.txt.template']) {
	const out = genIn(at);
	check(
		`generate.sh finds the template at ${at}`,
		!/template missing/.test(out) && /required tool/.test(out),
		out.trim().split('\n').slice(-1)[0] ?? ''
	);
}

rmSync(S, { recursive: true, force: true });
console.log(
	fail === 0 ? `✓ all ${pass} canary-verify checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
