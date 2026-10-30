/**
 * Is this the relay account's ACTIVE key? — asked of the chain, not of the
 * operator.
 *
 * `show-key` and `register` used to print the public key and send the operator
 * to a clearnet block explorer to compare it by eye; `edit-active-key` wrote
 * whatever was pasted and said the relay would check it (it did not). Now the
 * public key is compared with the keys the chain lists for the account, and
 * the answer is printed as ✓ matches / ✗ does not match, naming which key it
 * is when it is the wrong one.
 *
 * WHO IS BELIEVED (review, 2026-10-29). A "does not match" or "no such
 * account" answer stops something — edit-active-key refuses the key, register
 * (also the unattended run when the node first comes online) publishes
 * nothing — so it must come from TWO RPC operators that agree, never from one
 * node: a node still replaying the chain answers "no such account" for
 * everyone, and a lagging one names the keys from before a key change. It used
 * to be one node's answer. In order:
 *   1. this node's own indexer, GET /v1/account/<name>/keys — it answers only
 *      what two RPC operators of its full pool (clearnet and .onion/.i2p)
 *      agree on (404 when they agree there is no such account);
 *   2. not on a hidden-only node: the clearnet RPC nodes asked directly, two
 *      operators (counted by node name) agreeing;
 *   3. one answer, through chainRead (the indexer's relay, then the pool).
 *      "This key is right" may come from one node — believing it wrongly only
 *      lets the operator go on, and the chain (and the relay's own check, which
 *      needs two operators) still judges the key. A refusing answer from one
 *      node is reported as "could not be checked", with what that node said.
 */
import { EndpointPool } from '@morphit/rpc-pool';
import { rpcEndpointOperator } from '@morphit/operator-config';
import {
	chainRead,
	clearnetEndpoints,
	jsonRpc,
	rpcHealthStatePath,
	type ChainAccessDeps
} from './chainAccess.ts';
import { isHiddenOnlyNode, LocalIndexerAnswerError, localIndexerJson } from './hiddenOnly.ts';

export type KeyOnChain =
	/** On the active authority (alone meets its threshold): the right key. */
	| { readonly kind: 'active' }
	/** On the OWNER authority: it can sign, but it is the account's master key. */
	| { readonly kind: 'owner' }
	| {
			readonly kind: 'wrong';
			/** Which of the account's keys it is instead (null: none of them). */
			readonly foundAs: 'posting' | 'memo' | null;
			/** The account's active key(s) as the chain lists them. */
			readonly activeKeys: readonly string[];
	  }
	/** On the active authority, but its weight is below the threshold: it
	 *  cannot sign alone (a multi-key authority, two of two keys say). */
	| {
			readonly kind: 'weak';
			readonly weight: number;
			readonly threshold: number;
	  }
	| { readonly kind: 'no-account' }
	/** Could not be decided: the chain could not be read, only one node
	 *  answered a refusing verdict (`unconfirmed`: what it said), or the active
	 *  authority also lets other accounts sign. */
	| { readonly kind: 'unknown'; readonly why: string; readonly unconfirmed?: KeyOnChain };

/** The public key (BLT…) of a WIF. Throws when it is not a valid private key. */
export async function publicKeyOf(wif: string): Promise<string> {
	const dblurt = (await import('@beblurt/dblurt')) as unknown as {
		PrivateKey: {
			fromString(wif: string): { createPublic(prefix?: string): { toString(): string } };
		};
	};
	return dblurt.PrivateKey.fromString(wif).createPublic('BLT').toString();
}

interface Authority {
	readonly weight_threshold?: unknown;
	readonly account_auths?: unknown;
	readonly key_auths?: unknown;
}

function keysAlone(a: Authority | undefined): string[] {
	const threshold = Number(a?.weight_threshold ?? 1);
	const list = Array.isArray(a?.key_auths) ? a.key_auths : [];
	return list
		.filter(
			(k): k is [string, number] =>
				Array.isArray(k) &&
				typeof k[0] === 'string' &&
				Number.isFinite(threshold) &&
				Number(k[1]) >= threshold
		)
		.map((k) => k[0]);
}

function keysListed(a: Authority | undefined): string[] {
	const list = Array.isArray(a?.key_auths) ? a.key_auths : [];
	return list
		.filter((k): k is [string, number] => Array.isArray(k) && typeof k[0] === 'string')
		.map((k) => k[0]);
}

/** Decide from one `get_accounts` answer. PURE. */
export function judgeKeyOnChain(publicKey: string, accounts: unknown, account: string): KeyOnChain {
	const acct = Array.isArray(accounts)
		? (accounts as Array<Record<string, unknown> | null>).find((a) => a?.name === account)
		: undefined;
	if (acct === undefined || acct === null) return { kind: 'no-account' };
	const active = acct.active as Authority | undefined;
	if (keysAlone(active).includes(publicKey)) return { kind: 'active' };
	if (keysAlone(acct.owner as Authority | undefined).includes(publicKey)) return { kind: 'owner' };
	if (Array.isArray(active?.account_auths) && active.account_auths.length > 0)
		return {
			kind: 'unknown',
			why: `@${account}'s active authority also lets other accounts sign, so a key that is not listed may still be valid`
		};
	const listed = (Array.isArray(active?.key_auths) ? active.key_auths : []).find(
		(k): k is [string, unknown] => Array.isArray(k) && k[0] === publicKey
	);
	if (listed !== undefined)
		return {
			kind: 'weak',
			weight: Number(listed[1]),
			threshold: Number(active?.weight_threshold ?? 1)
		};
	return {
		kind: 'wrong',
		foundAs: keysListed(acct.posting as Authority | undefined).includes(publicKey)
			? 'posting'
			: acct.memo_key === publicKey
				? 'memo'
				: null,
		activeKeys: keysListed(active)
	};
}

/** A verdict that stops something, so it needs two operators. */
function refuses(v: KeyOnChain): boolean {
	return v.kind === 'wrong' || v.kind === 'no-account' || v.kind === 'weak';
}

/** One account's authorities, reduced to what must match between two nodes
 *  (every authority with its keys in order, and the memo key). PURE. */
function authoritiesKey(acct: Record<string, unknown> | undefined): string {
	if (acct === undefined) return 'none';
	const auth = (a: unknown): unknown => {
		const x = (a ?? {}) as Authority;
		const pairs = (v: unknown): string[] =>
			Array.isArray(v) ? v.map((p) => JSON.stringify(p)).sort() : [];
		return [x.weight_threshold ?? null, pairs(x.key_auths), pairs(x.account_auths)];
	};
	return JSON.stringify([
		acct.name,
		auth(acct.owner),
		auth(acct.active),
		auth(acct.posting),
		acct.memo_key ?? null
	]);
}

/** The account as this node's indexer serves it once two RPC operators agree:
 *  `[account]`, `[]` (they agree there is none), or null (it could not say). */
async function indexerAgreedAccount(
	account: string,
	deps: ChainAccessDeps,
	hidden: boolean
): Promise<unknown[] | null> {
	try {
		const body = await localIndexerJson<{ account?: unknown } | null>(
			`/v1/account/${encodeURIComponent(account)}/keys`,
			{},
			{ timeoutMs: hidden ? 65_000 : 15_000, bases: deps.indexerBases }
		);
		const acct = body?.account as Record<string, unknown> | undefined;
		if (acct === undefined || acct === null || typeof acct !== 'object' || acct.name !== account)
			return null;
		return [acct];
	} catch (err) {
		// Its own words for "the operators agree there is no such account" — not
		// any 404 (an older indexer without this route answers 404 too).
		if (
			err instanceof LocalIndexerAnswerError &&
			err.status === 404 &&
			/no such account/i.test(err.message)
		)
			return [];
		return null;
	}
}

/** The clearnet RPC nodes asked directly: the account as two operators
 *  (counted by node name) agree it is, or null. */
async function clearnetAgreedAccount(
	account: string,
	deps: ChainAccessDeps
): Promise<unknown[] | null> {
	const endpoints = clearnetEndpoints(deps);
	if (endpoints.length < 2) return null;
	try {
		const pool = new EndpointPool({
			endpoints,
			healthStatePath: deps.healthStatePath ?? rpcHealthStatePath(),
			operatorOf: (url) => rpcEndpointOperator(url)
		});
		const r = await pool.quorumCall<string>(
			async (url, signal) => {
				const list = await jsonRpc(url, 'condenser_api.get_accounts', [[account]], signal, 10_000);
				if (!Array.isArray(list)) return null;
				const acct = (list as Array<Record<string, unknown> | null>).find(
					(a) => a?.name === account
				);
				return JSON.stringify({ key: authoritiesKey(acct ?? undefined), acct: acct ?? null });
			},
			{
				equivalenceKey: (v) => (JSON.parse(v) as { key: string }).key,
				minAgree: 2,
				maxOperators: 3,
				timeoutMs: 10_000
			}
		);
		if (r.agreedKey === undefined) return null;
		const hit = r.responses.find((v) => (JSON.parse(v) as { key: string }).key === r.agreedKey);
		if (hit === undefined) return null;
		const acct = (JSON.parse(hit) as { acct: unknown }).acct;
		return acct === null ? [] : [acct];
	} catch {
		return null;
	}
}

/** Compare `publicKey` with `account`'s keys on the chain. Never throws. A
 *  refusing verdict ('wrong', 'weak', 'no-account') is returned only when two
 *  RPC operators agree on it (see the module doc). */
export async function checkKeyOnChain(
	account: string,
	publicKey: string,
	deps: ChainAccessDeps = {},
	read: typeof chainRead = chainRead
): Promise<KeyOnChain> {
	const hidden = (deps.hiddenOnly ?? (() => isHiddenOnlyNode()))();
	const agreed =
		(await indexerAgreedAccount(account, deps, hidden)) ??
		(hidden ? null : await clearnetAgreedAccount(account, deps));
	if (agreed !== null) return judgeKeyOnChain(publicKey, agreed, account);
	let single: KeyOnChain;
	try {
		single = judgeKeyOnChain(
			publicKey,
			await read<unknown>('get_accounts', [[account]], deps),
			account
		);
	} catch (err) {
		return {
			kind: 'unknown',
			why: `the chain could not be read (${err instanceof Error ? err.message : String(err)})`
		};
	}
	if (!refuses(single)) return single;
	return {
		kind: 'unknown',
		why: 'only one Blurt node answered, and one node alone is not trusted to say a key is wrong (it may be behind the chain); no two RPC operators could be asked to agree',
		unconfirmed: single
	};
}

/** What one node said, in a few words (for an unconfirmed answer). */
function unconfirmedWords(v: KeyOnChain, account: string): string {
	switch (v.kind) {
		case 'no-account':
			return `that @${account} does not exist`;
		case 'weak':
			return `that this key cannot sign alone (weight ${v.weight}, below the threshold ${v.threshold})`;
		case 'wrong':
			return v.foundAs === 'posting'
				? `that this is @${account}'s POSTING key, not its active key`
				: v.foundAs === 'memo'
					? `that this is @${account}'s MEMO key, not its active key`
					: `that this is not one of @${account}'s active keys`;
		default:
			return 'something else';
	}
}

/**
 * The verdict in plain lines, for show-key / register / edit-active-key.
 * `context`: 'edit' inside edit-active-key, where the advice is to paste
 * another key — not to run the command the operator is already in.
 */
export function describeKeyOnChain(
	v: KeyOnChain,
	account: string,
	publicKey: string,
	context: 'check' | 'edit' = 'check'
): string[] {
	switch (v.kind) {
		case 'active':
			return [`✓ Matches: this is @${account}'s ACTIVE key on the Blurt chain.`];
		case 'owner':
			return [
				`⚠ This is @${account}'s OWNER key (the master key that can change every other key).`,
				...(context === 'edit'
					? [
							'  It can sign, but it should never be kept on a server, so it is not saved.',
							`  Paste the ACTIVE key of @${account} instead.`
						]
					: [
							'  It can sign, but it should never be kept on a server. Put the ACTIVE key here',
							'  instead: on this server run  sudo morphit-ops edit-active-key'
						])
			];
		case 'wrong':
			return [
				`✗ Does not match: ${publicKey} is not one of @${account}'s active keys.`,
				v.foundAs === 'posting'
					? `  It is @${account}'s POSTING key. The relay needs the ACTIVE key.`
					: v.foundAs === 'memo'
						? `  It is @${account}'s MEMO key. The relay needs the ACTIVE key.`
						: `  It is not any key of @${account} (another account's key, or a typo).`,
				...(v.activeKeys.length > 0
					? [`  The chain lists @${account}'s active public key as: ${v.activeKeys.join(', ')}`]
					: []),
				`  In your Blurt wallet, open @${account} → Keys / Permissions and copy the`,
				'  private ACTIVE key (51 characters, starts with 5).'
			];
		case 'weak':
			return [
				`✗ Listed, but cannot sign alone: ${publicKey} is on @${account}'s active authority`,
				`  with weight ${v.weight}, below the threshold ${v.threshold}. The relay signs with one key only.`,
				context === 'edit'
					? `  Paste an ACTIVE key of @${account} that can sign alone (weight ${v.threshold} or more),`
					: '  Put an ACTIVE key that can sign alone in place: on this server run  sudo morphit-ops edit-active-key',
				context === 'edit'
					? `  or, in your Blurt wallet, give this key weight ${v.threshold} on @${account}'s active authority.`
					: `  (or, in your Blurt wallet, give this key weight ${v.threshold} on @${account}'s active authority).`
			];
		case 'no-account':
			return [`✗ The account @${account} does not exist on the Blurt chain.`];
		case 'unknown':
			return v.unconfirmed !== undefined
				? [
						`? Could not check it against the chain: one Blurt node says ${unconfirmedWords(v.unconfirmed, account)},`,
						'  but no second RPC operator could confirm it, so it is not trusted (that node may be behind the chain).'
					]
				: [`? Could not check it against the chain: ${v.why}.`];
	}
}
