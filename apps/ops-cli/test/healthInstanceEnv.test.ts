/**
 * `morphit-ops health` shows the addresses this instance is configured with.
 *
 * It read them from the process environment but never loaded the instance's
 * config file, so on every installed node it printed no "Reachable at" rows and
 * told the operator "No hidden address yet" — while the .onion and .b32.i2p
 * were configured and serving (2026-10-12, a fresh VPS).
 *
 * The real CLI runs here from a stand-in install folder holding only a config.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../../', import.meta.url).pathname;
const ONION = 'a'.repeat(56) + '.onion';

describe('health', () => {
	it('lists the configured clearnet and Tor addresses under Addresses', () => {
		const root = mkdtempSync(join(tmpdir(), 'morphit-health-env-'));
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 'x', private: true, workspaces: [] })
		);
		writeFileSync(
			join(root, 'morphit.config.env'),
			`MORPHIT_INSTANCE_ORIGIN=https://vigilante.trading\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION}\n`
		);
		const env = { ...process.env };
		delete env.MORPHIT_INSTANCE_ORIGIN;
		delete env.MORPHIT_INSTANCE_TOR_ADDRESS;
		const r = spawnSync(
			join(REPO, 'node_modules/.bin/tsx'),
			[
				'--tsconfig',
				join(REPO, 'tsconfig.smoke.json'),
				join(REPO, 'apps/ops-cli/src/main.ts'),
				'health',
				'--no-color'
			],
			{ cwd: root, env, encoding: 'utf8', timeout: 120_000 }
		);
		const out = `${r.stdout}${r.stderr}`;
		const rows = out.slice(out.indexOf('Addresses'));
		expect(out).toContain('Addresses');
		expect(rows).toMatch(/Clearnet\s+https:\/\/vigilante\.trading/);
		expect(rows).toMatch(new RegExp(`Tor\\s+${ONION}`));
		// Configured, so never the "no hidden address" nudge.
		expect(out).not.toMatch(/No hidden address yet/);
	}, 150_000);
});

describe('the addresses section', () => {
	const I2P = 'b'.repeat(52) + '.b32.i2p';
	const env = {
		MORPHIT_INSTANCE_ORIGIN: 'https://vigilante.trading',
		MORPHIT_INSTANCE_TOR_ADDRESS: ONION,
		MORPHIT_INSTANCE_I2P_B32_ADDRESS: I2P
	};

	it('names each address and whether the service behind it is running', async () => {
		const { instanceAddresses } = await import('../src/commands/health.ts');
		const rows = instanceAddresses(env, (u) => (u === 'tor' ? 'active' : 'failed'));
		expect(rows).toEqual([
			{ label: 'Clearnet', address: 'https://vigilante.trading', state: 'ok' },
			{ label: 'Tor', address: ONION, state: 'ok' },
			{ label: 'I2P', address: I2P, state: 'down' }
		]);
	});

	it('a service systemd cannot be asked about is unknown, not down', async () => {
		const { instanceAddresses } = await import('../src/commands/health.ts');
		const rows = instanceAddresses(env, () => 'unknown');
		expect(rows.find((r) => r.label === 'Tor')?.state).toBe('unknown');
	});

	it('a daemon still starting is "starting", not down', async () => {
		const { instanceAddresses } = await import('../src/commands/health.ts');
		expect(instanceAddresses(env, () => 'activating').find((r) => r.label === 'I2P')?.state).toBe(
			'starting'
		);
	});

	it('a Tor-only node\u2019s onion origin is not listed as clearnet', async () => {
		const { instanceAddresses } = await import('../src/commands/health.ts');
		const rows = instanceAddresses(
			{ ...env, MORPHIT_INSTANCE_ORIGIN: `http://${ONION}` },
			() => 'active'
		);
		expect(rows.some((r) => r.label === 'Clearnet')).toBe(false);
		expect(rows.find((r) => r.label === 'Tor')?.address).toBe(ONION);
	});

	it('says when a Tor or I2P address was never created', async () => {
		const { instanceAddresses } = await import('../src/commands/health.ts');
		const rows = instanceAddresses({ MORPHIT_INSTANCE_ORIGIN: 'https://x.org' }, () => 'active');
		expect(rows.find((r) => r.label === 'Tor')).toEqual({
			label: 'Tor',
			address: null,
			state: 'none'
		});
		expect(rows.find((r) => r.label === 'I2P')).toEqual({
			label: 'I2P',
			address: null,
			state: 'none'
		});
	});
});
