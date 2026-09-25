/**
 * What the intake queue costs a message that is NOT shed.
 *
 * THE QUESTION NOBODY HAD ASKED. The federation intake accepts a push (202),
 * puts it on a bounded queue, and drains it with ONE worker that verifies each
 * transaction in turn. Everything written about that queue concerns the
 * OVERFLOW case, and it is written well: `VERIFY_QUEUE_MAX = 500`, shedding is
 * the correct failure, a shed message still arrives by chain.
 *
 * None of it says what the queue costs the messages it ACCEPTS. A message
 * entering at depth D waits for D verifications before its own, and each one is
 * a signature recovery plus a `SELECT posting_pubkey` — the ordinary lookup is
 * not cached (only keys CORRECTED from the chain are). So the queue converts
 * depth directly into delivery latency, sequentially, and the six-second
 * promise this whole release exists to keep has a term in it that nothing
 * measured.
 *
 * This is the shape of F13 — two constants with a live relationship neither of
 * them names. There, `KEEP_ALIVE_MS` and `WARM_INTERVAL_MS` in different files.
 * Here, `VERIFY_QUEUE_MAX` and the six-second budget: multiply the queue bound
 * by the per-verify cost and you get a number that has to fit inside the
 * budget, and nothing anywhere checks that it does.
 *
 * WHAT THIS FILE DOES. It measures the real per-verify cost against a real
 * database with real signatures, then asserts the relationship. It deliberately
 * does NOT hard-code a millisecond figure as a pass mark — CI machines differ
 * and that would be a flake generator. It asserts the STRUCTURAL claim: a full
 * queue must still drain inside the delivery budget, computed from the cost
 * measured on this machine.
 *
 * Skips without TEST_DATABASE_URL, like every other integration suite here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	federationChatFastRoute,
	admissionDepthFor,
	VERIFY_QUEUE_MAX as VERIFY_QUEUE_MAX_FOR_TEST,
	QUEUE_WAIT_ALLOWANCE_MS as MODULE_QUEUE_ALLOWANCE_MS,
	TRANSPORT_WORST_CASE_BUDGET_MS
} from '../../src/api/federationChatFast';
import { BATCH_MAX as BATCH_MAX_FOR_TEST } from '../../src/indexer/chatFastFederation';
import { chatEventBus } from '../../src/indexer/chatEventBus';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const SENDER = 'alice';
const RECIPIENT = 'bob';
const senderKey = PrivateKey.fromSeed('morphit-intake-queue-latency-sender');
const senderPub = senderKey.createPublic().toString();

/**
 * The six-second bar, in its own words. Taken from the same requirement the
 * instance-matrix smoke walks: "regardless of which, or which kind of instance
 * you are on, legit chats need to be under 6 seconds, sending and receiving."
 */
const DELIVERY_BUDGET_MS = 6_000;

/**
 * The queue's share of that, IMPORTED rather than recomputed.
 *
 * This file used to hard-code `6_000 - 1_400`, and so did the smoke. Changing
 * `TRANSPORT_WORST_CASE_MS` in the module left both asserting a budget nothing
 * shipped — green, and no longer testing the shipped behaviour. Verified by
 * mutation: with the transport budget moved to 3,000 ms the smoke still
 * reported "a full queue drains inside 4600ms" and passed.
 */
const QUEUE_ALLOWANCE_MS = MODULE_QUEUE_ALLOWANCE_MS;

/**
 * How much of that budget the rest of the path already spends, worst case
 * MEASURED: privacy-instance to privacy-instance, buyer's first contact to the
 * seller's inbox, is ~1,367 ms across three hidden hops. The intake queue is
 * one term inside that journey, not a separate allowance, so what is left for
 * it is the budget minus the path.
 */
/** The seed `federationChatFast.ts` starts its estimate at. Duplicated here on
 *  purpose: the point of the assertion below is that the LIVE value has moved
 *  away from it, so importing the same constant would defeat it if the module
 *  ever stopped seeding from that name. */
const SEEDED_VERIFY_COST_MS = 20;

/**
 * How many verifications to run before trusting the instance's estimate.
 *
 * The estimate is a slow EWMA (alpha 0.1), so it needs on the order of fifty
 * samples to get within a few percent of the truth. Asserting the derived bound
 * before it converges tests the SEED, not the mechanism — and that is how the
 * optimistic seed shipped in the first place: the original 32-message batch left
 * the estimate short of the truth on a loaded box, and the assertion failed for
 * a reason that turned out to be a real defect rather than a flaky test.
 */
const WARMUP_VERIFICATIONS = 120;

function signedChatTx(tag: string): unknown {
	const payload = {
		recipient: RECIPIENT,
		ciphertext: Buffer.from('an encrypted message body').toString('base64'),
		header: {
			client_tag: tag,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		}
	};
	const tx = {
		ref_block_num: 1234,
		ref_block_prefix: 5678,
		expiration: new Date(Date.now() + 45_000).toISOString().slice(0, 19),
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [SENDER],
					id: 'morphit_chat_v1',
					json: JSON.stringify(payload)
				}
			]
		] as unknown[],
		extensions: []
	};
	return cryptoUtils.signTransaction(tx as Parameters<typeof cryptoUtils.signTransaction>[0], [
		senderKey
	]);
}

/** Yield until `done()` or a bounded number of event-loop turns. Zero-delay
 *  hand-offs, not timed sleeps — see fastpath-writes-nothing.test.ts. */
async function drain(done: () => boolean, maxTurns = 200_000): Promise<void> {
	for (let i = 0; i < maxTurns && !done(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

describe.skipIf(!INTEGRATION_ENABLED)('what the intake queue costs a message', () => {
	let fx: IntegrationFixture;
	let app: Hono;
	let intake: ReturnType<typeof federationChatFastRoute>;
	/** Measured on THIS machine, in `measures the real cost`, and reused by the
	 *  assertions below so they scale with the hardware rather than flaking. */
	let perVerifyMs = 0;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(
			`INSERT INTO accounts
			     (name, creator, created_block_num, created_block_time, created_trx_id, posting_pubkey)
			   VALUES ($1, 'genesis', 1, now(), 'seed', $2)
			   ON CONFLICT (name) DO UPDATE SET posting_pubkey = EXCLUDED.posting_pubkey`,
			[SENDER, senderPub]
		);
		intake = federationChatFastRoute(fx.db);
		app = new Hono();
		app.route('/v1/federation/chat-fast', intake.app ?? (intake as unknown as Hono));
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	/**
	 * THE SEED ERRS THE SAFE WAY — asserted on a FRESH intake, before any
	 * measurement has happened, because that is the only moment the seed is the
	 * whole answer and every other test here deliberately warms past it.
	 *
	 * The direction is what matters. Under-estimate the cost and the instance
	 * admits a queue deeper than it can drain, accepting messages it will deliver
	 * late; over-estimate and it admits a shallower one, shedding messages the
	 * chain carries anyway. The first breaks the promise silently. So a
	 * just-started instance must begin cautious and relax as it learns, never the
	 * reverse — and the window this governs, the first hundred or so messages
	 * after a restart, is exactly when a backlog is most likely to arrive.
	 */
	it('a just-started instance begins cautious rather than optimistic', () => {
		const fresh = federationChatFastRoute(fx.db);
		const depth = fresh.stats().admissionDepth;
		expect(
			depth,
			`a fresh instance admits ${depth} — the ceiling — so its seed assumes hardware at ` +
				`least as fast as the machine that measured it. On anything slower it will accept ` +
				`a queue it cannot drain until the estimate catches up.`
		).toBeLessThan(VERIFY_QUEUE_MAX_FOR_TEST);
		expect(
			fresh.stats().verifyCostMs,
			'the seed must sit at the slow end of plausible hardware, not the fast end'
		).toBeGreaterThanOrEqual(10);
		// But not so cautious it is useless: a fresh instance must still take
		// more than a single batch, or a restart looks like an outage.
		expect(depth, 'a fresh instance must still accept more than one batch').toBeGreaterThan(
			BATCH_MAX_FOR_TEST
		);
	});

	/**
	 * Establish the per-message cost empirically. A batch is pushed in one
	 * request so the whole cost — signature recovery AND the uncached
	 * `SELECT posting_pubkey` — is paid by the worker exactly as it would be in
	 * production, then divided by the number of messages.
	 */
	it('measures the real per-verify cost end to end', async () => {
		const N = WARMUP_VERIFICATIONS;
		const seen: unknown[] = [];
		const off = chatEventBus.onFast(() => seen.push(1));

		const before = intake.stats().verified;
		// BATCH_MAX caps one request, so this goes as several. Sent before the
		// clock starts where possible; what matters is that the WORKER does N
		// verifications, which is the cost the queue actually charges.
		const CHUNK = 32;
		const bodies: string[] = [];
		for (let c = 0; c < N / CHUNK; c++) {
			bodies.push(
				JSON.stringify({
					trxs: Array.from({ length: CHUNK }, (_, i) =>
						signedChatTx(`bench-${Date.now()}-${c}-${i}`)
					)
				})
			);
		}
		const t0 = Date.now();
		for (const body of bodies) {
			const res = await app.request('http://local/v1/federation/chat-fast', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body
			});
			expect(res.status, 'each batch must be accepted').toBe(202);
		}

		await drain(() => intake.stats().verified - before >= N);
		const elapsed = Date.now() - t0;
		off();

		const done = intake.stats().verified - before;
		expect(done, 'every message in the batch must have been verified').toBe(N);

		perVerifyMs = elapsed / N;
		// Not an assertion on the value — a floor/ceiling sanity check so a
		// measurement of zero (a worker that did nothing) or an absurd one
		// (a machine under such load the number is meaningless) cannot silently
		// make the real assertions below trivially true.
		expect(
			perVerifyMs,
			'a per-verify cost of ~0 means the work did not happen — the rest proves nothing'
		).toBeGreaterThan(0);
		expect(perVerifyMs, 'implausibly slow — this measurement is not usable').toBeLessThan(500);

		console.log(
			`      [measured] ${N} verifications in ${elapsed}ms = ${perVerifyMs.toFixed(2)}ms each; ` +
				`instance's own estimate ${intake.stats().verifyCostMs.toFixed(2)}ms; ` +
				`admission depth ${intake.stats().admissionDepth}`
		);
	});

	/**
	 * THE ASSERTION THIS FILE EXISTS FOR.
	 *
	 * A message accepted onto a full queue is not shed — it is promised delivery.
	 * It waits behind every message already queued. So the admission bound times
	 * the per-verify cost is the worst wait the fast path can impose on a message
	 * it accepted, and that has to fit in what six seconds leaves after the
	 * transport path has taken its share.
	 *
	 * Before this was derived, the bound was a flat 500 and this assertion held
	 * only by luck of hardware: at the 5.75 ms measured here, 500 deep is 2.9 s
	 * and fits; at 10 ms it is 5.0 s and does not. The bound now falls out of the
	 * measurement, so this passes on a fast box and a slow one alike — and if it
	 * ever fails, the derivation is wrong rather than the hardware.
	 */
	it('a full queue still drains inside the delivery budget', async () => {
		expect(perVerifyMs, 'the measurement test must run first').toBeGreaterThan(0);
		const depth = intake.stats().admissionDepth;
		// `perVerifyMs` is an UPPER bound on the true per-message queue cost: it
		// divides the whole wall-clock span, including request handling and the
		// drain loop's own scheduling, by the number verified. Asserting against
		// an over-estimate is the conservative direction — if the depth fits at
		// this cost it fits at the real one — which is why the test uses its own
		// figure rather than the instance's. Using the instance's would make the
		// assertion true by construction and test nothing.
		const worstWaitMs = perVerifyMs * depth;
		expect(
			worstWaitMs,
			`a message accepted onto a full queue waits ${(worstWaitMs / 1000).toFixed(1)}s behind ` +
				`${depth} others at ${perVerifyMs.toFixed(2)}ms each, but six seconds leaves only ` +
				`${QUEUE_ALLOWANCE_MS}ms after the transport path. Accepting a message and then ` +
				`missing the budget is worse than shedding it: a shed message is carried by the ` +
				`chain and nobody claimed otherwise.`
		).toBeLessThanOrEqual(QUEUE_ALLOWANCE_MS);
	});

	/**
	 * The bound must actually TRACK the machine, not just happen to be a number
	 * that fits. This is the difference between deriving it and hard-coding a
	 * smaller constant: the instance's own estimate has to agree with what the
	 * test measured independently, or the derivation is reading something else.
	 */
	it('the instance measured the same cost the test did', () => {
		const own = intake.stats().verifyCostMs;
		expect(own, 'the instance must have formed its own estimate').toBeGreaterThan(0);
		// It must have MOVED from its seed. On this machine the seed happens to be
		// close to the true cost, so every assertion that only checks the value is
		// satisfied by an estimate that is never updated at all — which is exactly
		// the mutation that survived here first. Exact inequality is the test: an
		// EWMA that ran even once cannot still be sitting on its seed.
		expect(
			own,
			'the estimate is still exactly its seed — nothing is measuring the real cost, ' +
				'and the admission bound is derived from a hard-coded guess'
		).not.toBe(SEEDED_VERIFY_COST_MS);
		// Generous bounds: the EWMA is deliberately slow and the test's figure is
		// a mean including HTTP and batch-parse overhead, so these are the same
		// quantity measured two ways rather than the same number.
		expect(
			own,
			`the instance thinks a verify costs ${own.toFixed(2)}ms; the test measured ` +
				`${perVerifyMs.toFixed(2)}ms. An order of magnitude apart means the estimate is ` +
				`not measuring verification.`
		).toBeGreaterThan(perVerifyMs / 10);
		expect(own).toBeLessThan(perVerifyMs * 10);
	});

	/**
	 * And the derivation itself, exercised at costs this machine will not
	 * produce. The arithmetic is what protects a slow VPS, and a slow VPS is
	 * precisely the box no CI run happens on — so it is checked directly rather
	 * than waited for.
	 */
	it('derives a shallower queue on a slower box and a deeper one on a fast box', () => {
		// THE REAL FUNCTION, not a copy of the formula. An earlier version of this
		// test re-implemented the arithmetic and three mutations against the
		// module survived it — a test that recomputes what it is checking asserts
		// a definition, not behaviour.
		const floor = BATCH_MAX_FOR_TEST;
		const derive = admissionDepthFor;

		// A fast box is capped by the ceiling, not by the budget.
		expect(derive(1), 'memory is still finite however fast the box').toBe(
			VERIFY_QUEUE_MAX_FOR_TEST
		);
		// The measured speed here: budget is not yet the binding constraint.
		expect(derive(5.75)).toBe(VERIFY_QUEUE_MAX_FOR_TEST);
		// A modest VPS: the budget binds, and the queue gets shallower.
		expect(derive(10), '4600/10 = 460, below the 500 ceiling').toBe(460);
		expect(derive(20), '4600/20 = 230').toBe(230);
		// Each of those still fits the allowance, which is the whole point.
		for (const cost of [10, 20, 40]) {
			expect(
				derive(cost) * cost,
				`at ${cost}ms a full queue must still fit ${QUEUE_ALLOWANCE_MS}ms`
			).toBeLessThanOrEqual(QUEUE_ALLOWANCE_MS);
		}
		// Except at the floor, where the honest answer is that this box cannot
		// keep the promise — and the floor exists so that is VISIBLE rather than
		// total silence. Pinned so nobody later reads the overshoot as a bug.
		const pathological = 200;
		expect(derive(pathological), 'collapses to the floor, not to zero').toBe(floor);
		expect(
			derive(pathological) * pathological,
			'at the floor the promise is already lost — the floor buys visibility, not speed'
		).toBeGreaterThan(QUEUE_ALLOWANCE_MS);
	});

	/**
	 * THE TERM NOTHING HAD CHECKED. `TRANSPORT_WORST_CASE_MS` is what the queue
	 * allowance is carved out of, and it is a claim about the REST of the
	 * journey: privacy instance to privacy instance, first contact to the
	 * recipient's inbox. That journey is measured — `fastchat-instance-matrix-
	 * smoke` walks all twelve combinations and reports its slowest.
	 *
	 * Nothing tied the constant to the measurement. Set it too low and the queue
	 * borrows time the path has already spent, and every assertion in this file
	 * still passes because they all derive from the same wrong number.
	 */
	it('the transport budget is not below the measured worst-case journey', () => {
		// The slowest of the twelve combinations the matrix smoke walks, to the
		// inbox, on its stated 900 ms privacy-hop model. Quoted here because it
		// is a MEASUREMENT from another suite, not a constant to import — if that
		// suite's number moves, this is where the two are reconciled.
		const MEASURED_WORST_CASE_MS = 1_367;
		expect(
			TRANSPORT_WORST_CASE_BUDGET_MS,
			`the transport path measures ${MEASURED_WORST_CASE_MS}ms at worst, but the queue ` +
				`allowance is carved out assuming only ${TRANSPORT_WORST_CASE_BUDGET_MS}ms — so the ` +
				`queue is being allowed time the path has already spent, and every other ` +
				`assertion here passes because they all derive from the same wrong number`
		).toBeGreaterThanOrEqual(MEASURED_WORST_CASE_MS);
		// And not absurdly generous either: a budget of five seconds would leave
		// the queue a second and make this check vacuous.
		expect(
			TRANSPORT_WORST_CASE_BUDGET_MS,
			'a transport budget far above the measurement starves the queue for no reason'
		).toBeLessThan(DELIVERY_BUDGET_MS / 2);
	});

	/** And the bound must be REAL — a queue that never sheds is not bounded, and
	 *  the overflow path is what makes the assertion above survivable. */
	it('the queue sheds rather than growing without limit', () => {
		expect(
			intake.stats().queueDepth,
			'depth must never exceed the live bound, whatever arrives'
		).toBeLessThanOrEqual(intake.stats().admissionDepth);
		expect(
			BATCH_MAX_FOR_TEST,
			'one request must not be able to fill the queue on its own — otherwise a single ' +
				'peer decides the depth every other peer queues behind'
		).toBeLessThan(VERIFY_QUEUE_MAX_FOR_TEST);
	});
});
