/**
 * Where the snapshot mirror finds the peers that re-serve the snapshot over
 * Tor/I2P (morphitlat, v1.21.4, 2026-10-10: "no federation peer's .onion or
 * .b32.i2p address was found in the history read"). The v1.21.4 fallback read
 * peers only from operator registrations in @morphit's history; that history
 * held none, so the fallback asked nobody. The same box's hidden upgrade found
 * 8 gateways a minute earlier in its indexer's federation directory
 * (/v1/instances). The mirror now asks that directory first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
	mirrorPeers,
	peerAddressesFromDirectory,
	readLocalDirectory
} from '../../src/blurt/snapshotMirrors';

const ON = (c: string) => `${c.repeat(56)}.onion`;
const I2 = (c: string) => `${c.repeat(52)}.b32.i2p`;

const directory = {
	instances: [
		{ operator_account: 'someone', alt_networks: { tor: ON('a'), i2p_b32: null } },
		{ operator_account: 'morphit', alt_networks: { tor: ON('m'), i2p_b32: I2('m') } },
		{ operator_account: 'old-shape', reg_alt_networks: { tor: null, i2p_b32: I2('o') } },
		{ operator_account: 'clearnet-only', alt_networks: { tor: null, i2p_b32: null } },
		{ operator_account: 'bad', alt_networks: { tor: 'evil.example', i2p_b32: 'x.i2p' } }
	]
};

describe("the federation directory as the mirror's peer list", () => {
	it('reads each instance’s .onion and .b32.i2p, the snapshot signer first, and drops what is not one', () => {
		const peers = peerAddressesFromDirectory(directory, 'morphit');
		expect(peers).toEqual([
			{ tor: ON('m'), i2p_b32: I2('m') },
			{ tor: ON('a'), i2p_b32: null },
			{ tor: null, i2p_b32: I2('o') }
		]);
	});

	it('anything that is not a directory gives no peers, never an error', () => {
		for (const x of [null, 'x', 42, {}, { instances: 'no' }, { instances: [null, 7] }])
			expect(peerAddressesFromDirectory(x, 'morphit')).toEqual([]);
	});

	it('the directory and the history together, each address once', () => {
		const history = [
			[
				9,
				{
					op: [
						'custom_json',
						{
							id: 'morphit_operator_register_v1',
							required_posting_auths: ['morphit'],
							json: JSON.stringify({ alt_addresses: { tor: ON('m'), i2p_b32: I2('h') } })
						}
					]
				}
			]
		];
		const peers = mirrorPeers({ directory, history, signer: 'morphit' });
		const all = peers.flatMap((p) => [p.tor, p.i2p_b32]).filter(Boolean);
		expect(new Set(all).size).toBe(all.length);
		expect(all).toContain(I2('h'));
		expect(all[0]).toBe(ON('m'));
	});

	it("reads the directory from this node's own indexer, and an indexer that does not answer gives none", async () => {
		const asked: string[] = [];
		const got = await readLocalDirectory('http://127.0.0.1:8081', async (u) => {
			asked.push(u);
			return new Response(JSON.stringify(directory), { status: 200 });
		});
		expect(asked).toEqual(['http://127.0.0.1:8081/v1/instances']);
		expect(got).toEqual(directory);
		expect(
			await readLocalDirectory('http://127.0.0.1:8081', async () => {
				throw new Error('ECONNREFUSED');
			})
		).toBeNull();
		expect(
			await readLocalDirectory(
				'http://127.0.0.1:8081',
				async () => new Response('x', { status: 503 })
			)
		).toBeNull();
	});
});

describe('the mirror script asks the directory', () => {
	it('the CAR fallback gets its peers from mirrorPeers with the local directory, not the history alone', () => {
		const file = join(__dirname, '..', '..', 'scripts', 'snapshot-mirror.ts');
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		let peersExpr = '';
		let readsDirectory = false;
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && n.expression.getText(sf) === 'buildSnapshotSources') {
				const arg = n.arguments[0];
				if (arg && ts.isObjectLiteralExpression(arg))
					for (const p of arg.properties)
						if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'peers')
							peersExpr = p.initializer.getText(sf);
			}
			if (ts.isCallExpression(n) && n.expression.getText(sf) === 'readLocalDirectory')
				readsDirectory = true;
			ts.forEachChild(n, visit);
		};
		visit(sf);
		expect(readsDirectory, 'the mirror never reads the local directory').toBe(true);
		expect(peersExpr).toMatch(/^mirrorPeers\(/);
	});
});
