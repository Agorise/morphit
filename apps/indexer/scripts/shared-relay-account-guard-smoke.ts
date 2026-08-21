#!/usr/bin/env tsx
/**
 * Smoke for F4 — the welcome-bonus double-spend guard.
 *
 * When two Morphit instances are configured with the SAME relay account, both
 * indexers observe that account's signup events and each credits the welcome
 * bonus from its own independent Postgres DB (OPERATIONS.md §29). probeOne now
 * takes an optional SelfRelayCollisionCheck: if a DIFFERENT instance advertises
 * OUR relay account, it invokes onCollision(peerOrigin). This is a side-effect
 * only — it must NEVER change the probe's classification.
 *
 * Coverage:
 *   - peer advertises OUR relay account (different origin) → onCollision fires
 *   - peer advertises a DIFFERENT relay account → onCollision does not fire
 *   - peer IS us (same origin, our relay account) → onCollision does not fire
 *   - no selfCheck supplied → no crash, no callback (back-compat)
 *   - the collision check does not alter the returned status
 */
import { probeOne, type SelfRelayCollisionCheck } from '../src/indexer/federationProbe.ts';
import type { KnownInstanceRow } from '../src/indexer/federationProbe.ts';

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
	scenarios++;
	const done = (err?: unknown): void => {
		if (err) {
			failures++;
			console.log(`  ✗ ${name}`);
			console.log(`      ${err instanceof Error ? err.message : String(err)}`);
		} else {
			console.log(`  ✓ ${name}`);
		}
	};
	try {
		const r = fn();
		if (r instanceof Promise) return r.then(() => done()).catch(done);
		done();
	} catch (err) {
		done(err);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const SELF_ORIGIN = 'https://morphit.io';
const SELF_RELAY = 'morphit-relay';

function makeRow(origin: string, operator_account: string): KnownInstanceRow {
	return {
		origin,
		operator_account,
		registered_at_time: new Date(0),
		last_probed_at: null,
		last_probe_status: 'never',
		consecutive_failures: 0,
		cached_indexed_block: null
	} as KnownInstanceRow;
}

// A fetchFn that makes the probed peer advertise a given relay_account.
function fetchAdvertising(relay_account: string) {
	return async <T>(_url: string): Promise<T> =>
		({
			name: 'peer',
			tagline: null,
			contact_url: null,
			alt_networks: { tor: null, lokinet: null, i2p: null, nostr: null },
			fee_recipient: 'morphit-fees',
			relay_account
		}) as unknown as T;
}

function collector(): { fired: string[]; check: SelfRelayCollisionCheck } {
	const fired: string[] = [];
	return {
		fired,
		check: {
			selfRelayAccount: SELF_RELAY,
			selfOrigin: SELF_ORIGIN,
			onCollision: (peerOrigin: string) => fired.push(peerOrigin)
		}
	};
}

async function run(): Promise<void> {
	console.log('shared-relay-account guard (F4) smoke:\n');

	await check('peer advertising OUR relay account (different origin) → onCollision fires', async () => {
		const c = collector();
		await probeOne(makeRow('https://evil.example', 'eve'), null, fetchAdvertising(SELF_RELAY), c.check);
		assert(c.fired.length === 1, `expected 1 collision, got ${c.fired.length}`);
		assert(c.fired[0] === 'https://evil.example', 'callback should receive the peer origin');
	});

	await check('peer advertising a DIFFERENT relay account → onCollision does NOT fire', async () => {
		const c = collector();
		await probeOne(makeRow('https://other.example', 'other-relay'), null, fetchAdvertising('other-relay'), c.check);
		assert(c.fired.length === 0, `expected no collision, got ${c.fired.length}`);
	});

	await check('peer IS us (same origin, our relay account) → onCollision does NOT fire', async () => {
		const c = collector();
		await probeOne(makeRow(SELF_ORIGIN, SELF_RELAY), null, fetchAdvertising(SELF_RELAY), c.check);
		assert(c.fired.length === 0, 'must never flag our own origin as a collision');
	});

	await check('same origin modulo trailing slash → still recognised as self (no false collision)', async () => {
		const c = collector();
		await probeOne(makeRow('https://morphit.io/', SELF_RELAY), null, fetchAdvertising(SELF_RELAY), c.check);
		assert(c.fired.length === 0, 'origin normalization must treat trailing-slash as self');
	});

	await check('no selfCheck supplied → no crash, no callback (back-compat)', async () => {
		const out = await probeOne(makeRow('https://x.example', 'eve'), null, fetchAdvertising(SELF_RELAY));
		assert(typeof out.status === 'string', 'probeOne should still return a normal outcome');
	});

	await check('collision detection does NOT change classification', async () => {
		const c = collector();
		const withCheck = await probeOne(makeRow('https://evil.example', 'eve'), null, fetchAdvertising(SELF_RELAY), c.check);
		const without = await probeOne(makeRow('https://evil.example', 'eve'), null, fetchAdvertising(SELF_RELAY));
		assert(withCheck.status === without.status, 'status must be identical with and without the collision check');
	});

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} shared-relay-account guard scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

void run();
