/**
 * /pgp_keys.asc: every fresh build carried
 * morphit.io's canary key, and the install summary marked it ✓ as if it were
 * the operator's. Now fresh builds carry no key (the operator's own key is
 * installed by the canary refresh), ✓ needs a key that is not morphit.io's,
 * and the upgrade says so when an instance still serves morphit.io's.
 */
import { describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	UPSTREAM_CANARY_KEY_FPR,
	armoredKeyFingerprints,
	collectInstallSummary,
	type SummaryProbe
} from '../src/init/installSummary.ts';

/** morphit.io's canary key, as earlier releases shipped it in apps/web/static. */
const UPSTREAM_KEY = new URL('./fixtures/upstream-canary-key.asc', import.meta.url).pathname;
const WEB_STATIC = new URL('../../web/static', import.meta.url).pathname;
const haveGpg = spawnSync('gpg', ['--version']).status === 0;

function probe(fprs: string[] | null): SummaryProbe {
	return {
		serviceActive: () => true,
		failedUnits: () => [],
		containerRunning: () => true,
		firewallActive: () => true,
		pathExists: () => true,
		readText: () => null,
		indexerHealth: async () => ({ reachable: true, synced: true, rpcOk: true, fxOk: true }),
		relayReachable: async () => true,
		relayBalanceBlurt: async () => 100,
		systemHealth: () => ({ ok: true }) as never,
		pgpFingerprints: () => fprs
	};
}
const keyRow = async (fprs: string[] | null) => {
	const rows = await collectInstallSummary(
		{ domain: 'trade.example.com', mode: 'vps', torOnly: false } as never,
		probe(fprs)
	);
	return rows.find((r) => r.label.startsWith('PGP contact key'))!;
};

describe('the PGP contact key row', () => {
	it("morphit.io's canary key is not ✓", async () => {
		const r = await keyRow([UPSTREAM_CANARY_KEY_FPR]);
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/morphit\.io's canary key/);
	});
	it("the operator's own key is ✓", async () => {
		expect((await keyRow(['A'.repeat(40)])).ok).toBe(true);
	});
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? filesUnder(p) : [p];
	});
}

describe('fresh builds', () => {
	it('serve no PGP key: nothing in apps/web/static is one', () => {
		const keys = filesUnder(WEB_STATIC).filter((f) =>
			readFileSync(f).includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')
		);
		expect(keys).toEqual([]);
	});
});

describe.skipIf(!haveGpg)('the upstream key and the upgrade warning', () => {
	it('the fixture is morphit.io’s canary key (what earlier fresh builds served)', () => {
		expect(armoredKeyFingerprints(UPSTREAM_KEY)).toContain(UPSTREAM_CANARY_KEY_FPR);
	});
	it('the upgrade warns when a build still serves it', async () => {
		const { warnUpstreamCanaryKey } = (await import('../src/commands/upgrade.ts')) as {
			warnUpstreamCanaryKey: (d: string) => void;
		};
		const d = mkdtempSync(join(tmpdir(), 'canarykey-'));
		copyFileSync(UPSTREAM_KEY, join(d, 'pgp_keys.asc'));
		let err = '';
		vi.spyOn(process.stderr, 'write').mockImplementation(
			(c: unknown) => ((err += String(c)), true)
		);
		warnUpstreamCanaryKey(d);
		expect(err).toMatch(/morphit\.io's canary key/);
	});
});
