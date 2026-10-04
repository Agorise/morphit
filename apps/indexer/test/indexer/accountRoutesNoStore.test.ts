/**
 * VT3-6 — every /v1 response that names an account says `Cache-Control:
 * no-store`, so neither the browser's disk cache nor any shared cache keeps a
 * user's conversations, read state, settings, folders, blocks, orders or
 * profile lookups after Sign out. They used to fall through to the global
 * default, `public, max-age=3`, and stayed on disk (URL and body).
 *
 * Route level: every route module that takes an account in its path (or as
 * an `account`/`accounts` query) is mounted at its real /v1 prefix behind the
 * real security middleware, with stub dependencies, and EVERY such route it
 * registers is requested. Handlers that fail on the stubs still answer through
 * the middleware, which is what is under test. A completeness check fails if a
 * module in src/api registers an account-named route this test does not mount.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { security } from '$api/middleware/security';
import { ordersByAccountRoute, orderByPermlinkRoute } from '$api/orders';
import { orderViewsRoute } from '$api/orderViews';
import { orderCounterpartiesRoute } from '$api/orderCounterparties';
import { feeCheckRoute } from '$api/feeCheck';
import { profilesRoute } from '$api/profiles';
import { accountBalanceRoute } from '$api/accountBalance';
import { accountHistoryRoute } from '$api/accountHistory';
import { accountKeysRoute } from '$api/accountKeys';
import { feedbackByAccountRoute } from '$api/feedback';
import { reputationReceiptRoute } from '$api/reputationReceipt';
import { chatRoute } from '$api/chat';
import { chatIdentityRoute } from '$api/chatIdentity';
import { conversationsRoute } from '$api/conversations';
import { chatReadStateRoute } from '$api/chatReadState';
import { chatFoldersRoute } from '$api/chatFolders';
import { settingsRoute } from '$api/settings';
import { blocksRoute } from '$api/blocks';
import { chatAdmissionRoute } from '$api/chatAdmission';
import { strangerFeeQuoteRoute } from '$api/strangerFeeQuote';
import { attestorEligibilityRoute } from '$api/attestorEligibility';
import { operatorRegistrationRoute } from '$api/operatorRegistration';
import { operatorBlocksRoute } from '$api/operatorBlocks';
import { featuredBidsRoute } from '$api/featuredBids';
import { chainExplorerRoute } from '$api/chainExplorer';

/** Answers every query with no rows. */
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
/** A chain client whose every read fails. */
const blurt = new Proxy(
	{},
	{ get: () => async () => Promise.reject(new Error('stub chain: no answer')) }
) as never;

/** [module file, prefix, sub-app] exactly as main.ts mounts them. */
const MOUNTED: [string, string, Hono][] = [
	['orders.ts', '/v1/orders', ordersByAccountRoute(db, 'operator')],
	['orders.ts', '/v1/orders', orderByPermlinkRoute(db, 'operator')],
	['orderViews.ts', '/v1/orders', orderViewsRoute(db)],
	['orderCounterparties.ts', '/v1/orders', orderCounterpartiesRoute(db)],
	[
		'feeCheck.ts',
		'/v1/orders',
		feeCheckRoute({
			db,
			current: () => ({ verifiers: {}, amounts: {} }),
			onChange: () => {}
		} as never)
	],
	['profiles.ts', '/v1/profiles', profilesRoute(db)],
	['accountBalance.ts', '/v1/account', accountBalanceRoute(blurt)],
	['accountHistory.ts', '/v1/account', accountHistoryRoute(blurt)],
	['accountKeys.ts', '/v1/account', accountKeysRoute(blurt)],
	['feedback.ts', '/v1/accounts', feedbackByAccountRoute(db)],
	['reputationReceipt.ts', '/v1/accounts', reputationReceiptRoute(db)],
	['chat.ts', '/v1/chat', chatRoute(db)],
	['chatIdentity.ts', '/v1/chat-identity', chatIdentityRoute(db)],
	['conversations.ts', '/v1/conversations', conversationsRoute(db)],
	['chatReadState.ts', '/v1/chat-read-state', chatReadStateRoute(db)],
	['chatFolders.ts', '/v1/chat-folders', chatFoldersRoute(db)],
	['settings.ts', '/v1/settings', settingsRoute(db)],
	['blocks.ts', '/v1/blocks', blocksRoute(db)],
	['chatAdmission.ts', '/v1/chat-admission', chatAdmissionRoute(db)],
	['strangerFeeQuote.ts', '/v1/stranger-fee-quote', strangerFeeQuoteRoute(db)],
	[
		'attestorEligibility.ts',
		'/v1/attestor-eligibility',
		attestorEligibilityRoute(db, { attestationPhase: 'launch' } as never)
	],
	['operatorRegistration.ts', '/v1/operator-registration', operatorRegistrationRoute(db)],
	['operatorBlocks.ts', '/v1/operator-blocks', operatorBlocksRoute(db, 'operator')],
	['featuredBids.ts', '/v1/orderbook/featured/bids', featuredBidsRoute(db, 'operator')]
];

/** Not requested here: the streams (chatStream, chatActivityStream) set no-store
 *  themselves and hold the connection open; rssOrderbook.ts is served under
 *  /rss, not /v1 — a public feed for feed readers, which must cache it. */
const NOT_V1_JSON = new Set(['chatStream.ts', 'chatActivityStream.ts', 'rssOrderbook.ts']);

const app = new Hono();
app.use('*', security);
for (const [, prefix, sub] of MOUNTED) app.route(prefix, sub);
const chain = new Hono();
chain.route('/', chainExplorerRoute(blurt, db));
app.route('/v1/chain', chain);

/** Path parameters that carry an account name in src/api. */
const ACCOUNT_ROUTE_PARAMS = new Set([
	'account',
	'a',
	'b',
	'me',
	'peer',
	'owner',
	'operator',
	'sender'
]);
const PARAM = /:([A-Za-z_]+)/g;
const namesAccount = (path: string): boolean =>
	[...path.matchAll(PARAM)].some((m) => ACCOUNT_ROUTE_PARAMS.has(m[1]!));
const fill = (path: string): string =>
	path.replace(PARAM, (_, name: string) => (name === 'permlink' ? 'my-order' : 'alice'));

describe('account-named /v1 responses are never stored (VT3-6)', () => {
	const routes = [
		...new Map(
			app.routes
				.filter((r) => r.method !== 'ALL' && namesAccount(r.path))
				.map((r) => [`${r.method} ${r.path}`, r] as const)
		).values()
	];

	it('every account-named route is mounted here (none missed)', () => {
		const dir = join(__dirname, '..', '..', 'src', 'api');
		const mountedFiles = new Set(MOUNTED.map(([f]) => f));
		const missing: string[] = [];
		for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
			const src = readFileSync(join(dir, f), 'utf8');
			const paths = [...src.matchAll(/\.(?:get|post|put|delete)\(\s*'([^']*)'/g)].map((m) => m[1]!);
			const queryNamed = /req\.query\('accounts?'\)/.test(src);
			if ((paths.some(namesAccount) || queryNamed) && !mountedFiles.has(f) && !NOT_V1_JSON.has(f)) {
				missing.push(f);
			}
		}
		expect(missing).toEqual([]);
		expect(routes.length).toBeGreaterThanOrEqual(30);
	});

	it('every account-named route answers Cache-Control: no-store', async () => {
		const stored: string[] = [];
		for (const r of routes) {
			const res = await app.request(fill(r.path), { method: r.method });
			const cc = res.headers.get('cache-control') ?? '';
			if (!/\bno-store\b/.test(cc)) stored.push(`${r.method} ${r.path} -> ${res.status} ${cc}`);
		}
		expect(stored).toEqual([]);
	});

	it('account lookups by query (?account= / ?accounts=) are not stored either', async () => {
		for (const url of [
			'/v1/orderbook/featured/bids?account=alice',
			'/v1/profiles?accounts=alice,bob'
		]) {
			const res = await app.request(url);
			expect(res.headers.get('cache-control'), url).toMatch(/\bno-store\b/);
		}
	});

	it('a response that names no account keeps its own caching', async () => {
		const res = await app.request('/v1/chain/block/5');
		expect(res.headers.get('cache-control') ?? '').not.toMatch(/\bno-store\b/);
	});
});
