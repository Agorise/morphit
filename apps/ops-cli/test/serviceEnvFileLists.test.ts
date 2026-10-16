/**
 * Every list of "the files a unit sources" must be the unit's own list.
 *
 * The indexer and relay units source their env files in a shell loop in
 * ExecStart (last assignment wins). Five other places keep a copy of that
 * list — the permission helper systemd runs before start, and four heals that
 * read or rewrite settings as the service will see them. A copy that misses a
 * file reads a setting the service does not have, or misses one it has; when
 * the relay began sourcing /etc/morphit/relay-notify.env (Settings → Offline
 * Notifications), only one of the four was pinned to the unit. Now all are,
 * for both services, in order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICES as PRIVILEGE_SERVICES } from '../src/lib/unitPrivilegeHeal.ts';
import { SERVICES as HIDDEN_RPC_SERVICES } from '../src/lib/hiddenRpcEnvHeal.ts';
import { relayEnvFiles } from '../src/lib/relayHealthEnvHeal.ts';
import { INDEXER_ENV_FILES, RELAY_ENV_FILES } from '../src/lib/relayHiddenHeal.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** The `for f in …; do` list of a unit's ExecStart. */
function unitList(unit: string): string[] {
	const text = readFileSync(join(REPO, 'ops/systemd', unit), 'utf8');
	const exec = text.split('\n').find((l) => l.startsWith('ExecStart='));
	const m = exec ? /for f in ([^;]+); do/.exec(exec) : null;
	if (!m) throw new Error(`${unit}: no "for f in …; do" in ExecStart`);
	return m[1]!.trim().split(/\s+/);
}

/** The permission helper's list for a role: FILES, then RELAY_ONLY if any. */
function permsList(role: 'indexer' | 'relay'): string[] {
	const text = readFileSync(join(REPO, 'ops/scripts/morphit-service-perms.sh'), 'utf8');
	const block = new RegExp(`\\n\\t${role}\\)\\n([\\s\\S]*?);;`).exec(text)?.[1] ?? '';
	const arr = (name: string): string[] =>
		(new RegExp(`${name}=\\(([^)]*)\\)`).exec(block)?.[1] ?? '')
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	return [...arr('FILES'), ...arr('RELAY_ONLY')];
}

describe('the env files each unit sources, everywhere they are listed', () => {
	const relay = unitList('morphit-relay.service');
	const indexer = unitList('morphit-indexer.service');

	it('the relay unit sources the offline-notice file, last', () => {
		expect(relay.at(-1)).toBe('/etc/morphit/relay-notify.env');
	});

	it('relay: the permission helper, and every heal', () => {
		expect(permsList('relay')).toEqual(relay);
		expect(PRIVILEGE_SERVICES.find((s) => s.role === 'relay')?.envFiles).toEqual(relay);
		expect(HIDDEN_RPC_SERVICES('').find((s) => s.unit === 'morphit-relay')?.files).toEqual(relay);
		expect(relayEnvFiles('')).toEqual(relay);
		expect(RELAY_ENV_FILES).toEqual(relay);
	});

	it('indexer: the permission helper, and every heal', () => {
		expect(permsList('indexer')).toEqual(indexer);
		expect(PRIVILEGE_SERVICES.find((s) => s.role === 'indexer')?.envFiles).toEqual(indexer);
		expect(HIDDEN_RPC_SERVICES('').find((s) => s.unit === 'morphit-indexer')?.files).toEqual(
			indexer
		);
		expect(INDEXER_ENV_FILES).toEqual(indexer);
	});
});
