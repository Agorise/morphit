/**
 * Morphit ops CLI — reading the federated-chat block out of `/v1/health`.
 *
 * WHAT THIS IS FOR. v1.18.0 put a full diagnostic story on the indexer's
 * health endpoint: which of THIS box's hidden networks are unusable, how many
 * recent failures never left the machine, how many faults are recorded against
 * a network that has not been convicted, what the receiving side is doing.
 * `morphit-ops health` sent the operator-local header that reveals all of it
 * and then displayed none of it — it parsed only the head TAILER, which is a
 * different subsystem that happens to share the same block. The operator guide
 * said, in as many words, to read the federation fields "with the ops CLI".
 *
 * So the single thing an operator cannot guess at — that their own Tor, i2pd or
 * lokinet is the reason chat is slow — was reachable only by curling the
 * indexer by hand and knowing which key to look for.
 *
 * WHAT IS ASSERTED HERE is the reading, not the printing: given a health body
 * of the shape the indexer actually sends, does the summary carry the facts an
 * operator needs, and does it stay honest about a body that does not have them?
 * A mixed-version federation is the normal state during an upgrade, so every
 * case below is a real body from some version of the indexer rather than a
 * hand-invented malformed one — except the last two, which are, deliberately.
 */

import { describe, it, expect } from 'vitest';
import { parseFederation } from '../src/commands/health.ts';

/** The shape the indexer sends: counters under `federation`, reasons under
 *  `federationDiagnostics`, receiving side under `federationIntake`. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		running: true,
		scannedHead: 1_000,
		federation: {
			peers: 3,
			peerDeliveries: 42,
			peerFailures: 5,
			peersTruncated: 0,
			lastWarmOk: 2,
			lastWarmTotal: 3
		},
		federationDiagnostics: {
			networksDown: [],
			networksSuspected: {},
			recentFailures: []
		},
		// THE REAL SHAPE of federationChatFastRoute().stats(), which health.ts
		// passes through verbatim. This fixture used to read
		// `{ accepted: 11, shed: 0 }` — invented, never emitted by anything — and
		// that is why every test below passed while the CLI's peer-received line
		// was permanently dead in production. Keys here are copied from the
		// indexer's declared `stats()` and pinned against it by
		// `federation-intake-contract-smoke`.
		federationIntake: {
			queueDepth: 0,
			verified: 11,
			refused: 0,
			shed: 0,
			verifyCostMs: 5.75,
			admissionDepth: 500
		},
		...over
	};
}

describe('what an operator is told about federated chat', () => {
	it('carries the counters that say whether it is working at all', () => {
		const f = parseFederation(body());
		expect(f?.peers).toBe(3);
		expect(f?.delivered).toBe(42);
		expect(f?.failed).toBe(5);
	});

	/**
	 * THE LINE THE WHOLE BLOCK EXISTS FOR. A failure count sends an operator to
	 * look at the federation, their peers, their firewall — when the answer is a
	 * daemon on their own machine that they have not thought about.
	 */
	it('names the networks THIS box cannot use', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: ['tor', 'i2p'],
					networksSuspected: {},
					recentFailures: []
				}
			})
		);
		expect(f?.networksDown).toEqual(['i2p', 'tor']);
	});

	/**
	 * The corroboration state, which without a line of its own reads as the
	 * health block contradicting itself: local faults recorded, nothing down.
	 * That happens whenever a network's failures cannot identify our end and
	 * only one address has produced one — on a directory with a single `.loki`
	 * peer it is the PERMANENT state, because a second address never arrives.
	 */
	it('surfaces faults held against a network it has not convicted', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: [],
					networksSuspected: { loki: 1 },
					recentFailures: []
				}
			})
		);
		expect(f?.networksSuspected).toEqual([{ network: 'loki', count: 1 }]);
		expect(f?.networksDown, 'and it must not be reported as down').toEqual([]);
	});

	it('ignores a suspected count of zero rather than printing an empty accusation', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: [],
					networksSuspected: { i2p: 0 },
					recentFailures: []
				}
			})
		);
		expect(f?.networksSuspected).toEqual([]);
	});

	it('counts how many recent failures never left this machine', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: [],
					networksSuspected: {},
					// The FIRST and LAST reasons are deliberately different. With the
					// same string at both ends, a summary that read the wrong end of
					// the list would pass — and "last failure" is the line an operator
					// reads first, so it has to be the most RECENT one.
					recentFailures: [
						{ origin: 'http://old.onion', reason: 'HTTP 502', status: 502 },
						{
							origin: 'http://a.onion',
							reason: 'local tor transport unavailable',
							localFault: true
						},
						{ origin: 'https://b.example', reason: 'HTTP 413', status: 413 },
						{
							origin: 'http://c.onion',
							reason: 'local tor transport unavailable: the newest one',
							localFault: true
						}
					]
				}
			})
		);
		expect(f?.localFaults, 'two of ours, two theirs').toBe(2);
		expect(f?.lastFailure, 'the most RECENT one, not the oldest').toBe(
			'local tor transport unavailable: the newest one'
		);
	});

	it('reports the receiving side, not only the sending side', () => {
		const f = parseFederation(
			body({
				federationIntake: {
					queueDepth: 0,
					verified: 7,
					refused: 0,
					shed: 2,
					verifyCostMs: 6,
					admissionDepth: 500
				}
			})
		);
		expect(f?.intakeAccepted, 'sourced from `verified` — the key the indexer sends').toBe(7);
		expect(f?.intakeShed).toBe(2);
	});

	/**
	 * THE ONE THAT WAS DEAD. `intakeAccepted` read a key called `accepted`, and
	 * nothing has ever emitted that: the indexer's counter is `verified`. So the
	 * value was null on every instance and the "received N from peers" line never
	 * printed — while this suite stayed green, because its fixture declared
	 * `accepted` too. A fixture that invents its own shape proves the path
	 * accepts THE FIXTURE.
	 */
	it('a body with only the phantom `accepted` key yields nothing', () => {
		const f = parseFederation(body({ federationIntake: { accepted: 99, shed: 1 } }));
		expect(
			f?.intakeAccepted,
			'`accepted` is not a key the indexer sends; reading it must not appear to work'
		).toBeNull();
	});

	/**
	 * The time-derived intake bound. Below the ceiling means this box is slow
	 * enough that six seconds, not memory, limits how deep it will queue — the
	 * one thing an operator can act on and cannot otherwise discover.
	 */
	it('carries the admission bound and the measured cost behind it', () => {
		const f = parseFederation(
			body({
				federationIntake: {
					queueDepth: 12,
					verified: 5,
					refused: 0,
					shed: 40,
					verifyCostMs: 18.2,
					admissionDepth: 252
				}
			})
		);
		expect(f?.intakeAdmissionDepth).toBe(252);
		expect(f?.intakeVerifyCostMs).toBeCloseTo(18.2);
	});

	it('an older indexer without the bound reports it as absent, not as zero', () => {
		const f = parseFederation(
			body({ federationIntake: { queueDepth: 0, verified: 3, refused: 0, shed: 0 } })
		);
		expect(f?.intakeAccepted, 'the counters it does send still read').toBe(3);
		expect(
			f?.intakeAdmissionDepth,
			'zero would render as "queue held to 0", which is a false alarm about a healthy box'
		).toBeNull();
	});

	/**
	 * A peer past the fan-out bound is healthy, reachable, and still on chain
	 * timing. It is the one degradation in this subsystem with no symptom of its
	 * own, which is exactly why the count is carried.
	 */
	it('carries the fan-out truncation count', () => {
		const f = parseFederation(
			body({ federation: { peers: 40, peerDeliveries: 0, peerFailures: 0, peersTruncated: 17 } })
		);
		expect(f?.peersTruncated).toBe(17);
	});
});

describe('bodies this build was not written against', () => {
	/**
	 * A mixed-version federation is the normal state during an upgrade. An
	 * older indexer has a `fastpath` block with a head tailer in it and no
	 * `federation` key at all — the summary must be ABSENT rather than a row of
	 * zeros, because zeros read as "nothing is being delivered" and that is a
	 * different and alarming claim.
	 */
	it('an older indexer with no federation block reports nothing, not zeros', () => {
		expect(parseFederation({ running: true, scannedHead: 5 })).toBeNull();
	});

	it('no fastpath block at all reports nothing', () => {
		expect(parseFederation(null)).toBeNull();
		expect(parseFederation(undefined)).toBeNull();
	});

	/**
	 * And the shapes a health report must never crash on. It is a diagnostic
	 * tool: a crash while reporting is strictly worse than an omitted line,
	 * because it takes every OTHER check down with it — the operator loses the
	 * database, relay and RPC verdicts to a federation field they were not even
	 * asking about.
	 */
	it('survives a diagnostics block of entirely the wrong shape', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: 'tor',
					networksSuspected: ['loki'],
					recentFailures: 'none'
				}
			})
		);
		expect(f).not.toBeNull();
		expect(f?.networksDown).toEqual([]);
		expect(f?.networksSuspected).toEqual([]);
		expect(f?.localFaults).toBeNull();
	});

	it('survives junk inside the arrays rather than trusting their contents', () => {
		const f = parseFederation(
			body({
				federationDiagnostics: {
					networksDown: ['tor', 42, null, { nope: true }],
					networksSuspected: { loki: 'lots', i2p: 2 },
					recentFailures: [null, 'x', { reason: 7 }]
				}
			})
		);
		expect(f?.networksDown, 'only the strings').toEqual(['tor']);
		expect(f?.networksSuspected, 'only the numbers').toEqual([{ network: 'i2p', count: 2 }]);
		expect(f?.lastFailure, 'a non-string reason is not a reason').toBeNull();
	});
});
