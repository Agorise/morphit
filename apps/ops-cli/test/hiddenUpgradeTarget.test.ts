/**
 * v1.20.3 — what a zero-clearnet upgrade needs from the on-chain release before
 * it fetches anything. v1.20.2 was broadcast with a CID but without the IPNS
 * name, and morphitlat refused it ("no source_sha256 / ipns_name") although
 * the CID alone was enough: the CID is tried first, and the SHA-256 decides.
 */
import { describe, expect, it } from 'vitest';

import { hiddenReleaseTargetProblem } from '../src/init/hiddenUpgradeResolve.ts';
import { hiddenReleaseUrls } from '../src/init/hiddenUpgradeFetch.ts';

const SHA = 'c8f6ec8b1cfe6a322cf9640bd83879076c5bdd7c0c2245347589e3ecb2372bc1';
const CID = 'bafybeiegfyir3zryt3iosz7ysxikcki4vwtui35ykd4uf55zp4ww5uctki';
const IPNS = 'k51qzi5uqu5dgkxmhwchxq4f9yiggxqyine7ang3xdz1ohmwc8csya1sqtcicf';

describe('a zero-clearnet upgrade target', () => {
	it('SHA-256 + CID is enough (the v1.20.2 broadcast), as is SHA-256 + IPNS name, or all three', () => {
		expect(hiddenReleaseTargetProblem(SHA, '', CID)).toBeNull();
		expect(hiddenReleaseTargetProblem(SHA, IPNS, '')).toBeNull();
		expect(hiddenReleaseTargetProblem(SHA, IPNS, CID)).toBeNull();
	});
	it('no SHA-256, or neither a CID nor a name: refused (fail-closed)', () => {
		expect(hiddenReleaseTargetProblem('', IPNS, CID)).toMatch(/source_sha256/);
		expect(hiddenReleaseTargetProblem('nothex', IPNS, CID)).toMatch(/source_sha256/);
		expect(hiddenReleaseTargetProblem(SHA, '', '')).toMatch(/ipfs_cid|ipns_name/);
		expect(hiddenReleaseTargetProblem(SHA, '', 'not-a-cid')).toMatch(/ipfs_cid|ipns_name/);
	});
	it('without a name, the peers are asked for the CID only (no /ipns// URL)', () => {
		const urls = hiddenReleaseUrls('http://peer.onion', {
			ipnsName: '',
			ipfsCid: CID,
			expectedSha256: SHA,
			version: '1.20.2',
			path: 'morphit-latest.tar.gz'
		});
		expect(urls).toEqual([`http://peer.onion/ipfs/${CID}/morphit-latest.tar.gz`]);
	});
});
