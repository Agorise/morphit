/**
 * The publish job's last word when it pinned a snapshot but did not anchor it
 * (anchoring is a step on the operator's laptop). It printed
 * `scp -O root@<this-node>:…`: a placeholder for the operator to fill in, and
 * on morphit.io the step went undone for weeks while new nodes fast-synced from
 * a 21-day-old snapshot (v1.21.17 audit, M4). It now names this server, says
 * the commands run on the laptop, and why it matters. The real script runs with
 * stand-ins for curl, tsx and the pin script.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './helpers/pty.ts';

function publish(
	configLine: string,
	o: { hostnameLog?: string; onRaw?: (raw: string, bin: string) => void } = {}
): string {
	const w = mkdtempSync(join(tmpdir(), 'autopub-log-'));
	try {
		const bin = join(w, 'bin');
		const repo = join(w, 'repo');
		const out = join(w, 'out');
		for (const d of [bin, join(repo, 'node_modules', '.bin'), join(repo, 'ops'), out])
			mkdirSync(d, { recursive: true });
		const sh = (p: string, body: string): void => {
			writeFileSync(p, `#!/bin/sh\n${body}\n`);
			chmodSync(p, 0o755);
		};
		sh(join(bin, 'curl'), `echo '{"status":"ok","indexed_block":100,"sync":{"behind":false}}'`);
		// A stand-in hostname that says how it was asked.
		if (o.hostnameLog !== undefined)
			sh(join(bin, 'hostname'), `echo "hostname $*" >> '${o.hostnameLog}'\necho node1`);
		sh(
			join(repo, 'node_modules', '.bin', 'tsx'),
			`f="${out}/morphit-indexer-snapshot-64889180-x.tar.gz"; : > "$f"; echo "$f"`
		);
		const payload = join(out, 'indexer-snapshot-payload-64889180.json');
		writeFileSync(
			join(repo, 'ops', 'pin-indexer-snapshot.sh'),
			`: > "${payload}"; echo "MORPHIT_SNAPSHOT_PAYLOAD=${payload}"\n`
		);
		writeFileSync(join(repo, 'morphit.config.env'), `${configLine}\n`);
		writeFileSync(join(w, 'indexer.env'), 'MORPHIT_INDEXER_DATABASE_URL=postgres://x\n');
		const r = spawnSync('bash', [join(REPO, 'ops', 'snapshot-autopublish.sh')], {
			encoding: 'utf8',
			timeout: 60_000,
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				MORPHIT_REPO_PATH: repo,
				MORPHIT_INDEXER_ENV: join(w, 'indexer.env'),
				MORPHIT_SNAPSHOT_OUT: out,
				MORPHIT_SNAPSHOT_SIGNING_KEY_FILE: join(w, 'none.wif')
			}
		});
		o.onRaw?.(`${r.stdout ?? ''}${r.stderr ?? ''}`, bin);
		return `${r.stdout ?? ''}${r.stderr ?? ''}`.replaceAll(out, '<OUT>');
	} finally {
		rmSync(w, { recursive: true, force: true });
	}
}

describe('a pinned, unanchored snapshot', () => {
	// The hardening step turns root login off (PermitRootLogin no) once a
	// non-root login with an SSH key exists; then `scp root@…` cannot work.
	it('also gives the copy for a server that refuses root logins, and its server step works', () => {
		let ran = '';
		const t = publish('MORPHIT_INSTANCE_ORIGIN="https://example.org"', {
			onRaw: (raw, bin) => {
				const cmd = raw.match(/on this server: {2}(sudo install -m 0644 \S+ \/tmp\/)$/m)?.[1];
				expect(cmd).toBeDefined();
				// Run it as printed (a stand-in sudo that runs the command: tests run as root).
				writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
				const r = spawnSync('sh', ['-c', cmd!], {
					encoding: 'utf8',
					env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
				});
				expect(r.status).toBe(0);
				const copied = '/tmp/indexer-snapshot-payload-64889180.json';
				try {
					ran = (statSync(copied).mode & 0o777).toString(8);
				} finally {
					rmSync(copied, { force: true });
				}
			}
		});
		expect(t).toMatch(
			/If this server refuses root logins \(PermitRootLogin no\), copy the payload in two steps/
		);
		expect(t).toContain(
			'on this server:  sudo install -m 0644 <OUT>/indexer-snapshot-payload-64889180.json /tmp/'
		);
		expect(t).toContain(
			'on your laptop:  scp -O <your-login>@example.org:/tmp/indexer-snapshot-payload-64889180.json .'
		);
		// Readable by the operator's own login, which then copies it.
		expect(ran).toBe('644');
	});

	// v1.21.18 audit, L6: `hostname -f` asks DNS for this server's full name
	// (a clearnet lookup on a zero-clearnet node). The plain name is enough.
	it('with no origin setting: this server’s own name, without a DNS lookup (`hostname`, not `hostname -f`)', () => {
		const d = mkdtempSync(join(tmpdir(), 'autopub-host-'));
		try {
			const log = join(d, 'hostname.log');
			const t = publish('# no origin', { hostnameLog: log });
			expect(t).toContain('scp -O root@node1:<OUT>/indexer-snapshot-payload-64889180.json .');
			const asked = readFileSync(log, 'utf8');
			expect(asked).toMatch(/^hostname $/m);
			expect(asked).not.toMatch(/-f|--fqdn|--long/);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
	it('names this server and the laptop, with the exact commands', () => {
		const t = publish('MORPHIT_INSTANCE_ORIGIN="https://example.org"');
		expect(t).not.toContain('<this-node>');
		expect(t).toMatch(/NOT anchored on chain yet\. Anchoring is a step on your laptop/);
		expect(t).toMatch(/new nodes fast-sync from the last anchored snapshot/);
		expect(t).toMatch(/On your laptop, in your Morphit folder:/);
		expect(t).toContain('scp -O root@example.org:<OUT>/indexer-snapshot-payload-64889180.json .');
		expect(t).toContain(
			'node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts indexer-snapshot-payload-64889180.json --broadcast'
		);
	});
});

/** The pin script's own "next: broadcast from your laptop" block printed the
 *  same `root@<this-node>` placeholder; its host lookup is run here as written. */
describe('pin-indexer-snapshot.sh names this server too', () => {
	const pinHostLookup = (files: Record<string, string>): string => {
		const { readFileSync } = require('node:fs') as typeof import('node:fs');
		const src = readFileSync(join(REPO, 'ops', 'pin-indexer-snapshot.sh'), 'utf8');
		const start = src.indexOf('_HOST=""');
		const end = src.indexOf('[ -n "$_HOST" ] ||', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const snippet = src.slice(start, src.indexOf('\n', end));
		const w = mkdtempSync(join(tmpdir(), 'pin-host-'));
		try {
			mkdirSync(join(w, 'ops'));
			for (const [name, body] of Object.entries(files)) writeFileSync(join(w, name), body);
			const r = spawnSync(
				'bash',
				['-c', `${snippet}\nprintf '%s' "$_HOST"`, join(w, 'ops', 'pin-indexer-snapshot.sh')],
				{ encoding: 'utf8', env: { ...process.env, _idxenv: join(w, 'indexer.env') } }
			);
			return r.stdout;
		} finally {
			rmSync(w, { recursive: true, force: true });
		}
	};

	it('uses the origin setting', () => {
		expect(
			pinHostLookup({
				'morphit.config.env': 'MORPHIT_INSTANCE_ORIGIN="https://node.example.org"\n'
			})
		).toBe('node.example.org');
	});
	it('with no origin setting: `hostname`, never `hostname -f` (a DNS lookup)', () => {
		const w = mkdtempSync(join(tmpdir(), 'pin-hostname-'));
		try {
			const bin = join(w, 'bin');
			mkdirSync(bin);
			const log = join(w, 'hostname.log');
			writeFileSync(
				join(bin, 'hostname'),
				`#!/bin/sh\necho "hostname $*" >> '${log}'\necho node1\n`,
				{
					mode: 0o755
				}
			);
			const src = readFileSync(join(REPO, 'ops', 'pin-indexer-snapshot.sh'), 'utf8');
			const start = src.indexOf('_HOST=""');
			const end = src.indexOf('[ -n "$_HOST" ] ||', start);
			const snippet = src.slice(start, src.indexOf('\n', end));
			mkdirSync(join(w, 'ops'));
			const r = spawnSync(
				'bash',
				['-c', `${snippet}\nprintf '%s' "$_HOST"`, join(w, 'ops', 'pin-indexer-snapshot.sh')],
				{
					encoding: 'utf8',
					env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, _idxenv: join(w, 'none.env') }
				}
			);
			expect(r.stdout).toBe('node1');
			expect(readFileSync(log, 'utf8')).toMatch(/^hostname $/m);
			expect(readFileSync(log, 'utf8')).not.toMatch(/-f/);
		} finally {
			rmSync(w, { recursive: true, force: true });
		}
	});
	it('the script has no placeholder left', () => {
		const { readFileSync } = require('node:fs') as typeof import('node:fs');
		expect(readFileSync(join(REPO, 'ops', 'pin-indexer-snapshot.sh'), 'utf8')).not.toContain(
			'<this-node>'
		);
	});
});
