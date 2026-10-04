/**
 * The doctor judges the relay keystore by the rule the relay applies at boot
 * (apps/relay/src/config/keystorePerms.ts): owner-only 0400/0600, or
 * root:morphit-relay 0440/0640 — the shape the installer and the relay's
 * pre-start helper set. It used to warn on that shape (any group bit).
 */
import { describe, it, expect } from 'vitest';
import { keyFilePermissionFinding } from '../src/commands/doctor.ts';

const RELAY_GID = 990;
const f = (mode: number, uid: number, gid: number, relayGid: number | null = RELAY_GID) =>
	keyFilePermissionFinding(
		{ mode: 0o100000 | mode, uid, gid },
		relayGid,
		'/etc/morphit/relay-active.key'
	);

describe('doctor: active key permissions', () => {
	it('accepts what the relay accepts', () => {
		expect(f(0o640, 0, RELAY_GID).level).toBe('ok');
		expect(f(0o440, 0, RELAY_GID).level).toBe('ok');
		expect(f(0o600, 0, 0).level).toBe('ok');
		expect(f(0o400, 1001, 1001).level).toBe('ok');
	});
	it('warns on what the relay refuses, naming the fix', () => {
		for (const [mode, uid, gid] of [
			[0o644, 0, RELAY_GID], // others can read
			[0o660, 0, RELAY_GID], // group may write
			[0o640, 1001, RELAY_GID], // group-readable, not owned by root
			[0o640, 0, 4242] // group-readable by another group
		] as const) {
			const r = f(mode, uid, gid);
			expect(r.level, `0${mode.toString(8)} ${uid}:${gid}`).toBe('warn');
			expect(r.detail).toMatch(/chown root:morphit-relay .* && chmod 0640/);
		}
		expect(f(0o640, 0, RELAY_GID, null).level).toBe('warn');
		expect(f(0o640, 0, RELAY_GID, null).detail).toMatch(/chmod 0600/);
	});
});
