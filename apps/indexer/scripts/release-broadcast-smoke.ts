/**
 * release-broadcast-smoke
 *
 * Guards the release-op broadcast tooling: the pure op-builder +
 * view-key guard, and the CLI's safety invariants (dry-run asks for
 * no key, the key is read masked and never persisted, laptop-only
 * banner present).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildReleaseCustomJsonOp,
	assertNoSecretHex,
	RELEASE_OP_ID,
	RELEASE_SIGNER_DEFAULT,
	BLURT_CUSTOM_JSON_MAX_BYTES
} from '../src/blurt/releaseBroadcastOp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};
const throws = (label: string, fn: () => unknown, needle: string) => {
	try {
		fn();
		bad(`${label} should throw`, 'did not throw');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes(needle)) ok(`${label} → throws (${needle})`);
		else bad(`${label} threw wrong error`, msg);
	}
};

const BTC = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const XMR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const VALID = JSON.stringify({
	version: '1.0.0',
	hash_manifest: { 'app.js': 'sha256-' + 'A'.repeat(43) + '=' },
	endpoints: { blurt_rpc: ['https://rpc.beblurt.com'] },
	treasury: { btc: { address: BTC, satoshis: 416 }, xmr: { address: XMR, piconero: '781250000' } }
});

// ── 1. valid payload → correct op shape ───────────────────────────
const op = buildReleaseCustomJsonOp(VALID);
if (
	op.id === RELEASE_OP_ID &&
	op.required_auths.length === 0 &&
	op.required_posting_auths.length === 1 &&
	op.required_posting_auths[0] === RELEASE_SIGNER_DEFAULT &&
	op.json === VALID.trim()
)
	ok('valid payload → op {id:morphit_release_v1, posting_auths:[morphit], json=input}');
else bad('valid payload produced wrong op', JSON.stringify(op));

// ── 2. custom signer respected ────────────────────────────────────
if (buildReleaseCustomJsonOp(VALID, 'example-op').required_posting_auths[0] === 'example-op')
	ok('custom --signer is honored');
else bad('custom signer not honored', '');

// ── a distribution block's source_sha256 is LEGITIMATELY 64-hex
//    and must NOT trip the secret-hex guard.  Before the fix, the
//    broadcaster scanned the whole payload and REFUSED every release that
//    carried a distribution anchor (caught live during the v1.8.15
//    ceremony). The guard now excludes the strictly-validated distribution
//    block, mirroring the builder. ──
const WITH_DISTRIBUTION = JSON.stringify({
	version: '1.8.15',
	hash_manifest: { 'app.js': 'sha256-' + 'A'.repeat(43) + '=' },
	treasury: { btc: { address: BTC, satoshis: 416 }, xmr: { address: XMR, piconero: '781250000' } },
	distribution: {
		source_sha256: 'a'.repeat(64),
		gpg_fingerprint: '7B4C1D189DBB610C473B59ED53524E1F1017EB9C',
		mirrors: ['https://codeberg.org/agorise/morphit', 'https://github.com/agorise/morphit']
	}
});
try {
	const opDist = buildReleaseCustomJsonOp(WITH_DISTRIBUTION);
	if (opDist.id === RELEASE_OP_ID && opDist.json === WITH_DISTRIBUTION.trim())
		ok('cp560 — distribution source_sha256 (64-hex) does NOT trip the secret guard');
	else bad('cp560 — distribution payload produced wrong op', JSON.stringify(opDist));
} catch (e) {
	bad(
		'cp560 — distribution block wrongly rejected by the secret guard',
		e instanceof Error ? e.message : String(e)
	);
}
// …but a 64-hex OUTSIDE the distribution block is STILL caught — the strip
// is surgical, the treasury/other blocks stay scanned.
throws(
	'cp560 — a 64-hex outside distribution is still refused',
	() => assertNoSecretHex(JSON.stringify({ treasury: { note: 'f'.repeat(64) } })),
	'secret key'
);

const NO_ENDPOINTS = JSON.stringify({
	version: '1.1.0',
	hash_manifest: { 'app.js': 'sha256-' + 'A'.repeat(43) + '=' },
	treasury: { btc: { address: BTC, satoshis: 416 }, xmr: { address: XMR, piconero: '781250000' } }
});
const opNoEp = buildReleaseCustomJsonOp(NO_ENDPOINTS);
if (
	opNoEp.id === RELEASE_OP_ID &&
	opNoEp.json === NO_ENDPOINTS.trim() &&
	!opNoEp.json.includes('endpoints')
)
	ok('cp436 — no-endpoints payload → valid op, no endpoints pinned');
else bad('cp436 — no-endpoints payload failed', JSON.stringify(opNoEp));

// ── 3. invalid payload (bad version) → validation error ───────────
throws(
	'invalid payload (version not semver)',
	() => buildReleaseCustomJsonOp(JSON.stringify({ ...JSON.parse(VALID), version: 'nope' })),
	'failed validation'
);

// ── 4. non-JSON → JSON error ──────────────────────────────────────
throws('non-JSON payload', () => buildReleaseCustomJsonOp('{ not json'), 'not valid JSON');

// ── 5. 64-hex (view key) → refused ────────────────────────────────
throws(
	'assertNoSecretHex on a 64-hex string',
	() => assertNoSecretHex('prefix ' + 'a'.repeat(64) + ' suffix'),
	'secret key'
);

// ── 5b. a hash_manifest over the indexer's 4096-byte per-field
//        JSONB cap is now rejected up front by validateReleasePayload
//        (schema cap lowered from 64 KB to match the handler). This is
//        the EXACT failure that reached the chain on 1.0.0 and got
//        filed valid=false → /v1/release not_found. ──
const bigManifest: Record<string, string> = {};
for (let i = 0; i < 120; i++) {
	bigManifest[`/_app/immutable/nodes/${i}.CFakeHash00000${i}.js`] =
		'sha256-' + 'A'.repeat(43) + '=';
}
const manifestBytes = new TextEncoder().encode(JSON.stringify(bigManifest)).length;
if (manifestBytes > 4096)
	ok(`oversized manifest fixture is ${manifestBytes} bytes — over the 4096 per-field cap`);
else bad('oversized manifest fixture is not over 4096', String(manifestBytes));
throws(
	'manifest over the 4096 per-field cap → rejected before broadcast',
	() =>
		buildReleaseCustomJsonOp(JSON.stringify({ ...JSON.parse(VALID), hash_manifest: bigManifest })),
	'hash_manifest_too_large'
);
// a normal (small) payload stays under the whole-op chain limit and builds
const okSized = buildReleaseCustomJsonOp(VALID);
if (new TextEncoder().encode(okSized.json).length < BLURT_CUSTOM_JSON_MAX_BYTES)
	ok('a normal (small) payload stays under the 8192-byte chain limit and builds');
else bad('normal payload unexpectedly over the limit', '');

// ── 6. real payload (SRI base64) passes the hex guard ─────────────
try {
	assertNoSecretHex(VALID);
	ok('real payload (SRI base64) passes the secret-hex guard (no false positive)');
} catch (e) {
	bad('real payload wrongly flagged as secret hex', e instanceof Error ? e.message : String(e));
}

// ── 7. invalid signer name → refused ──────────────────────────────
throws('invalid signer name', () => buildReleaseCustomJsonOp(VALID, 'BadName!!'), 'invalid signer');

// ── 8-11. CLI safety static guards ────────────────────────────────
const cli = readFileSync(join(REPO, 'apps/indexer/scripts/release-broadcast.ts'), 'utf-8');
if (cli.includes("from '../src/blurt/releaseBroadcastOp.ts'"))
	ok('CLI builds the op via the pure, tested module');
else bad('CLI no longer uses the pure op-builder module', 'validation/guard could drift');

// dry-run must exit BEFORE the key prompt (askHidden).
const dryIdx = cli.indexOf('if (dryRun)');
const askIdx = cli.indexOf('askHidden(');
if (dryIdx !== -1 && askIdx !== -1 && dryIdx < askIdx)
	ok('--dry-run exits before any key is requested');
else bad('--dry-run no longer precedes the key prompt', 'dry-run could leak into the key path');

if (cli.includes('_writeToOutput') && /askHidden/.test(cli))
	ok('posting key is read via a masked prompt (echo suppressed)');
else bad('posting key prompt is no longer masked', 'WIF could echo to the screen');

if (
	!/writeFileSync\([^)]*wif/i.test(cli) &&
	!/console\.log\([^)]*wif/i.test(cli) &&
	!/process\.env\.[A-Z_]*WIF/.test(cli)
)
	ok('posting key is never written to disk, logged, or read from an env var');
else bad('posting key may be persisted/logged/env-sourced', 'key-handling regression');

if (cli.includes('LAPTOP ONLY')) ok('CLI carries the LAPTOP-ONLY warning banner');
else bad('LAPTOP-ONLY banner removed', 'operator might run it on the server with the posting key');

// ── the four laptop broadcasters at a real terminal ──
// Each runs under a pseudo-terminal (util-linux `script`); the stand-in answers
// each prompt only after it appears. The typed WIF must never come back in the
// terminal output, and the snapshot broadcasters must not ask for a key at all
// unless --broadcast is given. The last answer always declines, so nothing is
// ever sent.
{
	const { spawn, spawnSync } = await import('node:child_process');
	const { mkdtempSync, writeFileSync: wfs } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { PrivateKey } = await import('@beblurt/dblurt');
	const WIF = PrivateKey.fromSeed('release-broadcast-smoke: never typed for real').toString();
	const dir = mkdtempSync(join(tmpdir(), 'bcast-pty-'));
	const CID = 'bafybeih4awqlztezkzdm57qyycnskxpmmokdxrbadmk6hdobr6vup5lbk4';
	const files: Record<string, string> = {
		'release.json': VALID,
		'chain.json': JSON.stringify({
			ipfs_cid: CID,
			sha256: 'a'.repeat(64),
			block_height: 1,
			size_bytes: 1,
			blurtd_version: '0.1.5'
		}),
		'indexer.json': JSON.stringify({
			ipfs_cid: CID,
			sha256: 'a'.repeat(64),
			chain_id: 'BLURT',
			schema_version: 1,
			last_applied_block: 1,
			size_bytes: 1,
			indexer_version: '1.0.0'
		})
	};
	for (const [n, t] of Object.entries(files)) wfs(join(dir, n), t);
	const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
	const haveScript = spawnSync('script', ['--version']).status === 0;

	/** Run under a pty; answer [prompt-regex, answer] pairs in order. */
	const drive = (
		args: string[],
		steps: Array<[RegExp, string]>
	): Promise<{ out: string; asked: number }> =>
		new Promise((resolveRun) => {
			const cmd = [TSX, '--tsconfig', join(REPO, 'tsconfig.smoke.json'), ...args]
				.map((a) => `'${a}'`)
				.join(' ');
			const p = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: join(HERE, '..') });
			let out = '';
			let step = 0;
			let seen = 0;
			const kill = setTimeout(() => p.kill('SIGKILL'), 60_000);
			p.stdout.on('data', (c: Buffer) => {
				out += c.toString();
				const next = steps[step];
				if (next && next[0].test(out.slice(seen))) {
					seen = out.length;
					step++;
					setTimeout(() => p.stdin.write(`${next[1]}\n`), 400);
				}
			});
			p.on('close', () => {
				clearTimeout(kill);
				resolveRun({ out, asked: step });
			});
		});
	const KEY = /WIF|private posting key|key>/i;
	const cases: Array<[string, string[], Array<[RegExp, string]>]> = [
		[
			'release-broadcast',
			['scripts/release-broadcast.ts', join(dir, 'release.json')],
			[
				[/signer account name/, 'morphit'],
				[KEY, WIF],
				[/yes/, 'no']
			]
		],
		[
			'rpc-directory-broadcast',
			['scripts/rpc-directory-broadcast.ts'],
			[
				[/signer account name|confirm/i, 'morphit'],
				[KEY, WIF],
				[/yes/, 'no']
			]
		],
		[
			'chain-snapshot-broadcast',
			['scripts/chain-snapshot-broadcast.ts', join(dir, 'chain.json'), '--broadcast'],
			[
				[KEY, WIF],
				[/yes/, 'no']
			]
		],
		[
			'indexer-snapshot-broadcast',
			['scripts/indexer-snapshot-broadcast.ts', join(dir, 'indexer.json'), '--broadcast'],
			[
				[KEY, WIF],
				[/yes/, 'no']
			]
		]
	];
	if (!haveScript) bad('pty checks', 'util-linux `script` is not installed');
	else {
		for (const [name, args, steps] of cases) {
			const r = await drive(args, steps);
			if (r.asked < 2)
				bad(`${name}: the key prompt was not reached at a terminal`, r.out.slice(-300));
			else if (r.out.includes(WIF))
				bad(`${name}: the typed WIF appeared in the terminal output`, 'echoed');
			else ok(`${name}: the typed WIF never appears on the terminal`);
		}
		for (const [name, file] of [
			['chain-snapshot-broadcast', 'chain.json'],
			['indexer-snapshot-broadcast', 'indexer.json']
		] as const) {
			const r = await drive([`scripts/${name}.ts`, join(dir, file)], [[KEY, WIF]]);
			if (r.asked === 0 && /DRY RUN/.test(r.out))
				ok(`${name}: without --broadcast it is a dry run (no key asked)`);
			else bad(`${name}: asked for a key without --broadcast`, r.out.slice(-200));
		}
		const snap = readFileSync(join(HERE, 'indexer-snapshot-broadcast.ts'), 'utf8');
		if (!/process\.env\.[A-Z_]*WIF/.test(snap))
			ok('indexer-snapshot-broadcast reads no key from the environment');
		else
			bad(
				'indexer-snapshot-broadcast reads a key from the environment',
				'visible in /proc/<pid>/environ'
			);
	}
}

// The pin scripts print the laptop commands that follow them. The snapshot
// broadcasters only dry-run unless --broadcast, so a script that shows
// the commands must show the real one WITH --broadcast — without it the
// "for real" step would only dry-run while the operator thinks it broadcast.
{
	const { readdirSync } = await import('node:fs');
	const opsDir = join(REPO, 'ops');
	const missing: string[] = [];
	for (const n of readdirSync(opsDir).filter((x) => x.endsWith('.sh'))) {
		const cmds = readFileSync(join(opsDir, n), 'utf8')
			.replace(/\\\n\s*/g, ' ')
			.split('\n')
			.filter((l) => !/^\s*#/.test(l) && /(?:chain|indexer)-snapshot-broadcast\.ts\s+\S/.test(l));
		if (cmds.length > 0 && !cmds.some((l) => /--broadcast\b/.test(l))) missing.push(`ops/${n}`);
	}
	if (missing.length === 0)
		ok(
			'every ops script that shows the snapshot-broadcast commands shows the real one with --broadcast'
		);
	else
		bad(
			'an ops script shows snapshot-broadcast commands but none with --broadcast (they would only dry-run)',
			missing.join(', ')
		);
}

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
