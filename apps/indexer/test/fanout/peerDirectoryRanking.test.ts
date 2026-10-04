/**
 * Directory peers are ranked by probe status, then origin — not by when a
 * probe last finished (A1 request), and the fee cross-check's peer
 * list keeps every registered address (not the Tor-only fan-out addressing).
 *
 * last_probed_at is stamped when a probe FINISHES, so a peer that stalls its
 * probe was ranked first and was asked first in the BTC fee cross-check.
 */
import { describe, expect, it } from 'vitest';

import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import {
	fastPeersFromDirectory,
	rankDirectoryPeers,
	type DirectoryPeerRow,
	type FastFederationDb
} from '$indexer/chatFastFederation';

const row = (origin: string, status: string, probedAt: string): DirectoryPeerRow =>
	({
		origin,
		reg_alt_networks: null,
		last_probe_status: status,
		last_probed_at: probedAt,
		registered_at_time: '2026-01-01T00:00:00Z',
		last_probe_error: null
	}) as DirectoryPeerRow;

describe('directory ranking', () => {
	it('within a status, by origin — a peer that just finished a (stalled) probe does not jump ahead', () => {
		const ranked = rankDirectoryPeers([
			row('https://zeta.example', 'good', '2026-10-02T12:00:00Z'), // stalled, finished last
			row('https://alpha.example', 'good', '2026-10-02T11:00:00Z'),
			row('https://mid.example', 'quiet', '2026-10-02T12:30:00Z')
		]);
		expect(ranked.map((r) => r.origin)).toEqual([
			'https://alpha.example',
			'https://zeta.example',
			'https://mid.example'
		]);
	});

	it('the fee cross-check gets peers on a node without Tor (every registered address)', async () => {
		const rows = [row('https://alpha.example', 'good', '2026-10-02T11:00:00Z')];
		const db = {
			query: (async () => ({ rows, rowCount: rows.length })) as unknown as FastFederationDb['query']
		};
		const noTor: HiddenServiceProxyConfig = { torSocks: '', i2pHttpProxy: '' };
		const peers = await fastPeersFromDirectory(db, 'https://self.example', noTor, 6);
		expect(peers.map((p) => p.origin)).toEqual(['https://alpha.example']);
	});
});
