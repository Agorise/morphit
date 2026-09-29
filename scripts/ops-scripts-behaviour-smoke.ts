/**
 * ops-scripts-behaviour-smoke (v1.20.0 deep review: C4, C8, C9, C10, C11, C17).
 *
 * Runs the REAL ops scripts against stubbed tools in a scratch dir (never
 * against the host's services) and asserts what they DO:
 *
 *  C4  snapshot-autopublish.sh publishes only when the INDEXER says it is caught
 *      up. Its default health URL used to be :8080 — the relay — whose health
 *      has no sync block, so a lagging indexer was published.
 *  C9  the manual copy-down instructions it prints use `scp -O` (hardened boxes
 *      turn SFTP off), never plain scp.
 *  C8  pin-indexer-snapshot.sh on a hidden-only node (Kubo Routing.Type=none)
 *      makes no clearnet request (the ipfs.io probe) and no DHT provide.
 *  C17 morphit-ipfs-pin.sh on a hidden-only node does not sit in `pin add` for
 *      a release it cannot fetch (up to 900 s, every hour).
 *  C10 morphit-node-doctor.sh reads the indexer's real sync fields (it looked
 *      for a `sync_state` that does not exist) and never advises signing the
 *      canary on the server.
 *  C11 every shipped systemd unit passes `systemd-analyze verify` without an
 *      "unknown"/"ignoring" warning (the MCP unit's seccomp and start-limit
 *      lines were silently dropped).
 *
 * Scenarios needing root (node-doctor refuses to run without it) or
 * systemd-analyze are skipped, and say so, where those are unavailable.
 * MORPHIT_OPS_SCRIPTS_ROOT=<dir containing ops/> checks another tree.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MORPHIT_OPS_SCRIPTS_ROOT ?? REPO;
const OPS = join(ROOT, 'ops');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const isRoot = process.getuid?.() === 0;

function stub(bin: string, name: string, body: string): void {
	writeFileSync(join(bin, name), body);
	chmodSync(join(bin, name), 0o755);
}
/** Lines that tell the operator to run plain scp (no -O). */
const plainScp = (out: string): string[] =>
	out
		.split('\n')
		.filter(
			(l) => /(^|\s)scp\s/.test(l) && !/(^|\s)scp\s+(-\S*\s+)*-O\b/.test(l) && !/scp -O/.test(l)
		);

console.log('\n── ops-scripts-behaviour smoke ──────────────────────────\n');

// ── C4 + C9: snapshot-autopublish ──
{
	const RELAY_BODY =
		'{"status":"ok","rpc_endpoints_healthy":6,"rpc_endpoints_total":20,"hidden_only":false}';
	const idx = (behind: boolean) =>
		`{"status":"ok","indexed_block":100,"lag_blocks":${behind ? 900 : 2},"stale":${behind},"sync":{"behind":${behind}}}`;
	const run = (indexerBody: string, extraEnv: Record<string, string> = {}) => {
		const w = mkdtempSync(join(tmpdir(), 'morphit-autopub-'));
		try {
			const bin = join(w, 'bin');
			const repo = join(w, 'repo');
			const out = join(w, 'out');
			for (const d of [bin, join(repo, 'node_modules', '.bin'), join(repo, 'ops'), out])
				mkdirSync(d, { recursive: true });
			const calls = join(w, 'calls.log');
			writeFileSync(calls, '');
			// :8080 is the relay, :8081 the indexer — as on every Morphit box.
			stub(
				bin,
				'curl',
				`#!/bin/sh\necho "curl $*" >> "${calls}"\ncase "$*" in *:8080/*) echo '${RELAY_BODY}';; *:8081/*) echo '${indexerBody}';; *) exit 7;; esac\n`
			);
			stub(
				join(repo, 'node_modules', '.bin'),
				'tsx',
				`#!/bin/sh\necho "tsx $*" >> "${calls}"\nf="${out}/morphit-indexer-snapshot-1-x.tar.gz"; : > "$f"; echo "$f"\n`
			);
			writeFileSync(
				join(repo, 'ops', 'pin-indexer-snapshot.sh'),
				`echo "pin $*" >> "${calls}"; : > "${out}/p.json"; echo "MORPHIT_SNAPSHOT_PAYLOAD=${out}/p.json"\n`
			);
			writeFileSync(
				join(w, 'indexer.env'),
				'MORPHIT_INDEXER_DATABASE_URL=postgres://x/y\nMORPHIT_INDEXER_LISTEN_HOST=0.0.0.0\nMORPHIT_INDEXER_LISTEN_PORT=8081\n'
			);
			const r = spawnSync('bash', [join(OPS, 'snapshot-autopublish.sh')], {
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					MORPHIT_REPO_PATH: repo,
					MORPHIT_INDEXER_ENV: join(w, 'indexer.env'),
					MORPHIT_SNAPSHOT_OUT: out,
					...extraEnv
				}
			});
			return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls: readFileSync(calls, 'utf8') };
		} finally {
			rmSync(w, { recursive: true, force: true });
		}
	};
	let r = run(idx(true));
	check(
		'C4: autopublish asks the INDEXER (:8081) and skips while it is catching up',
		/:8081\/v1\/health/.test(r.calls) && !/tsx /.test(r.calls) && /catching up/.test(r.out),
		r.out.split('\n').slice(0, 2).join(' | ')
	);
	r = run(idx(false));
	check(
		'C4: autopublish proceeds once the indexer reports sync.behind=false',
		/tsx .*snapshot-export/.test(r.calls),
		r.out.split('\n').slice(0, 2).join(' | ')
	);
	check(
		'C9: the printed manual broadcast steps use scp -O, never plain scp',
		plainScp(r.out).length === 0 && /scp -O/.test(r.out),
		plainScp(r.out).join(' | ')
	);
	r = run(idx(false), { MORPHIT_HEALTH_URL: 'http://127.0.0.1:8080/v1/health' });
	check(
		'C4: a health body with no sync state (the relay’s) is not taken as "caught up"',
		!/tsx /.test(r.calls),
		r.out.split('\n').slice(0, 2).join(' | ')
	);
}

// ── C8 + C9: pin-indexer-snapshot on a hidden-only node ──
// Kubo "detection" (pgrep/ps/id) is stubbed to a stand-in process we start,
// the way ops/test/pin-indexer-snapshot-harness.sh does — no root, no host
// process ever looked at.
{
	const run = (routing: string) => {
		const w = mkdtempSync(join(tmpdir(), 'morphit-pis-'));
		const standIn = spawn('sleep', ['60'], {
			env: { ...process.env, IPFS_PATH: join(w, 'repo') },
			stdio: 'ignore'
		});
		try {
			const bin = join(w, 'bin');
			const tb = join(w, 'tb');
			mkdirSync(bin);
			mkdirSync(tb);
			mkdirSync(join(w, 'repo'));
			const calls = join(w, 'calls.log');
			writeFileSync(calls, '');
			spawnSync('sh', ['-c', `cd "${tb}" && echo "select 1;" | gzip > indexer.sql.gz`]);
			const sha = spawnSync('sh', ['-c', `sha256sum "${tb}/indexer.sql.gz" | cut -d' ' -f1`], {
				encoding: 'utf8'
			}).stdout.trim();
			writeFileSync(
				join(tb, 'manifest.json'),
				JSON.stringify({
					snapshotFormatVersion: 2,
					chainId: 'c'.repeat(64),
					schemaVersion: 42,
					lastAppliedBlock: 123456,
					dumpSha256: sha,
					indexerVersion: '1.20.0'
				})
			);
			spawnSync('tar', [
				'czf',
				join(w, 'snap.tar.gz'),
				'-C',
				tb,
				'manifest.json',
				'indexer.sql.gz'
			]);
			stub(
				bin,
				'ipfs',
				`#!/bin/sh\necho "ipfs $*" >> "${calls}"\ncase "$*" in\n "config Routing.Type") echo ${routing};;\n "config --json Experimental.FilestoreEnabled") echo true;;\n add*) echo bafyTESTCID;;\n "key list -l") echo "k51TEST indexer-snapshot";;\n "key list") echo indexer-snapshot;;\nesac\nexit 0\n`
			);
			stub(bin, 'curl', `#!/bin/sh\necho "CURL $*" >> "${calls}"\nexit 22\n`);
			stub(bin, 'pgrep', `#!/bin/sh\necho ${standIn.pid}\n`);
			stub(bin, 'ps', `#!/bin/sh\necho "$(id -un)"\n`);
			stub(
				bin,
				'id',
				`#!/bin/sh\ncase "$1" in -u) echo 0;; -un) whoami;; *) /usr/bin/id "$@";; esac\n`
			);
			stub(bin, 'chown', '#!/bin/sh\nexit 0\n');
			const r = spawnSync('bash', [join(OPS, 'pin-indexer-snapshot.sh'), join(w, 'snap.tar.gz')], {
				encoding: 'utf8',
				timeout: 120_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					MORPHIT_INDEXER_ENV: join(w, 'none.env'),
					HOME: w
				}
			});
			return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls: readFileSync(calls, 'utf8') };
		} finally {
			standIn.kill();
			rmSync(w, { recursive: true, force: true });
		}
	};
	let r = run('none');
	check(
		'C8: hidden-only publisher makes NO clearnet request (no ipfs.io probe)',
		/pinned as CID/.test(r.out) && !/CURL /.test(r.calls),
		r.calls
			.split('\n')
			.filter((l) => /CURL/.test(l))
			.join(' | ') || r.out.split('\n').slice(-3).join(' | ')
	);
	check(
		'C8: hidden-only publisher does not announce the CID on the public DHT',
		/pinned as CID/.test(r.out) && !/routing provide|dht provide/.test(r.calls),
		r.calls
			.split('\n')
			.filter((l) => /provide/.test(l))
			.join(' | ')
	);
	check(
		'C9: its copy-down instruction uses scp -O',
		plainScp(r.out).length === 0 && /scp -O/.test(r.out),
		plainScp(r.out).join(' | ')
	);
	r = run('auto');
	check(
		'control: a clearnet publisher still checks a public gateway (the recorder sees it)',
		/CURL .*ipfs\.io/.test(r.calls),
		r.calls.slice(0, 200)
	);
}

// ── C17: morphit-ipfs-pin.sh on a hidden-only node ──
{
	const run = (routing: string) => {
		const w = mkdtempSync(join(tmpdir(), 'morphit-pin-'));
		try {
			const bin = join(w, 'bin');
			mkdirSync(bin);
			const calls = join(w, 'calls.log');
			writeFileSync(calls, '');
			stub(
				bin,
				'curl',
				`#!/bin/sh\necho '{"version":"1.20.0","distribution":{"ipfs_cid":"bafyNEWRELEASE"}}'\n`
			);
			stub(
				bin,
				'ipfs',
				`#!/bin/sh\necho "ipfs $*" >> "${calls}"\ncase "$*" in\n "config Routing.Type") echo ${routing}; exit 0;;\n *"pin ls"*) exit 1;;\nesac\nexit 0\n`
			);
			const r = spawnSync('sh', [join(OPS, 'ipfs', 'morphit-ipfs-pin.sh')], {
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					IPFS_PATH: join(w, 'repo'),
					MORPHIT_RELEASE_URL: 'http://127.0.0.1:8081/v1/release'
				}
			});
			return {
				exit: r.status,
				out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
				calls: readFileSync(calls, 'utf8')
			};
		} finally {
			rmSync(w, { recursive: true, force: true });
		}
	};
	let r = run('none');
	check(
		'C17: a hidden-only node does not `pin add` a release it cannot fetch (exits 0 at once)',
		r.exit === 0 && !/pin add/.test(r.calls),
		`${r.out.trim().split('\n').pop()} | ${r.calls
			.split('\n')
			.filter((l) => /pin add/.test(l))
			.join(' ')}`
	);
	r = run('auto');
	check(
		'control: a normal node still pins the new release',
		/pin add .*bafyNEWRELEASE/.test(r.calls),
		r.calls.slice(0, 200)
	);
}

// ── C10: morphit-node-doctor.sh ──
if (!isRoot) {
	console.log('  (not root: the node-doctor scenarios are skipped — the script requires root)');
} else {
	const run = (behind: boolean) => {
		const w = mkdtempSync(join(tmpdir(), 'morphit-doctor-'));
		try {
			const bin = join(w, 'bin');
			mkdirSync(bin);
			mkdirSync(join(w, 'etc'));
			mkdirSync(join(w, 'repo', 'apps', 'web', 'build'), { recursive: true });
			writeFileSync(
				join(w, 'etc', 'indexer.env'),
				'MORPHIT_INDEXER_PUBLIC_ORIGIN=https://example.org\n'
			);
			const health = `{"status":"ok","version":"1.20.0","indexed_block":100,"lag_blocks":${behind ? 900 : 2},"stale":${behind},"sync":{"behind":${behind},"pct_complete":${behind ? 40 : 100}}}`;
			stub(
				bin,
				'curl',
				`#!/bin/sh\ncase "$*" in *rpc-endpoints*) echo '{"endpoints":[{"transport":"clearnet"}]}';; *v1/health*) echo '${health}';; esac\n`
			);
			stub(
				bin,
				'systemctl',
				'#!/bin/sh\ncase "$1" in is-active) exit 0;; show) echo 0;; *) exit 0;; esac\n'
			);
			stub(bin, 'ss', '#!/bin/sh\necho "LISTEN 0 1 127.0.0.1:9050 x"\n');
			stub(bin, 'pgrep', '#!/bin/sh\nexit 1\n');
			const r = spawnSync('bash', [join(OPS, 'morphit-node-doctor.sh')], {
				encoding: 'utf8',
				timeout: 120_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					MORPHIT_REPO: join(w, 'repo'),
					MORPHIT_ENVDIR: join(w, 'etc')
				}
			});
			return `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
		} finally {
			rmSync(w, { recursive: true, force: true });
		}
	};
	let out = run(false);
	check(
		'C10: node-doctor reports a caught-up indexer as synced',
		/indexer synced/.test(out),
		(out.match(/Sync status[\s\S]*?\n\n/) ?? [''])[0].replace(/\n/g, ' | ')
	);
	check(
		'C10: with no canary served it never advises setting one up on THIS box',
		!/this computer \/ home hosting/.test(out) && !/set one up/.test(out),
		(out.match(/Warrant canary[\s\S]*?\n\n/) ?? [''])[0].replace(/\n/g, ' | ')
	);
	out = run(true);
	check(
		'C10: node-doctor reports a lagging indexer as catching up',
		/catching up/.test(out),
		(out.match(/Sync status[\s\S]*?\n\n/) ?? [''])[0].replace(/\n/g, ' | ')
	);
}

// ── C11: systemd units ──
if (spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status !== 0) {
	console.log('  (systemd-analyze not installed here — the unit verification is skipped)');
} else {
	const dir = join(OPS, 'systemd');
	const units = readdirSync(dir).filter((f) => f.endsWith('.service'));
	const w = mkdtempSync(join(tmpdir(), 'morphit-units-'));
	try {
		const noisy: string[] = [];
		for (const u of units) {
			copyFileSync(join(dir, u), join(w, u));
			const r = spawnSync(
				'systemd-analyze',
				['verify', '--man=no', '--generators=no', join(w, u)],
				{
					encoding: 'utf8',
					timeout: 60_000,
					env: { ...process.env, SYSTEMD_LOG_LEVEL: 'warning' }
				}
			);
			const bad = `${r.stdout ?? ''}${r.stderr ?? ''}`
				.split('\n')
				.filter((l) =>
					/Unknown key name|is not known, ignoring|Unknown lvalue|Failed to parse|Invalid/.test(l)
				);
			if (bad.length) noisy.push(`${u}: ${bad.join(' / ')}`);
		}
		check(
			`C11: all ${units.length} shipped units verify with no ignored/unknown directive`,
			noisy.length === 0,
			noisy.join(' || ')
		);
	} finally {
		rmSync(w, { recursive: true, force: true });
	}
}

console.log(
	fail === 0
		? `\n✓ all ${pass} ops-scripts-behaviour checks passed`
		: `\n✗ ops-scripts-behaviour: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
