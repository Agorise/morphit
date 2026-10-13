/**
 * `register` (by hand, or queued by the install for first-online) lists a
 * Tor-only node under its onion when the origin setting is empty — the menu's
 * "Set up a Tor / Lokinet / I2P address" is enough to list it (2026-10-12
 * review). The real command, stopped at the key it cannot load.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { runRegister } from '../src/commands/register.ts';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it('an empty origin and a saved onion: it is listed under http://<onion>', async () => {
	const onion = `${'a'.repeat(56)}.onion`;
	vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'vigil-relay');
	vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', '/nonexistent/keystore');
	vi.stubEnv('MORPHIT_INSTANCE_NAME', 'Vigilante Trading');
	vi.stubEnv('MORPHIT_INSTANCE_ORIGIN', '');
	vi.stubEnv('MORPHIT_INSTANCE_TOR_ADDRESS', onion);
	vi.stubEnv('MORPHIT_INSTANCE_OPERATOR_TAG', 'vigilantetrading');
	// The local indexer's registration check: not reachable here.
	vi.stubEnv('MORPHIT_INDEXER_URL', 'http://127.0.0.1:9');
	const out: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	const rc = await runRegister({ flags: { 'non-interactive': 'true' }, positional: [] });
	expect(out.join('\n')).toContain(`Origin:       http://${onion}`);
	expect(rc).toBe(1); // stopped at the key it cannot load, nothing published
}, 60_000);
