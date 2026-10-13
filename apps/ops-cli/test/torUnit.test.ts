/**
 * Health and the install review check the Tor DAEMON (review, 2026-10-12): on
 * Ubuntu `tor.service` is a placeholder that stays "active" while the real
 * daemon, tor@default, is dead — the .onion showed ✓ with Tor down.
 */
import { describe, expect, it, vi } from 'vitest';

const units: Record<string, { load: string; active: string }> = {
	'tor.service': { load: 'loaded', active: 'active' }, // the placeholder
	tor: { load: 'loaded', active: 'active' },
	'tor@default.service': { load: 'loaded', active: 'failed' },
	'tor@default': { load: 'loaded', active: 'failed' }
};
vi.mock('node:child_process', async (orig) => {
	const real = (await orig()) as typeof import('node:child_process');
	const show = (args: readonly string[]): string => {
		const unit = args.find((a) => /^tor/.test(a)) ?? '';
		const u = units[unit] ?? { load: 'not-found', active: 'inactive' };
		if (args.includes('--value')) return `${u.load}\n`;
		return `ActiveState=${u.active}\nLoadState=${u.load}\nSubState=dead\n`;
	};
	const out = {
		...real,
		execFileSync: ((cmd: string, args: readonly string[]) =>
			cmd === 'systemctl' && args[0] === 'show'
				? show(args)
				: real.execFileSync(cmd, args as string[])) as typeof real.execFileSync,
		spawnSync: ((cmd: string, args: readonly string[], opts: unknown) =>
			cmd === 'systemctl'
				? {
						status: 0,
						stdout:
							args[0] === 'show'
								? show(args)
								: `${(units[args[1] ?? ''] ?? { active: 'inactive' }).active}\n`,
						stderr: ''
					}
				: real.spawnSync(cmd, args as string[], opts as never)) as typeof real.spawnSync
	};
	return { ...out, default: out };
});

describe('the Tor daemon unit', () => {
	it('tor@default where systemd has it, tor elsewhere', async () => {
		const { torDaemonUnit } = await import('../src/lib/torUnit.ts');
		expect(torDaemonUnit(() => 'loaded')).toBe('tor@default');
		expect(torDaemonUnit(() => 'not-found')).toBe('tor');
		expect(torDaemonUnit(() => '')).toBe('tor');
	});

	it('health: a dead daemon behind an "active" placeholder is not ✓', async () => {
		const { checkService } = await import('../src/commands/health.ts');
		expect(checkService('tor')).toBe('failed');
	});

	it('the install review: the same', async () => {
		const { realProbe } = await import('../src/init/installSummary.ts');
		expect(realProbe().serviceActive('tor')).toBe(false);
	});
});
