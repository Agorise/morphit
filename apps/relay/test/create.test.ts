/**
 * Create endpoint test.
 *
 * Approach: spin up a Hono app with a stubbed BlurtClient + a stub
 * HealthService. Exercise each branch of the handler: rate limit,
 * funds check, validation failures, pubkey failures, dedupe, chain
 * error mapping.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import { CreateEndpoint } from '../src/api/create.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { GlobalDailyCeiling } from '../src/policy/globalDailyCeiling.ts';
import { InviteTokenService } from '../src/policy/inviteToken.ts';
import type {
	BlurtClient,
	AccountInfo,
	ChainProperties,
	AccountCreateResult
} from '../src/blurt/client.ts';
import type { HealthService } from '../src/api/health.ts';
import type { Config, UnlockedConfig } from '../src/config/index.ts';

// Four well-formed BLT pubkeys — derived from deterministic seeds
// using dblurt's PrivateKey.fromSeed(...).createPublic('BLT'), so
// they pass the relay's full checksum validation.  Pre-fix these
// were hand-crafted strings that LOOKED like BLT keys but failed
// the secp256k1 checksum, so every test broke at the pubkey gate.
// Distinct seeds for each role so the "distinct keys" assertion
// passes naturally.
const PK_OWNER = 'BLT6tQ3TvXC7QEmhn6N5B8uypLvSq87hRTqo6dXLPQa1VF6rL2rWj';
const PK_ACTIVE = 'BLT5BfHvSM53aV8QgMCsS44orWkw22FYLw5f7NuyGgAL5Pn4iJWRx';
const PK_POSTING = 'BLT8BbEtQPBhJqpYcRwSgxaSemixJrW39jqNCM1r1kbiqX121447F';
const PK_MEMO = 'BLT5z8xHvq83VJyxgzu6ADEyP8yJCHbmSrCD2JBYNuKwyumcv7f1f';

function validOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		op: {
			new_account_name: 'sally',
			owner: { weight_threshold: 1, account_auths: [], key_auths: [[PK_OWNER, 1]] },
			active: { weight_threshold: 1, account_auths: [], key_auths: [[PK_ACTIVE, 1]] },
			posting: { weight_threshold: 1, account_auths: [], key_auths: [[PK_POSTING, 1]] },
			memo_key: PK_MEMO,
			json_metadata: '',
			...overrides
		}
	};
}

interface StubBlurt {
	client: BlurtClient;
	getAccount: ReturnType<typeof vi.fn>;
	getChainProperties: ReturnType<typeof vi.fn>;
	broadcastAccountCreate: ReturnType<typeof vi.fn>;
	broadcastTransfer: ReturnType<typeof vi.fn>;
}

function makeStubBlurt(
	overrides: {
		getAccount?: AccountInfo | null | Error;
		getChainProperties?: ChainProperties | Error;
		broadcastAccountCreate?: AccountCreateResult | Error;
		broadcastTransfer?: AccountCreateResult | Error;
	} = {}
): StubBlurt {
	const getAccount = vi.fn(async () => {
		if (overrides.getAccount instanceof Error) throw overrides.getAccount;
		return overrides.getAccount ?? null;
	});
	const getChainProperties = vi.fn(async () => {
		if (overrides.getChainProperties instanceof Error) throw overrides.getChainProperties;
		return (
			overrides.getChainProperties ?? {
				account_creation_fee: '100.000 BLURT',
				maximum_block_size: 65536
			}
		);
	});
	const broadcastAccountCreate = vi.fn(async () => {
		if (overrides.broadcastAccountCreate instanceof Error) throw overrides.broadcastAccountCreate;
		return (
			overrides.broadcastAccountCreate ?? {
				id: 'abc123',
				block_num: 12345678,
				trx_num: 0,
				expired: false
			}
		);
	});
	// ADR-0010 §2 step 4: broadcastTransfer is called after
	// account_create to send 1 BLURT signup dust. Mock returns a
	// different id so tests can distinguish the two broadcasts.
	const broadcastTransfer = vi.fn(async () => {
		if (overrides.broadcastTransfer instanceof Error) throw overrides.broadcastTransfer;
		return (
			overrides.broadcastTransfer ?? {
				id: 'dust123',
				block_num: 12345679,
				trx_num: 0,
				expired: false
			}
		);
	});
	const client = {
		getAccount,
		getChainProperties,
		broadcastAccountCreate,
		broadcastTransfer
	} as unknown as BlurtClient;
	return {
		client,
		getAccount,
		getChainProperties,
		broadcastAccountCreate,
		broadcastTransfer
	};
}

function makeStubHealth(canAccept = true): HealthService {
	return {
		canAcceptCreation: () => canAccept,
		creationsRemaining: () => (canAccept ? 100 : 0)
	} as unknown as HealthService;
}

function makeStubConfig(): UnlockedConfig {
	return {
		relayAccount: 'morphit-relay',
		relayActiveKeyWif: '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe',
		relayActiveKeyEnvelope: undefined,
		listenHost: '127.0.0.1',
		listenPort: 8080,
		publicOrigin: 'https://relay.morphit.io',
		blurtRpcEndpoints: ['https://rpc.blurt.blog'],
		allowedOrigins: ['https://morphit.io'],
		availabilityRatePerMin: 60,
		createRatePerHour: 5,
		createRatePerDay: 2,
		maxRequestBodyBytes: 64 * 1024,
		signupEnabled: true,
		signupDailyCeiling: 50,
		signupCeilingPersistPath: null,
		dataDir: null,
		createSpacingMinutes: 60,
		altchaTriggerCount: 3,
		altchaMaxnumber: 100_000,
		inviteHmacSecret: undefined,
		altchaHmacSecret: undefined,
		highValueNamePolicy: 'off' as const,
		highValueShortNameThreshold: 4,
		sequentialDetectorEnabled: false,
		sequentialWindowMs: 3_600_000,
		sequentialThreshold: 2,
		sequentialMinPrefix: 3,
		trustedProxyIps: '',
		databaseUrl: 'postgres://ignored',
		queuePollIntervalMs: 60_000,
		queueBatchSize: 20,
		queueMaxRetries: 10,
		verboseHealth: true,
		accountCreationFeeBlurt: 100,
		vapidPublicKey: undefined,
		vapidPrivateKey: undefined,
		vapidSubject: undefined,
		pushEnabled: false,
		pushPollIntervalMs: 30_000,
		pushBatchSize: 50,
		pushMaxAgeSeconds: 3600,
		pushMaxConsecutiveFailures: 5,
		pushRequireSigned: false
	};
}

function makeApp(
	stub: StubBlurt,
	health: HealthService,
	maxPerHour = 1000,
	maxPerDay = 10_000,
	options: {
		signupEnabled?: boolean;
		dailyCeiling?: number;
		spacingMinutes?: number;
	} = {}
): {
	app: Hono;
	limiter: Limiter;
	dailyLimiter: Limiter;
	inviteTokens: InviteTokenService;
	ceiling: GlobalDailyCeiling;
} {
	const app = new Hono();
	const limiter = new Limiter(maxPerHour, 60 * 60_000);
	// Permissive default so tests not focused on rate-limit
	// behavior aren't affected. Individual tests lower this to
	// assert the daily cap path.
	const dailyLimiter = new Limiter(maxPerDay, 24 * 60 * 60_000);
	// Signup-drain prevention services. Constructed per-test
	// with a fresh random secret so invites from one test can't
	// leak into another.
	const inviteTokens = new InviteTokenService({ ttlMs: 10 * 60_000 });
	const ceiling = new GlobalDailyCeiling(options.dailyCeiling ?? 10_000);
	const endpoint = new CreateEndpoint(
		makeStubConfig(),
		stub.client,
		limiter,
		dailyLimiter,
		options.spacingMinutes ?? 0, // 0 disables spacing for most tests
		health,
		options.signupEnabled ?? true,
		ceiling,
		inviteTokens,
		null, // killSwitch
		// Disable Layer 7 + Layer 8 in tests that aren't about
		// those features.  Tests that DO target these layers should
		// instantiate CreateEndpoint directly with the required
		// settings, OR makeApp should be extended with options
		// to enable them.  Default-off-for-tests preserves the
		// historical behavior of these tests (which use names like
		// 'bob' and 'sally' that would otherwise trip the
		// short-name guard).
		'off',
		4,
		null
	);
	endpoint.register(app);
	return { app, limiter, dailyLimiter, inviteTokens, ceiling };
}

interface CreateResponse {
	status?: string;
	code?: string;
	reason?: string;
	message?: string;
	block_num?: number;
	trx_id?: string;
	note?: string;
	retry_after_minutes?: number;
	resets_at?: string;
}

/** Issue an invite token bound to the IP that Hono's app.request()
 *  sees in tests. clientIp() returns 'unknown' for the test
 *  adapter (no socket info), so every in-test request shares that
 *  IP bucket. Invites issued to 'unknown' are accepted. */
function freshInviteFor(service: InviteTokenService): string {
	return service.issue('unknown').token;
}

async function post(
	app: Hono,
	body: unknown,
	opts: {
		/** If true, send the body exactly as-is (caller responsible
		 *  for invite_token). If false, merge in a fresh invite. */
		raw?: boolean;
		inviteTokens?: InviteTokenService;
	} = {}
): Promise<{ status: number; body: CreateResponse }> {
	let payload: unknown = body;
	if (!opts.raw && opts.inviteTokens && typeof body === 'object' && body !== null) {
		payload = {
			invite_token: freshInviteFor(opts.inviteTokens),
			...(body as Record<string, unknown>)
		};
	}
	const res = await app.request('/v1/account/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof payload === 'string' ? payload : JSON.stringify(payload)
	});
	const json = (await res.json().catch(() => ({}))) as CreateResponse;
	return { status: res.status, body: json };
}

describe('POST /v1/account/create', () => {
	const limiters: Limiter[] = [];

	beforeEach(() => {
		limiters.length = 0;
	});

	afterEach(() => {
		for (const l of limiters) l.close();
	});

	it('happy path: signs + broadcasts + returns trx_id', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(200);
		expect(body.status).toBe('broadcast');
		expect(body.trx_id).toBe('abc123');
		expect(body.block_num).toBe(12345678);
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
	});

	it('short-circuits with relay_out_of_funds when health says no', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(false));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(503);
		expect(body.code).toBe('relay_out_of_funds');
		expect(stub.getAccount).not.toHaveBeenCalled();
		expect(stub.broadcastAccountCreate).not.toHaveBeenCalled();
	});

	it('enforces rate limit', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true), 1);
		limiters.push(limiter, dailyLimiter);

		await post(app, validOp(), { inviteTokens });
		const { status, body } = await post(app, validOp({ new_account_name: 'bob' }), {
			inviteTokens
		});
		expect(status).toBe(429);
		expect(body.code).toBe('rate_limited');
	});

	it('enforces daily rate limit with distinct error code', async () => {
		// Daily limit of 2, per-hour limit permissive (1000). Third
		// signup in the same day should hit the daily cap with
		// 'rate_limited_daily', NOT 'rate_limited'.
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			2
		);
		limiters.push(limiter, dailyLimiter);

		await post(app, validOp(), { inviteTokens });
		await post(app, validOp({ new_account_name: 'bob' }), { inviteTokens });
		const { status, body } = await post(app, validOp({ new_account_name: 'carol' }), {
			inviteTokens
		});
		expect(status).toBe(429);
		expect(body.code).toBe('rate_limited_daily');
	});

	it('rejects structurally-bad names with name_not_allowed', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp({ new_account_name: 'morphit' }), {
			inviteTokens
		});
		expect(status).toBe(400);
		expect(body.code).toBe('name_not_allowed');
		expect(body.reason).toBe('reserved');
	});

	it('rejects invalid pubkeys with invalid_pubkey', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		// Replace memo_key with a non-BLT string.
		const { status, body } = await post(app, validOp({ memo_key: 'STMnotablurtkey' }), {
			inviteTokens
		});
		expect(status).toBe(400);
		expect(body.code).toBe('invalid_pubkey');
		expect(body.reason).toBe('memo');
	});

	it('rejects duplicate keys across roles', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		// Reuse the owner key as the active key.
		const dup = validOp({
			active: { weight_threshold: 1, account_auths: [], key_auths: [[PK_OWNER, 1]] }
		});
		const { status, body } = await post(app, dup, { inviteTokens });
		expect(status).toBe(400);
		expect(body.code).toBe('malformed_operation');
		expect(body.message).toMatch(/distinct/);
	});

	it('rejects already-registered names with already_registered', async () => {
		const stub = makeStubBlurt({
			getAccount: {
				name: 'sally',
				created: '2024-01-01',
				balance: '0.000 BLURT',
				pending_claimed_accounts: 0,
			posting_pubkey: undefined
			}
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(409);
		expect(body.code).toBe('already_registered');
		expect(stub.broadcastAccountCreate).not.toHaveBeenCalled();
	});

	it('maps chain-level already_registered (TOCTOU) to the same code', async () => {
		// getAccount says the name is free, but the broadcast rejects
		// with an already_registered error (another actor claimed it
		// in the window between check and broadcast).
		const stub = makeStubBlurt({
			broadcastAccountCreate: new Error('account_already_exists: sally')
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(409);
		expect(body.code).toBe('already_registered');
	});

	it('O1: duplicate-transaction after retry is treated as success', async () => {
		// Failure mode: callWithRotation retries broadcastAccountCreate
		// after a transport timeout, but the FIRST broadcast actually
		// landed.  The chain rejects the retry with a "duplicate
		// transaction" error.  Pre-O1, this fell through to a generic
		// broadcast_failed and the user retried with a different name
		// while their original account quietly existed on-chain.
		// Post-O1, we look up the account and surface success if it
		// exists.

		const stub = makeStubBlurt({
			broadcastAccountCreate: new Error('duplicate transaction in pending pool')
		});
		// Override getAccount so the FIRST call (availability pre-check)
		// returns null but the POST-broadcast verification call returns
		// the account on-chain.
		stub.getAccount.mockReset();
		stub.getAccount
			.mockResolvedValueOnce(null) // pre-check: free
			.mockResolvedValueOnce({
				name: 'sally',
				created: '2026-05-06T00:00:00',
				balance: '0.000 BLURT',
				pending_claimed_accounts: 0,
			posting_pubkey: undefined
			}); // post-failure: account does exist

		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(200);
		expect(body.status).toBe('broadcast');
		expect(body.note).toBe('duplicate_after_retry');
	});

	it('O1: duplicate-transaction with no on-chain account falls through', async () => {
		// Failure mode where the chain reports "duplicate" but the
		// account isn't actually present (e.g. the duplicate refers to
		// some unrelated tx with a colliding id, or the chain RPC is
		// simply broken).  Should fall through to the generic error
		// path so the user can retry with a different name rather than
		// being told they succeeded when they didn't.

		const stub = makeStubBlurt({
			broadcastAccountCreate: new Error('duplicate transaction')
		});
		stub.getAccount.mockReset();
		stub.getAccount
			.mockResolvedValueOnce(null) // pre-check: free
			.mockResolvedValueOnce(null); // post-failure: still no account

		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		// Falls through to the generic broadcast_failed path.
		expect(status).toBe(502);
		expect(body.code).toBe('broadcast_failed');
	});

	it('dedupes identical submissions within the window', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		// First one broadcasts fine. The stub returns the same result
		// each time, so we can't distinguish by result — but we CAN
		// check that broadcastAccountCreate is only called once.
		await post(app, validOp(), { inviteTokens });
		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(409);
		expect(body.code).toBe('duplicate_submission');
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
	});

	it('rejects missing Content-Type body shape with malformed_operation', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, 'not json', { raw: true });
		expect(status).toBe(400);
		expect(body.code).toBe('malformed_operation');
	});

	// ─── ADR-0010 §2 step 4: signup dust ─────────────────────────
	it('sends 1 BLURT dust to the new account after successful creation', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(200);
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
		expect(stub.broadcastTransfer).toHaveBeenCalledTimes(1);
		// Check the dust goes to the new account, not to some random
		// name. The exact account name comes from validOp's
		// new_account_name field.
		const call = stub.broadcastTransfer.mock.calls[0]![0];
		expect(call.to).toBe('sally');
		expect(call.amountBlurt).toBe(1);
		expect(call.memo).toBe('morphit:signup_dust');
	});

	it('returns success even when signup dust broadcast fails', async () => {
		// The account is already created on-chain; the dust is
		// best-effort. A failed dust doesn't fail the user-facing
		// signup.
		const stub = makeStubBlurt({
			broadcastTransfer: new Error('rpc timeout')
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(200);
		expect(body.status).toBe('broadcast');
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
		expect(stub.broadcastTransfer).toHaveBeenCalledTimes(1);
	});

	it('does NOT send dust when account_create itself failed', async () => {
		// If account_create threw, the account doesn't exist.
		// Sending dust would be meaningless and also would increase
		// the blast radius of a bug — so we skip the transfer
		// entirely.
		const stub = makeStubBlurt({
			broadcastAccountCreate: new Error('account_already_exists')
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		const { status } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(409);
		// No dust should have been sent.
		expect(stub.broadcastTransfer).not.toHaveBeenCalled();
	});

	// ─── Signup-drain prevention ────────────────────────────────
	// These tests exercise the layered defenses added for
	// docs/OPERATIONS.md §18: kill-switch, global daily ceiling,
	// per-IP spacing, invite tokens. They cover the attacker-
	// facing rejection paths specifically.

	it('rejects missing invite_token with malformed_operation', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		// Call post() with raw: true so no invite_token is injected.
		const { status, body } = await post(app, validOp(), { raw: true });
		expect(status).toBe(400);
		expect(body.code).toBe('malformed_operation');
		expect(stub.broadcastAccountCreate).not.toHaveBeenCalled();
	});

	it('rejects reused invite_token with invite_already_used', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(stub, makeStubHealth(true));
		limiters.push(limiter, dailyLimiter);

		// Mint ONE invite token, then manually reuse it across two
		// requests. The second must reject.
		const token = inviteTokens.issue('unknown').token;
		const bodyOne = { invite_token: token, ...validOp() };
		const bodyTwo = {
			invite_token: token,
			...validOp({ new_account_name: 'bob' })
		};

		const first = await post(app, bodyOne, { raw: true });
		expect(first.status).toBe(200);

		const second = await post(app, bodyTwo, { raw: true });
		expect(second.status).toBe(410);
		expect(second.body.code).toBe('invite_already_used');
	});

	it('kill-switch: signupEnabled=false rejects with signups_disabled', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			10_000,
			{ signupEnabled: false }
		);
		limiters.push(limiter, dailyLimiter);

		const { status, body } = await post(app, validOp(), { inviteTokens });
		expect(status).toBe(503);
		expect(body.code).toBe('signups_disabled');
		expect(stub.broadcastAccountCreate).not.toHaveBeenCalled();
	});

	it('global ceiling: rejects once ceiling hit', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens, ceiling } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			10_000,
			{ dailyCeiling: 1 } // one signup per day ceiling
		);
		limiters.push(limiter, dailyLimiter);

		// First signup succeeds.
		const first = await post(app, validOp(), { inviteTokens });
		expect(first.status).toBe(200);
		expect(ceiling.currentCount()).toBe(1);

		// Second signup hits the ceiling.
		const second = await post(app, validOp({ new_account_name: 'bob' }), {
			inviteTokens
		});
		expect(second.status).toBe(503);
		expect(second.body.code).toBe('daily_ceiling_reached');
		expect(second.body.resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
	});

	it('per-IP spacing: rejects second signup within cooldown with spacing_cooldown', async () => {
		const stub = makeStubBlurt();
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			10_000,
			{ spacingMinutes: 60 } // 1hr between signups per IP
		);
		limiters.push(limiter, dailyLimiter);

		// First signup succeeds.
		const first = await post(app, validOp(), { inviteTokens });
		expect(first.status).toBe(200);

		// Second signup, same IP ('unknown' in tests), immediately after —
		// should be blocked by spacing (NOT by daily quota).
		const second = await post(app, validOp({ new_account_name: 'bob' }), {
			inviteTokens
		});
		expect(second.status).toBe(429);
		expect(second.body.code).toBe('spacing_cooldown');
		expect(second.body.retry_after_minutes).toBeGreaterThan(0);
		expect(second.body.retry_after_minutes).toBeLessThanOrEqual(60);
		// Message uses the friendly copy the user specified:
		// "You recently created an account. Please wait N more minutes..."
		expect(second.body.message).toMatch(/You recently created an account/);
		expect(stub.broadcastAccountCreate).toHaveBeenCalledTimes(1);
	});

	it('username search: already-taken names do NOT consume daily quota or spacing', async () => {
		// Real failure mode: a legitimate user picks a Blurt username
		// they like, but it's already registered.  They try a second
		// option, also taken.  They should be able to keep trying
		// without burning their daily quota or hitting the
		// 60-min spacing cooldown.  Only an actually-successful
		// broadcast consumes a daily-cap slot.
		const stub = makeStubBlurt({
			// Pre-check finds the name already exists on chain.
			getAccount: {
				name: 'taken',
				created: '2025-01-01T00:00:00',
				balance: '0.000 BLURT',
				pending_claimed_accounts: 0,
			posting_pubkey: undefined
			}
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			2, // daily cap of 2 — would be exhausted in 2 attempts pre-fix
			{ spacingMinutes: 60 }
		);
		limiters.push(limiter, dailyLimiter);

		// Three back-to-back attempts on already-registered names.
		// Pre-fix, the FIRST would 409 + burn a slot, the SECOND
		// would 409 + burn the second slot, and the THIRD would
		// hit `rate_limited_daily`.  Post-fix, all three return
		// `already_registered` (the substantive error) and the
		// daily-cap slot stays available for an actual broadcast.
		const r1 = await post(app, validOp({ new_account_name: 'alice' }), {
			inviteTokens
		});
		expect(r1.status).toBe(409);
		expect(r1.body.code).toBe('already_registered');

		const r2 = await post(app, validOp({ new_account_name: 'bob' }), {
			inviteTokens
		});
		expect(r2.status).toBe(409);
		expect(r2.body.code).toBe('already_registered');

		const r3 = await post(app, validOp({ new_account_name: 'carol' }), {
			inviteTokens
		});
		expect(r3.status).toBe(409);
		expect(r3.body.code).toBe('already_registered');

		// The relay should never have called broadcast — every
		// attempt was caught by the pre-broadcast availability check.
		expect(stub.broadcastAccountCreate).not.toHaveBeenCalled();

		// Now switch to a free name — it should succeed (the daily
		// quota wasn't exhausted by the failed lookups).
		stub.getAccount.mockReset();
		stub.getAccount.mockResolvedValue(null);
		const r4 = await post(app, validOp({ new_account_name: 'dave' }), {
			inviteTokens
		});
		expect(r4.status).toBe(200);
		expect(r4.body.status).toBe('broadcast');
	});

	it('username search: TOCTOU already_registered does NOT consume daily quota', async () => {
		// Variant of the above: pre-check says the name is free,
		// but by the time the broadcast lands, someone else has
		// claimed it (chain returns account_already_exists).  The
		// user should not be charged a daily-cap slot for losing
		// the race — they should be able to immediately try
		// another name.
		const stub = makeStubBlurt({
			broadcastAccountCreate: new Error('account_already_exists: alice')
		});
		const { app, limiter, dailyLimiter, inviteTokens } = makeApp(
			stub,
			makeStubHealth(true),
			1000,
			2,
			{ spacingMinutes: 60 }
		);
		limiters.push(limiter, dailyLimiter);

		const r1 = await post(app, validOp({ new_account_name: 'alice' }), {
			inviteTokens
		});
		expect(r1.status).toBe(409);
		expect(r1.body.code).toBe('already_registered');

		// Switch to a name where broadcast WILL succeed.  This is
		// the user's second attempt; the daily cap is 2 and they
		// haven't burned a slot yet, so this should succeed (not
		// hit spacing_cooldown).
		stub.broadcastAccountCreate.mockReset();
		stub.broadcastAccountCreate.mockResolvedValue({
			id: 'tx_success',
			block_num: 100,
			trx_num: 0,
			expired: false
		});
		const r2 = await post(app, validOp({ new_account_name: 'bob' }), {
			inviteTokens
		});
		expect(r2.status).toBe(200);
		expect(r2.body.status).toBe('broadcast');
	});
});
