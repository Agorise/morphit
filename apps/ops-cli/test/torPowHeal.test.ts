/**
 * The onion proof-of-work heal: where the option goes in a torrc (the
 * Ansible-managed block and a hand-written one), that an operator's own
 * setting is kept, and the heal's decisions. When MORPHIT_TEST_TOR names a
 * tor binary, the result is also checked with that real Tor's
 * `--verify-config` (Tor refuses an option in the wrong place or unknown).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { healTorPow, withPow, type PowRuntime } from '../src/lib/torPowHeal.ts';

const ANSIBLE = `## Debian torrc
#SocksPort 9050
# BEGIN MORPHIT HIDDEN SERVICE (managed by Ansible)
HiddenServiceDir /var/lib/tor/morphit
HiddenServicePort 80 127.0.0.1:8090
# END MORPHIT HIDDEN SERVICE (managed by Ansible)
`;
const TWO = `SocksPort 9050
HiddenServiceDir /var/lib/tor/ssh
HiddenServicePort 22 127.0.0.1:22
HiddenServiceDir /var/lib/tor/web
HiddenServicePort 80 127.0.0.1:8090
HiddenServicePort 443 127.0.0.1:8443
Log notice syslog
`;

describe('Tor proof-of-work for the onion service', () => {
	it('the Ansible block gets it right after its port line, once', () => {
		const w = withPow(ANSIBLE);
		expect(w.added).toBe(1);
		expect(w.text).toContain(
			'HiddenServicePort 80 127.0.0.1:8090\nHiddenServicePoWDefensesEnabled 1\n# END MORPHIT'
		);
		expect(withPow(w.text).added).toBe(0);
	});

	it('only the port-80 service of several, after its LAST port line; an operator 0 is kept', () => {
		const w = withPow(TWO);
		expect(w.added).toBe(1);
		expect(w.text).toContain(
			'HiddenServicePort 443 127.0.0.1:8443\nHiddenServicePoWDefensesEnabled 1\nLog notice'
		);
		expect(w.text).not.toContain('HiddenServicePort 22 127.0.0.1:22\nHiddenServicePoW');
		expect(
			withPow(ANSIBLE.replace('8090\n', '8090\nHiddenServicePoWDefensesEnabled 0\n')).added
		).toBe(0);
	});

	const TOR = process.env.MORPHIT_TEST_TOR;
	it.skipIf(!TOR)(
		'a real Tor accepts the result (and refuses the option outside a service)',
		() => {
			const d = mkdtempSync(join(tmpdir(), 'pow-'));
			for (const s of ['ssh', 'web', 'data']) mkdirSync(join(d, s), { mode: 0o700 });
			const conf = `DataDirectory ${d}/data\n${withPow(TWO)
				.text.replace(/\/var\/lib\/tor/g, d)
				.replace('SocksPort 9050', 'SocksPort 0')}`;
			writeFileSync(join(d, 'torrc'), conf);
			expect(spawnSync(TOR!, ['--verify-config', '-f', join(d, 'torrc')]).status).toBe(0);
			writeFileSync(
				join(d, 'torrc'),
				`DataDirectory ${d}/data\nSocksPort 0\nHiddenServicePoWDefensesEnabled 1\n`
			);
			expect(spawnSync(TOR!, ['--verify-config', '-f', join(d, 'torrc')]).status).not.toBe(0);
			rmSync(d, { recursive: true, force: true });
		}
	);

	class Box {
		torrc: string | null = ANSIBLE;
		pow = true;
		valid = true;
		active = true;
		readonly rt: PowRuntime = {
			readTorrc: () => this.torrc,
			writeTorrc: (t) => ((this.torrc = t), true),
			hasPowModule: () => this.pow,
			verifies: () => ({ ok: this.valid, out: this.valid ? '' : '[warn] Unknown option' }),
			reloadTor: () => true,
			torActive: () => this.active,
			sleep: async () => {}
		};
		run() {
			return healTorPow(
				{ info: () => {}, warn: () => {}, spinner: () => () => {} },
				{ runtime: this.rt }
			);
		}
	}
	it('heal: applied and read back; Tor without the module or refusing the file: unchanged', async () => {
		const a = new Box();
		expect(await a.run()).toMatchObject({ strategy: 'applied', verified: true });
		const b = new Box();
		b.pow = false;
		expect((await b.run()).strategy).toBe('skipped');
		expect(b.torrc).toBe(ANSIBLE);
		const c = new Box();
		c.valid = false;
		expect((await c.run()).verified).toBe(false);
		expect(c.torrc).toBe(ANSIBLE);
	});
	// v1.21.4 review: the Tor bridges repair (its timer can run during an
	// upgrade) writes the same file; neither may undo the other's write.
	it('heal: a torrc changed by something else after it was read is never written over', async () => {
		const b = new Box();
		const edited = `${ANSIBLE}# Tor bridges block written meanwhile\n`;
		let reads = 0;
		const read = b.rt.readTorrc;
		(b.rt as { readTorrc: () => string | null }).readTorrc = () => {
			if (reads++ === 1) b.torrc = edited;
			return read();
		};
		const r = await b.run();
		expect(b.torrc).toBe(edited);
		expect(r.verified).toBe(false);
	});
	it('heal: nor put back over a change made during its reload', async () => {
		const b = new Box();
		const edited = `${ANSIBLE}# Tor bridges block written meanwhile\n`;
		let reloads = 0;
		(b.rt as { reloadTor: () => boolean }).reloadTor = () => {
			if (reloads++ === 0) b.torrc = edited;
			return true;
		};
		await b.run();
		expect(b.torrc).toBe(edited);
	});
	it('heal: Tor not running after the reload → the previous torrc is put back', async () => {
		const b = new Box();
		b.active = false;
		expect((await b.run()).strategy).toBe('reverted');
		expect(b.torrc).toBe(ANSIBLE);
	});
});
