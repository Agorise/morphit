/**
 * The publisher names its own .onion and .b32.i2p in the signed snapshot
 * record (indexer_snapshot_v1 `hidden_mirrors`, v1.21.5).
 *
 * WHY (2026-10-10). A brand-new Tor/I2P-only server fast-syncs before it has an
 * indexer, so the only place it can learn a private address to fetch the
 * snapshot from is what it reads from the chain. It looked for operator
 * registrations in @morphit's history; morphit.io's diagnostic read all 169
 * entries of that history and found none (morphit.io's addresses reach the
 * federation directory by probing, not from a registration). So fast-sync never
 * had a private source and fell back to a full replay. The record the newcomer
 * already reads and verifies now carries the publisher's addresses, under the
 * same signature.
 *
 * Servers that do not know the field ignore it: the validator has never looked
 * at keys it does not know (unchanged since v1.21.3).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
	buildIndexerSnapshotOp,
	validateIndexerSnapshotPayload
} from '../../src/blurt/indexerSnapshotOp';
import { mirrorPeers } from '../../src/blurt/snapshotMirrors';

const ON = (c: string) => `${c.repeat(56)}.onion`;
const I2 = (c: string) => `${c.repeat(52)}.b32.i2p`;
const base = {
	ipfs_cid: 'QmVs236Da4ER5DeSSkda7BXCLm6czEm4rYC9B92Qu32kv1',
	sha256: 'a'.repeat(64),
	chain_id: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
	schema_version: 67,
	last_applied_block: 64288040,
	size_bytes: 633822,
	indexer_version: '1.21.5'
};

describe('hidden_mirrors in the snapshot record', () => {
	it('a valid one is kept with the payload', () => {
		const r = validateIndexerSnapshotPayload({
			...base,
			hidden_mirrors: { tor: ON('m'), i2p_b32: I2('m') }
		});
		expect(r.ok).toBe(true);
		expect(r.value?.hidden_mirrors).toEqual({ tor: ON('m'), i2p_b32: I2('m') });
		const one = validateIndexerSnapshotPayload({ ...base, hidden_mirrors: { tor: ON('m') } });
		expect(one.value?.hidden_mirrors).toEqual({ tor: ON('m') });
	});

	it('a record without it is as before; a malformed one is dropped, never the record', () => {
		expect(validateIndexerSnapshotPayload(base).value).toEqual(base);
		for (const bad of [
			'x',
			{ tor: 'evil.example' },
			{ tor: ON('m'), i2p_b32: 'x.i2p' },
			{},
			null
		]) {
			const r = validateIndexerSnapshotPayload({ ...base, hidden_mirrors: bad });
			expect(r.ok, JSON.stringify(bad)).toBe(true);
			expect(r.value?.hidden_mirrors, JSON.stringify(bad)).toBeUndefined();
		}
	});

	it('the publisher never signs a malformed one', () => {
		expect(() =>
			buildIndexerSnapshotOp(JSON.stringify({ ...base, hidden_mirrors: { tor: 'evil.example' } }))
		).toThrow(/hidden_mirrors/);
		const op = buildIndexerSnapshotOp(
			JSON.stringify({ ...base, hidden_mirrors: { tor: ON('m'), i2p_b32: I2('m') } })
		);
		expect(JSON.parse(op.json).hidden_mirrors.tor).toBe(ON('m'));
	});

	it("the publisher's own addresses are tried before anyone else's", () => {
		const peers = mirrorPeers({
			directory: { instances: [{ operator_account: 'x', alt_networks: { tor: ON('x') } }] },
			history: [],
			signer: 'morphit',
			published: { tor: ON('m'), i2p_b32: I2('m') }
		});
		expect(peers[0]).toEqual({ tor: ON('m'), i2p_b32: I2('m') });
		expect(peers.length).toBe(2);
	});
});

describe('fast-sync and the mirror use them', () => {
	const peersArg = (script: string): string => {
		const file = join(__dirname, '..', '..', 'scripts', script);
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		let expr = '';
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && n.expression.getText(sf) === 'buildSnapshotSources') {
				const arg = n.arguments[0];
				if (arg && ts.isObjectLiteralExpression(arg))
					for (const p of arg.properties)
						if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'peers')
							expr = p.initializer.getText(sf);
						else if (ts.isShorthandPropertyAssignment(p) && p.name.getText(sf) === 'peers')
							expr = 'peers';
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		return expr;
	};
	it("fast-sync (a newcomer with no indexer) takes the record's addresses", () => {
		const src = readFileSync(
			join(__dirname, '..', '..', 'scripts', 'snapshot-bootstrap.ts'),
			'utf8'
		);
		expect(peersArg('snapshot-bootstrap.ts')).toBe('peers');
		expect(src).toMatch(/const peers = mirrorPeers\(\{[^}]*published: op\.hidden_mirrors/);
	});
	it("the mirror takes the record's addresses first", () => {
		expect(peersArg('snapshot-mirror.ts')).toMatch(
			/^mirrorPeers\(\{[^}]*published: op\.hidden_mirrors/
		);
	});
});
