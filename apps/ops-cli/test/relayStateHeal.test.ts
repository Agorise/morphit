/**
 * v1.20.1 — the relay could not enter /var/lib/morphit (morphit:morphit 0750,
 * relay = root WITHOUT capabilities) on any live box, and morphitir's relay sat
 * stopped for three days because the upgrade only restarts running services.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	RELAY_STATE_DIR,
	healRelayStateDir,
	startIfEnabledButStopped,
	type UnitRuntime
} from '../src/lib/relayStateHeal.ts';

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const box = (legacy: Record<string, string> | null): string => {
	const r = mkdtempSync(join(tmpdir(), 'relaystate-'));
	roots.push(r);
	mkdirSync(join(r, 'var/lib/morphit'), { recursive: true });
	if (legacy) {
		mkdirSync(join(r, 'var/lib/morphit/relay'));
		for (const [n, c] of Object.entries(legacy))
			writeFileSync(join(r, 'var/lib/morphit/relay', n), c);
	}
	return r;
};

describe('healRelayStateDir', () => {
	it('an operator’s SIGNUPS_DISABLED moves with the state — paused sign-ups stay paused', () => {
		const r = box({
			SIGNUPS_DISABLED: '',
			'signup-ceiling.json': '{"day":"2026-09-30","count":3}'
		});
		const logs: string[] = [];
		const out = healRelayStateDir(r, (m) => logs.push(m));
		expect(out).toEqual({
			kind: 'linked',
			moved: expect.arrayContaining(['SIGNUPS_DISABLED', 'signup-ceiling.json'])
		});
		expect(existsSync(join(r, RELAY_STATE_DIR, 'SIGNUPS_DISABLED'))).toBe(true);
		expect(readFileSync(join(r, RELAY_STATE_DIR, 'signup-ceiling.json'), 'utf8')).toContain(
			'"count":3'
		);
		expect(logs.join(' ')).toMatch(/sign-ups stay paused/);
		// the documented old path still leads there
		const old = join(r, 'var/lib/morphit/relay');
		expect(lstatSync(old).isSymbolicLink()).toBe(true);
		expect(readlinkSync(old)).toBe(RELAY_STATE_DIR);
		expect(lstatSync(join(r, RELAY_STATE_DIR)).mode & 0o777).toBe(0o700);
	});
	it('the empty v1.20.0 directory (what the live boxes have) becomes the link; a second run changes nothing', () => {
		const r = box({});
		expect(healRelayStateDir(r).kind).toBe('linked');
		expect(healRelayStateDir(r)).toEqual({ kind: 'already' });
	});
	it('no old directory at all: the link is still made for the documented path', () => {
		const r = box(null);
		expect(healRelayStateDir(r).kind).toBe('linked');
		expect(readlinkSync(join(r, 'var/lib/morphit/relay'))).toBe(RELAY_STATE_DIR);
	});
	it('a file already in the new directory is the live one; the old copy is kept aside, not lost', () => {
		const r = box({ 'signup-ceiling.json': 'old' });
		mkdirSync(join(r, RELAY_STATE_DIR), { recursive: true });
		writeFileSync(join(r, RELAY_STATE_DIR, 'signup-ceiling.json'), 'new');
		healRelayStateDir(r);
		expect(readFileSync(join(r, RELAY_STATE_DIR, 'signup-ceiling.json'), 'utf8')).toBe('new');
		expect(readFileSync(join(r, RELAY_STATE_DIR, 'signup-ceiling.json.from-v1.20.0'), 'utf8')).toBe(
			'old'
		);
	});
	it('a box without /var/lib/morphit is not touched', () => {
		const r = mkdtempSync(join(tmpdir(), 'relaystate-'));
		roots.push(r);
		expect(healRelayStateDir(r)).toEqual({ kind: 'no-morphit-dir' });
		expect(existsSync(join(r, RELAY_STATE_DIR))).toBe(false);
	});
	it('an operator’s own link elsewhere is left alone', () => {
		const r = box(null);
		symlinkSync('/srv/relay', join(r, 'var/lib/morphit/relay'));
		expect(healRelayStateDir(r).kind).toBe('left-alone');
	});
});

const units = (states: { active: string[]; enabled: string; startOk?: boolean }) => {
	const calls: string[][] = [];
	const rt: UnitRuntime = {
		systemctl: (a) => {
			calls.push([...a]);
			if (a[0] === 'is-active') return { status: 0, out: states.active.shift() ?? 'inactive' };
			if (a[0] === 'is-enabled') return { status: 0, out: states.enabled };
			if (a[0] === 'start') return { status: states.startOk === false ? 1 : 0, out: '' };
			return { status: 0, out: '' };
		},
		sleep: () => {}
	};
	return { rt, calls };
};

describe('startIfEnabledButStopped', () => {
	it('morphitir: enabled + inactive → started and checked', () => {
		const u = units({ active: ['inactive', 'active'], enabled: 'enabled' });
		const logs: string[] = [];
		expect(
			startIfEnabledButStopped(
				'morphit-relay.service',
				(m) => logs.push(m),
				() => {},
				u.rt
			)
		).toBe('started');
		expect(u.calls).toContainEqual(['start', 'morphit-relay.service']);
		expect(logs.join(' ')).toMatch(/enabled but was not running/);
	});
	it('a running relay is left alone', () => {
		const u = units({ active: ['active'], enabled: 'enabled' });
		expect(
			startIfEnabledButStopped(
				'morphit-relay.service',
				() => {},
				() => {},
				u.rt
			)
		).toBe('running');
		expect(u.calls.some((c) => c[0] === 'start')).toBe(false);
	});
	it('a disabled relay (the operator turned it off) is never started', () => {
		const u = units({ active: ['inactive'], enabled: 'disabled' });
		expect(
			startIfEnabledButStopped(
				'morphit-relay.service',
				() => {},
				() => {},
				u.rt
			)
		).toBe('not-enabled');
		expect(u.calls.some((c) => c[0] === 'start')).toBe(false);
	});
	it('one that does not stay up is reported, with where to look', () => {
		const u = units({ active: ['failed', 'failed'], enabled: 'enabled' });
		const warns: string[] = [];
		expect(
			startIfEnabledButStopped(
				'morphit-relay.service',
				() => {},
				(m) => warns.push(m),
				u.rt
			)
		).toBe('failed');
		expect(warns.join(' ')).toMatch(/journalctl -u morphit-relay.service/);
	});
});
