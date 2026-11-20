/**
 * v1.24.7: a server installs a new release by itself early in the morning only when the
 * release record it VERIFIED marks a security release (or the admin chose
 * "all"); the mark is read from the signed transaction, never trusted from an
 * answer. lib/autoInstallRelease.ts and lib/releaseAnchor.ts.
 */
import { describe, expect, it } from 'vitest';
import {
	AUTO_INSTALL_EXIT,
	decideAutoInstall,
	decisionOutput,
	healAutoInstall,
	type AutoInstallHealRuntime,
	type AutoInstallRuntime
} from '../src/lib/autoInstallRelease.ts';
import { readSignedReleaseAnchor, type ReleaseAnchorResult } from '../src/lib/releaseAnchor.ts';
import { isNewerRelease } from '../src/commands/upgrade.ts';
import {
	CHAIN_ID,
	OFFICIAL_PUB,
	OTHER,
	fixtureReader,
	signedRelease
} from './helpers/releaseChain.ts';

const DIST = { source_sha256: 'a'.repeat(64), gpg_fingerprint: 'c'.repeat(40) };
const ARGS = { tag: 'v1.24.8', signer: 'morphit', pinnedPubkey: OFFICIAL_PUB, chainId: CHAIN_ID };
const verified = (extra?: Record<string, unknown>, key?: typeof OTHER) =>
	readSignedReleaseAnchor(
		fixtureReader(
			signedRelease('1.24.8', DIST, { ...(extra ? { extra } : {}), ...(key ? { key } : {}) })
		),
		ARGS
	);

describe('the security mark is read from the verified record only', () => {
	it('"security": true in the signed record → security', async () => {
		const r = await verified({ security: true });
		expect(r.ok && r.anchor.security).toBe(true);
	});
	it('absent, false, or anything that is not the boolean true → not security', async () => {
		for (const extra of [
			undefined,
			{ security: false },
			{ security: 'true' },
			{ security: 1 },
			{ security: { yes: true } }
		]) {
			const r = await verified(extra);
			expect(r.ok, JSON.stringify(extra)).toBe(true);
			expect(r.ok && r.anchor.security, JSON.stringify(extra)).toBe(false);
		}
	});
	it('a record marked security but signed by another key is not a record at all', async () => {
		expect((await verified({ security: true }, OTHER)).ok).toBe(false);
	});
});

const anchorOk = (security: boolean): ReleaseAnchorResult => ({
	ok: true,
	anchor: {
		version: '1.24.8',
		sourceSha256: 'a'.repeat(64),
		offlineSha256: null,
		ipfsCid: null,
		ipnsName: null,
		gpgFingerprint: null,
		security,
		blockNum: 1,
		trxId: 'f'.repeat(40)
	}
});
function rt(o: Partial<AutoInstallRuntime> & { anchorResult?: ReleaseAnchorResult } = {}) {
	const asked: string[] = [];
	const r: AutoInstallRuntime = {
		mode: () => 'security',
		current: () => 'v1.24.7',
		latest: async () => 'v1.24.8',
		anchor: async (t) => (asked.push(t), o.anchorResult ?? anchorOk(true)),
		isNewer: isNewerRelease,
		...o
	};
	return { r, asked };
}

describe('decideAutoInstall', () => {
	it('a newer release marked security, in the default mode: install it, after reading its verified record', async () => {
		const { r, asked } = rt();
		expect(await decideAutoInstall(r)).toEqual({
			action: 'install',
			from: 'v1.24.7',
			to: 'v1.24.8',
			security: true
		});
		expect(asked).toEqual(['v1.24.8']);
	});
	it('a newer release not marked security: it waits for the admin, and says how to install every release', async () => {
		const d = await decideAutoInstall(rt({ anchorResult: anchorOk(false) }).r);
		expect(d.action).toBe('none');
		expect(d.action === 'none' && d.why).toMatch(
			/^v1\.24\.8 is not marked as a security release, so it waits for you \(sudo morphit-ops, option 2\); MORPHIT_AUTO_INSTALL_RELEASES=all in \/etc\/morphit\/updates\.env installs every release$/
		);
	});
	it('"all": any newer release, without reading the record (the upgrade itself verifies it)', async () => {
		const { r, asked } = rt({ mode: () => 'all' });
		expect(await decideAutoInstall(r)).toEqual({
			action: 'install',
			from: 'v1.24.7',
			to: 'v1.24.8',
			security: false
		});
		expect(asked).toEqual([]);
	});
	it('"off": nothing, nothing read', async () => {
		const { r, asked } = rt({ mode: () => 'off' });
		const d = await decideAutoInstall(r);
		expect(d.action).toBe('none');
		expect(asked).toEqual([]);
	});
	it('up to date, an older on-chain release, no indexer answer, no installed release: nothing', async () => {
		for (const o of [
			{ latest: async () => 'v1.24.7' },
			{ latest: async () => 'v1.24.6' },
			{ latest: async () => null },
			{ current: () => null }
		] as Array<Partial<AutoInstallRuntime>>) {
			const { r, asked } = rt(o);
			expect((await decideAutoInstall(r)).action).toBe('none');
			expect(asked).toEqual([]);
		}
	});
	it('a record not readable yet (not listed, no source answered): nothing now, asked again the next morning', async () => {
		for (const res of [
			{
				ok: false,
				reason: '@morphit has published no release record for v1.24.8',
				notListed: true
			},
			{ ok: false, reason: 'could not read the history', unreadable: true }
		] as ReleaseAnchorResult[]) {
			const d = await decideAutoInstall(rt({ anchorResult: res }).r);
			expect(d.action).toBe('none');
			expect(d.action === 'none' && d.why).toMatch(
				/could not be read yet .*the next run asks again$/
			);
		}
	});
	it('a record that FAILED its check (another key, no valid hash): refused, said, never installed', async () => {
		const d = await decideAutoInstall(
			rt({
				anchorResult: {
					ok: false,
					reason: "the release record in block 9 is not signed by @morphit's pinned posting key"
				}
			}).r
		);
		expect(d).toEqual({
			action: 'refused',
			why: "the on-chain release record for v1.24.8 did not pass its check: the release record in block 9 is not signed by @morphit's pinned posting key"
		});
	});
	it('the script reads one line of JSON and an exit code per decision', () => {
		expect(AUTO_INSTALL_EXIT).toEqual({ none: 0, install: 10, refused: 11 });
		const o = decisionOutput({ action: 'install', from: 'v1.24.7', to: 'v1.24.8', security: true });
		expect(o).toEqual({
			json: '{"action":"install","from":"v1.24.7","to":"v1.24.8","security":true}',
			code: 10
		});
		expect(o.json).not.toContain('\n');
	});
});

function heal(o: Partial<AutoInstallHealRuntime> = {}) {
	const r: AutoInstallHealRuntime = {
		install: () => ({ ok: true, written: [], timerRunning: true }),
		scriptReady: () => true,
		decide: async () => ({ action: 'none', why: 'v1.24.7 is the newest release' }),
		mode: () => 'security',
		...o
	};
	return healAutoInstall({ info: () => {}, warn: () => {}, spinner: () => () => {} }, r);
}

describe('healAutoInstall', () => {
	it('first time: the timer turned on and the check asked once, said in one line', async () => {
		const r = await heal({
			install: () => ({
				ok: true,
				written: ['morphit-auto-install.service', 'morphit-auto-install.timer'],
				timerRunning: true
			})
		});
		expect(r).toMatchObject({ strategy: 'installed', verified: true, routine: false });
		expect(r.detail).toBe(
			"Automatic release installs: a new Morphit release marked as a security release installs itself early in the morning (05:15–06:00 by the server's clock), checked against @morphit's on-chain record first and rolled back if a step fails; other releases wait for you (the timer is on, checked). Asked now: v1.24.7 is the newest release."
		);
	});
	it('later upgrades with nothing to install: counted quietly', async () => {
		expect(await heal()).toMatchObject({ strategy: 'already', routine: true });
	});
	it('a release waiting to install at the next early-morning check is said', async () => {
		const r = await heal({
			decide: async () => ({ action: 'install', from: 'v1.24.7', to: 'v1.24.8', security: true })
		});
		expect(r.routine).toBe(false);
		expect(r.detail).toMatch(
			/Asked now: v1\.24\.8 will be installed at the next early-morning check \(a security release\)\.$/
		);
	});
	it('a record that failed its check is a warning, with the command', async () => {
		const r = await heal({
			decide: async () => ({
				action: 'refused',
				why: 'the on-chain release record for v1.24.8 did not pass its check: x'
			})
		});
		expect(r.verified).toBe(false);
		expect(r.detail).toContain(
			'nothing will be installed from it. On this server: sudo morphit-ops upgrade --check-only'
		);
	});
	it('the timer that will not turn on, or the script missing: said, never claimed on', async () => {
		const a = await heal({
			install: () => ({
				ok: false,
				written: [],
				timerRunning: false,
				detail: 'morphit-auto-install.timer is not enabled and not active'
			})
		});
		expect(a.verified).toBe(false);
		expect(a.detail).toContain('sudo systemctl enable --now morphit-auto-install.timer');
		const b = await heal({ scriptReady: () => false });
		expect(b.verified).toBe(false);
		expect(b.detail).toContain(
			'morphit-auto-install.sh is missing from this install or not executable'
		);
	});
	it('"off" and "all" are said as the admin set them', async () => {
		expect((await heal({ mode: () => 'off' })).detail).toContain(
			'off (MORPHIT_AUTO_INSTALL_RELEASES=off in /etc/morphit/updates.env): new releases wait for you'
		);
		expect((await heal({ mode: () => 'all' })).detail).toContain(
			'every new Morphit release installs itself early in the morning'
		);
	});
});
