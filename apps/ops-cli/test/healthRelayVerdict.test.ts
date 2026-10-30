/**
 * `morphit-ops health` (menu: Node health), review 2026-10-29:
 *  - M13: the relay was judged by the INDEXER's rules — a relay whose balance
 *    had gone stale read "✓ up", one that could reach no RPC node read
 *    "answered, but not as the relay (unknown)", a low balance was never
 *    mentioned, and a relay that did not answer was "optional" (every signup
 *    and payment goes through it), with no command to look at it;
 *  - the indexer not answering ended "Start it (or check the systemd
 *    service)" — no command — and "(This view never needs sudo.)" while the
 *    same report says the settings need root (L7);
 *  - L6: the checks ran systemctl / openssl synchronously, so the spinner sat
 *    on its first frame for the whole wait.
 * Real HTTP servers stand in for the indexer and relay; a stand-in
 * `systemctl` / `openssl` on PATH plays the server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHealth } from '../src/commands/health.ts';

const servers: Server[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(body: unknown): Promise<number> {
	const s = createServer((q, r) => {
		r.setHeader('content-type', 'application/json');
		r.end(JSON.stringify(q.url?.startsWith('/v1/rpc-endpoints') ? { endpoints: [] } : body));
	});
	servers.push(s);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
	return (s.address() as AddressInfo).port;
}

const INDEXER = {
	status: 'ok',
	version: '1.21.17',
	indexed_block: 100,
	chain_head_block: 101,
	lag_blocks: 1,
	uptime_sec: 900,
	rpc_endpoints_healthy: 3,
	rpc_endpoints_total: 3
};
const RELAY = {
	status: 'ok',
	rpc_ok: true,
	version: '1.21.17',
	uptime_sec: 900,
	web_push: true,
	blurt_balance: '250.000 BLURT',
	rpc_endpoints_healthy: 3,
	rpc_endpoints_total: 3
};

/** PATH with stand-ins: `systemctl` answers `show` for every unit asked
 *  (morphit-relay in `relayState`) after `delay` seconds; `openssl` fails. */
function fakeHost(relayState: string, delay = 0): string {
	const bin = mkdtempSync(join(tmpdir(), 'morphit-fakehost-'));
	writeFileSync(
		join(bin, 'systemctl'),
		`#!/bin/sh\nsleep ${delay}\n` +
			'if [ "$1" = show ]; then shift; for u in "$@"; do case "$u" in -*) continue;; esac;\n' +
			`  if [ "$u" = morphit-relay.service ]; then st=${relayState}; else st=inactive; fi\n` +
			'  printf "Id=%s\\nLoadState=loaded\\nActiveState=%s\\nSubState=dead\\nResult=success\\n\\n" "$u" "$st"; done; exit 0; fi\n' +
			'echo inactive; exit 3\n'
	);
	writeFileSync(join(bin, 'openssl'), `#!/bin/sh\nsleep ${delay}\nexit 1\n`);
	for (const f of ['systemctl', 'openssl']) chmodSync(join(bin, f), 0o755);
	return `${bin}:${process.env.PATH ?? ''}`;
}

let out = '';
beforeEach(() => {
	out = '';
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.stubEnv('MORPHIT_INDEXER_LISTEN_HOST', '127.0.0.1');
	vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
	vi.stubEnv('MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_WARN', '100');
	vi.stubEnv('MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_ERROR', '30');
});

async function health(relay: unknown | null, relayState = 'active'): Promise<string> {
	vi.stubEnv('PATH', fakeHost(relayState));
	vi.stubEnv('MORPHIT_INDEXER_LISTEN_PORT', String(await serve(INDEXER)));
	vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', relay === null ? '1' : String(await serve(relay)));
	await runHealth({ flags: {}, positional: [], colorEnabled: false });
	return out.slice(out.indexOf('Relay'), out.indexOf('System'));
}

describe("health: the relay's own verdict", () => {
	it('a stale balance is not "✓ up"', async () => {
		const r = await health({ ...RELAY, stale: true });
		expect(r).toMatch(/⚠ up, but its BLURT balance is not current/);
		expect(r).not.toMatch(/✓ up/);
	});

	it('no RPC node reachable: said as such, not "not as the relay"', async () => {
		const r = await health({ ...RELAY, rpc_ok: false, rpc_endpoints_healthy: 0 });
		expect(r).toMatch(/✗ up, but it cannot reach any Blurt RPC node/);
		expect(r).not.toMatch(/not as the relay/);
	});

	it('a low balance is flagged', async () => {
		const r = await health({ ...RELAY, blurt_balance: '12.000 BLURT' });
		expect(r).toMatch(/up, but its BLURT balance is low/);
		expect(r).toMatch(/12\.000 BLURT is running low/);
	});

	it('not answering, its service failed: the exact commands, and never "optional"', async () => {
		const r = await health(null, 'failed');
		expect(r).toMatch(/✗ not answering/);
		expect(r).toContain('sudo journalctl -u morphit-relay -e --no-pager');
		expect(r).toContain('sudo systemctl restart morphit-relay');
		expect(r).not.toMatch(/optional/);
	});
});

describe('health: which account a low relay balance is topped up on', () => {
	/** A server root whose env files are `files` (path → text; null: a file
	 *  this user cannot read), with no relay account in the CLI's own env. */
	function serverRoot(files: Record<string, string | null>): void {
		const root = mkdtempSync(join(tmpdir(), 'morphit-relayacct-'));
		for (const [rel, text] of Object.entries(files)) {
			const p = join(root, rel);
			mkdirSync(join(p, '..'), { recursive: true });
			// A directory where the file should be: reading it fails, as a
			// root-only file does for a user without sudo.
			if (text === null) mkdirSync(p);
			else writeFileSync(p, text);
		}
		vi.stubEnv('MORPHIT_ENV_ROOT', root);
		for (const k of [
			'MORPHIT_RELAY_ACCOUNT',
			'MORPHIT_OPS_RELAY_ACCOUNT',
			'MORPHIT_INDEXER_RELAY_ACCOUNT'
		])
			vi.stubEnv(k, '');
	}
	const LOW = { ...RELAY, blurt_balance: '12.000 BLURT', account_creation_fee_blurt: 10 };

	it("names the account the relay's own env file sets", async () => {
		serverRoot({ 'etc/morphit/relay.env': 'MORPHIT_RELAY_ACCOUNT=alice-relay\n' });
		const r = await health(LOW);
		expect(r).toContain('Send BLURT to @alice-relay.');
	});

	it('the last file the relay reads wins', async () => {
		serverRoot({
			'opt/morphit/morphit.env': 'MORPHIT_RELAY_ACCOUNT=bob-old\n',
			'etc/morphit/relay.env': 'MORPHIT_RELAY_ACCOUNT="alice-relay"\n'
		});
		expect(await health(LOW)).toContain('Send BLURT to @alice-relay.');
	});

	it('without sudo (its files unreadable) it names no account, and says how to see it', async () => {
		serverRoot({
			'opt/morphit/morphit.env': 'MORPHIT_RELAY_ACCOUNT=bob-old\n',
			'etc/morphit/relay.env': null
		});
		expect(existsSync(join(process.env.MORPHIT_ENV_ROOT ?? '', 'etc/morphit/relay.env'))).toBe(
			true
		);
		const r = await health(LOW);
		expect(r).toContain(
			"Send BLURT to this node's relay account (on this server, sudo morphit-ops status shows it)."
		);
		expect(r).not.toMatch(/Send BLURT to @/);
	});

	it("nothing sets it anywhere: no account named (never morphit.io's relay)", async () => {
		serverRoot({});
		const r = await health(LOW);
		expect(r).toMatch(/running low|below one signup's fee/);
		expect(r).not.toMatch(/@morphit-relay|Send BLURT to @/);
		expect(r).toContain("this node's relay account");
	});

	it('the CLI env names it when the files do not', async () => {
		serverRoot({});
		vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'carol-relay');
		expect(await health(LOW)).toContain('Send BLURT to @carol-relay.');
	});
});

describe("health: the relay's key against the chain (its active_key check)", () => {
	const KEY = 'BLT6exampleexampleexampleexampleexampleexampleexample';
	it('mismatch: a ✗ problem in plain words, then the exact fix commands in order', async () => {
		const r = await health({
			...RELAY,
			active_key: { state: 'mismatch', public_key: KEY, found_as: 'posting' }
		});
		expect(r).toMatch(
			/✗ up, but the relay's key file is not the account's active key on the chain: signups and payouts are paused/
		);
		expect(r).toMatch(/posting key/);
		const show = r.indexOf('sudo morphit-ops show-key');
		const edit = r.indexOf('sudo morphit-ops edit-active-key');
		const restart = r.indexOf('sudo systemctl restart morphit-relay');
		expect(show).toBeGreaterThan(-1);
		expect(edit).toBeGreaterThan(show);
		expect(restart).toBeGreaterThan(edit);
		expect(r).toMatch(/on this server/);
		expect(r).not.toMatch(/✓ up/);
	});

	it('no such account: says so, and the fix is the account name — never edit-active-key', async () => {
		const r = await health({
			...RELAY,
			active_key: { state: 'mismatch', public_key: KEY, no_account: true, account: 'alice-relai' }
		});
		expect(r).toMatch(
			/✗ up, but the relay's account @alice-relai does not exist on the Blurt chain/
		);
		expect(r).toContain('MORPHIT_RELAY_ACCOUNT=');
		expect(r).toContain('sudo systemctl restart morphit-relay');
		expect(r).not.toMatch(/edit-active-key|show-key/);
	});

	it('a low balance names the account the relay itself reports', async () => {
		vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'bob-other');
		const r = await health({
			...RELAY,
			blurt_balance: '12.000 BLURT',
			active_key: { state: 'ok', public_key: KEY, account: 'alice-relay' }
		});
		expect(r).toContain('Send BLURT to @alice-relay.');
	});

	it('mismatch while no RPC node answers: both are said', async () => {
		const r = await health({
			...RELAY,
			rpc_ok: false,
			active_key: { state: 'mismatch', public_key: KEY }
		});
		expect(r).toMatch(/✗ up, but the relay's key file is not the account's active key/);
		expect(r).toMatch(/it cannot reach any Blurt RPC node/);
	});

	it.each(['unknown', 'unchecked', 'ok'])(
		'%s is not a problem: no ✗, no fix commands',
		async (state) => {
			const r = await health({
				...RELAY,
				active_key: { state, public_key: KEY, why: 'the Blurt RPC nodes could not be asked' }
			});
			expect(r).toMatch(/✓ up/);
			expect(r).not.toMatch(/✗/);
			expect(r).not.toMatch(/edit-active-key|signups and payouts are paused/);
		}
	);

	it('--json carries the state', async () => {
		vi.stubEnv('PATH', fakeHost('active'));
		vi.stubEnv('MORPHIT_INDEXER_LISTEN_PORT', String(await serve(INDEXER)));
		vi.stubEnv(
			'MORPHIT_RELAY_LISTEN_PORT',
			String(await serve({ ...RELAY, active_key: { state: 'mismatch', public_key: KEY } }))
		);
		await runHealth({ flags: { json: 'true' }, positional: [], colorEnabled: false });
		const j = JSON.parse(out.slice(out.indexOf('{'))) as { relay: { active_key: unknown } };
		expect(j.relay.active_key).toBe('mismatch');
	});
});

describe('health --json: relay.up keeps its v1.21.17 meaning', () => {
	async function json(relay: unknown): Promise<{ outcome: string; up: boolean }> {
		vi.stubEnv('PATH', fakeHost('active'));
		vi.stubEnv('MORPHIT_INDEXER_LISTEN_PORT', String(await serve(INDEXER)));
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', String(await serve(relay)));
		await runHealth({ flags: { json: 'true' }, positional: [], colorEnabled: false });
		return (JSON.parse(out.slice(out.indexOf('{'))) as { relay: { outcome: string; up: boolean } })
			.relay;
	}
	it('no RPC node reachable: up is false (it was then), the outcome says degraded', async () => {
		const r = await json({ ...RELAY, rpc_ok: false, rpc_endpoints_healthy: 0 });
		expect(r).toMatchObject({ outcome: 'degraded', up: false });
	});
	it('a low or stale balance: still up, as before; the outcome says degraded', async () => {
		expect(await json({ ...RELAY, blurt_balance: '12.000 BLURT' })).toMatchObject({
			outcome: 'degraded',
			up: true
		});
		out = '';
		expect(await json({ ...RELAY, stale: true })).toMatchObject({ outcome: 'degraded', up: true });
		out = '';
		expect(await json(RELAY)).toMatchObject({ outcome: 'up', up: true });
	});
});

describe('health: the indexer not answering', () => {
	it('gives the exact command, and no "never needs sudo"', async () => {
		vi.stubEnv('PATH', fakeHost('active'));
		vi.stubEnv('MORPHIT_INDEXER_LISTEN_PORT', '1');
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', '1');
		await runHealth({ flags: {}, positional: [], colorEnabled: false });
		expect(out).toContain('sudo systemctl status morphit-indexer');
		expect(out).not.toMatch(/never needs sudo/);
		expect(out).not.toMatch(/Start it \(or check the systemd service\)/);
	});
});

describe('health: the spinner turns while systemd answers', () => {
	// Deterministic: the stand-in systemctl's one `show` of every unit (the
	// report's systemd question) does not return until the test has SEEN the
	// spinner draw new frames while it waits. A report that asks systemd
	// synchronously blocks the event loop: no frame can be drawn, nothing
	// releases it, and it gives up on its own (after a bound) and says so.
	it('draws new frames while systemctl has not answered yet', async () => {
		const bin = mkdtempSync(join(tmpdir(), 'morphit-slowsysd-'));
		const started = join(bin, 'started');
		const release = join(bin, 'release');
		const gaveUp = join(bin, 'gave-up');
		writeFileSync(
			join(bin, 'systemctl'),
			'#!/bin/sh\n' +
				'if [ "$1" = show ] && [ $# -gt 5 ]; then\n' +
				`  : > '${started}'; n=0\n` +
				`  while [ ! -e '${release}' ]; do n=$((n+1)); if [ $n -gt 100 ]; then : > '${gaveUp}'; break; fi; sleep 0.05; done\n` +
				'fi\n' +
				'if [ "$1" = show ]; then shift; for u in "$@"; do case "$u" in -*) continue;; esac;\n' +
				'  printf "Id=%s\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\n\\n" "$u"; done; exit 0; fi\n' +
				'echo inactive; exit 3\n'
		);
		writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nexit 1\n');
		for (const f of ['systemctl', 'openssl']) chmodSync(join(bin, f), 0o755);
		vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
		vi.stubEnv('MORPHIT_INDEXER_LISTEN_PORT', String(await serve(INDEXER)));
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', String(await serve(RELAY)));
		let framesWhileWaiting = 0;
		vi.mocked(process.stdout.write).mockImplementation((c: unknown) => {
			const t = String(c);
			out += t;
			if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Generating/.test(t) && existsSync(started) && !existsSync(release)) {
				framesWhileWaiting += 1;
				if (framesWhileWaiting >= 3) writeFileSync(release, '');
			}
			return true;
		});
		const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		try {
			await runHealth({ flags: {}, positional: [], colorEnabled: false });
		} finally {
			if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
		expect(existsSync(started)).toBe(true);
		expect(existsSync(gaveUp)).toBe(false);
		expect(framesWhileWaiting).toBeGreaterThanOrEqual(3);
	}, 60_000);
});
