/**
 * The operator's BLURT fees account, as the running indexer sees it and as the
 * chain records it (v1.20.0, G1: cross-instance BLURT fees).
 *
 * Other Morphit instances accept the 90 % leg of a BLURT fee paid through this
 * instance only when this operator's on-chain registration
 * (morphit_operator_register_v1) carries `fee_recipient` equal to the account
 * the frontend pays — the indexer's RESOLVED MORPHIT_INDEXER_FEE_RECIPIENT.
 * `register` publishes it, the upgrade heal (lib/feeRecipientHeal.ts)
 * re-publishes it when the chain disagrees, and `status` reports it.
 *
 * Everything here reads; nothing signs or writes.
 */
import { CANONICAL_TREASURY } from '../../../indexer/src/config/canonicalTreasury.ts';
import { INDEXER_ENV_FILES, readEffectiveEnv } from './relayHiddenHeal.ts';
import { chainRead, type ChainAccessDeps } from './chainAccess.ts';
import { isHiddenOnlyNode, localIndexerJson } from './hiddenOnly.ts';

/** The project-canonical Blurt account-name regex (as the indexer's). */
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

export const REGISTER_OP_ID = 'morphit_operator_register_v1';

/** The indexer's resolveFeeRecipient, byte for byte: a valid account name as
 *  written, else the canonical treasury. (Parity is pinned by test.) */
export function resolveFeeRecipientValue(raw: string | undefined): {
	recipient: string;
	fellBack: boolean;
} {
	const trimmed = (raw ?? '').trim();
	if (ACCOUNT_RE.test(trimmed)) return { recipient: trimmed, fellBack: false };
	return { recipient: CANONICAL_TREASURY.blurt, fellBack: true };
}

/** The canonical treasury account (a single 100 % leg verifies everywhere). */
export const CANONICAL_BLURT_TREASURY: string = CANONICAL_TREASURY.blurt;

/**
 * The fees account the INDEXER SERVICE resolves: MORPHIT_INDEXER_FEE_RECIPIENT
 * read from the files morphit-indexer.service sources, in its order (so it is
 * exactly the account the frontend pays), falling back to this process's
 * environment when none of those files set it (a dev checkout). Honours
 * MORPHIT_ENV_ROOT like the other heals (tests).
 */
export function configuredFeeRecipient(): {
	recipient: string;
	fellBack: boolean;
	raw: string | undefined;
} {
	const root = process.env.MORPHIT_ENV_ROOT ?? '';
	let raw: string | undefined;
	try {
		raw = readEffectiveEnv(
			INDEXER_ENV_FILES.map((f) => `${root}${f}`),
			['MORPHIT_INDEXER_FEE_RECIPIENT']
		).get('MORPHIT_INDEXER_FEE_RECIPIENT');
	} catch {
		raw = undefined;
	}
	if (raw === undefined) raw = process.env.MORPHIT_INDEXER_FEE_RECIPIENT;
	return { ...resolveFeeRecipientValue(raw), raw };
}

/** What this node's own indexer says about `account`'s registration. */
export type LocalRegistration =
	| {
			readonly state: 'registered';
			readonly tag: string;
			/** The APPLIED display name / contact, as this indexer holds them. */
			readonly displayName: string | null;
			readonly contactUrl: string | null;
	  }
	| { readonly state: 'not_registered' }
	| { readonly state: 'unknown'; readonly why: string };

export async function localRegistration(
	account: string,
	opts: { readonly bases?: readonly string[]; readonly timeoutMs?: number } = {}
): Promise<LocalRegistration> {
	try {
		const body = await localIndexerJson<{
			operators?: ReadonlyArray<{
				account?: unknown;
				tag?: unknown;
				display_name?: unknown;
				contact_url?: unknown;
			}>;
		}>('/v1/operators', {}, { timeoutMs: opts.timeoutMs ?? 8_000, bases: opts.bases });
		if (!Array.isArray(body?.operators))
			return { state: 'unknown', why: 'unexpected /v1/operators answer' };
		const row = body.operators.find((o) => o.account === account);
		return typeof row?.tag === 'string' && row.tag.length > 0
			? {
					state: 'registered',
					tag: row.tag,
					displayName: typeof row.display_name === 'string' ? row.display_name : null,
					contactUrl: typeof row.contact_url === 'string' ? row.contact_url : null
				}
			: { state: 'not_registered' };
	} catch (err) {
		return { state: 'unknown', why: err instanceof Error ? err.message : String(err) };
	}
}

/** The registration payload the chain ACCEPTED for an account (V3-4). */
export type AcceptedRegistration =
	| { readonly state: 'ok'; readonly payload: Record<string, unknown>; readonly source: string }
	| { readonly state: 'unavailable'; readonly why: string };

/**
 * (V3-4) The newest registration payload this node's indexer APPLIED for
 * `account` — what an unattended re-publish must reproduce, adding only the
 * fees account:
 *   1. a v1.20+ indexer serves it from its event log
 *      (/v1/operator-registration/:account);
 *   2. an older indexer (still running during the upgrade that ships v1.20)
 *      cannot, so the newest register op in the account's chain history is
 *      used — ONLY when its tag, display name and contact match what the
 *      indexer applied (`applied`, from /v1/operators); otherwise it may be an
 *      op the indexer refused, and the caller must not broadcast.
 */
export async function acceptedRegistration(
	account: string,
	applied: {
		readonly tag: string;
		readonly displayName: string | null;
		readonly contactUrl: string | null;
	},
	deps: {
		readonly localJson?: typeof localIndexerJson;
		readonly chainRegistration?: (account: string) => Promise<ChainRegistration>;
	} = {}
): Promise<AcceptedRegistration> {
	const json = deps.localJson ?? localIndexerJson;
	try {
		const r = await json<{ payload?: unknown }>(
			`/v1/operator-registration/${encodeURIComponent(account)}`,
			{},
			{ timeoutMs: 8_000 }
		);
		const p = r?.payload;
		if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
			return { state: 'ok', payload: p as Record<string, unknown>, source: "this node's indexer" };
		}
		return { state: 'unavailable', why: "this node's indexer answered without a payload" };
	} catch (err) {
		// A v1.20+ indexer that applied none says so in JSON; anything else
		// (an older indexer without the route) falls through to the chain.
		if (err instanceof Error && /no applied registration/.test(err.message)) {
			return { state: 'unavailable', why: 'this node has no applied registration' };
		}
	}
	let chain: ChainRegistration;
	try {
		chain = await (deps.chainRegistration ?? ((a: string) => latestChainRegistration(a)))(account);
	} catch (err) {
		return { state: 'unavailable', why: err instanceof Error ? err.message : String(err) };
	}
	if (!chain.found || chain.payload === null) {
		return { state: 'unavailable', why: 'no register op found in the chain history' };
	}
	const p = chain.payload;
	const dn = typeof p.display_name === 'string' ? p.display_name.normalize('NFC').trim() : null;
	const cu =
		typeof p.contact_url === 'string' && p.contact_url.trim() !== '' ? p.contact_url.trim() : null;
	if (p.tag !== applied.tag || dn !== applied.displayName || cu !== applied.contactUrl) {
		return {
			state: 'unavailable',
			why: 'the newest register op on chain is not the one this node applied'
		};
	}
	return { state: 'ok', payload: p, source: "your account's chain history" };
}

/** This node's /v1/instance view of its fees account. `registered` is null
 *  when the indexer does not report it (a pre-v1.20 indexer) or could not tell. */
export interface LocalFeeView {
	/** Where this site tells its users to pay BLURT fees (`fee_recipient`).
	 *  From the consensus activation time, while the configured account is
	 *  verified unregistered, that is the canonical treasury. */
	readonly feeRecipient: string | null;
	/** The CONFIGURED fees account, the one `registered` is about
	 *  (`configured_fee_recipient`, served to local callers by v1.21.18+);
	 *  null when the indexer does not report it. */
	readonly configuredFeeRecipient: string | null;
	readonly registered: boolean | null;
	/** Did the indexer's answer carry the field at all (v1.20+)? */
	readonly reportsRegistration: boolean;
}

export async function localFeeView(
	opts: { readonly bases?: readonly string[]; readonly timeoutMs?: number } = {}
): Promise<LocalFeeView | null> {
	try {
		const b = await localIndexerJson<Record<string, unknown> | null>(
			'/v1/instance',
			// A local caller: the indexer adds `configured_fee_recipient`.
			{ headers: { 'x-morphit-local-health': '1' } },
			{ timeoutMs: opts.timeoutMs ?? 8_000, bases: opts.bases }
		);
		if (b === null || typeof b !== 'object') return null;
		const reg = b.fee_recipient_registered;
		return {
			feeRecipient: typeof b.fee_recipient === 'string' ? b.fee_recipient : null,
			configuredFeeRecipient:
				typeof b.configured_fee_recipient === 'string' ? b.configured_fee_recipient : null,
			registered: typeof reg === 'boolean' ? reg : null,
			reportsRegistration: 'fee_recipient_registered' in b
		};
	} catch {
		return null;
	}
}

/** The account `view.registered` is about: the indexer's
 *  `configured_fee_recipient` when it reports one; else, for an indexer that
 *  does not, what the indexer service's env files configure
 *  (configuredFeeRecipient) when it differs from the advertised account only
 *  because that is the treasury; else the advertised account (an older
 *  indexer advertises the configured one). */
export function configuredAccountOf(
	view: LocalFeeView,
	fromEnv: () => string = () => configuredFeeRecipient().recipient
): string | null {
	// typeof: a view built by an older caller may lack the field altogether.
	if (typeof view.configuredFeeRecipient === 'string') return view.configuredFeeRecipient;
	if (view.feeRecipient === CANONICAL_BLURT_TREASURY && view.registered === false) return fromEnv();
	return view.feeRecipient;
}

/** The newest register op `account` signed, read from the chain's account
 *  history (through this node's indexer first — the full RPC pool — then, on a
 *  node that is not hidden-only, the clearnet pool). */
export type ChainRegistration =
	| {
			readonly found: true;
			readonly trxId: string;
			readonly block: number;
			/** The op's fee_recipient, or null when it carries none. */
			readonly feeRecipient: string | null;
			/** The whole parsed payload (null if its JSON did not parse). */
			readonly payload: Record<string, unknown> | null;
	  }
	| { readonly found: false };

type HistoryEntry = [number, { trx_id?: unknown; block?: unknown; op?: unknown }];

/** How far back to look: pages × page size of account-history entries. */
export const HISTORY_PAGES = 10;
export const HISTORY_PAGE_SIZE = 1000;

/**
 * v1.21.18: the same read on a HIDDEN-ONLY node, where this node's indexer
 * relays it over Tor/I2P. One 1000-entry page never arrived there (morphitlat:
 * 10 entries of history took 33.7 s; 100 none within 240 s), so the 20 s the
 * read had always ran out and every check fell back to "could not read". Now:
 * pages of 10 entries, 90 s each, two pages. That finds the registration when
 * it is among the newest entries — always so for the read-back right after
 * `register` or the upgrade heal broadcast it — within the 300 s the upgrade
 * gives its heal. A registration that is OLDER than that is not "not found":
 * the read throws, and every caller then says it could not check, as it did
 * before, instead of treating an incomplete search as no registration.
 */
export const HISTORY_PAGES_HIDDEN = 2;
export const HISTORY_PAGE_SIZE_HIDDEN = 10;
export const HISTORY_READ_TIMEOUT_HIDDEN_MS = 90_000;

export async function latestChainRegistration(
	account: string,
	deps: ChainAccessDeps = {},
	read: typeof chainRead = chainRead
): Promise<ChainRegistration> {
	const hidden = (deps.hiddenOnly ?? (() => isHiddenOnlyNode()))();
	const pages = hidden ? HISTORY_PAGES_HIDDEN : HISTORY_PAGES;
	const pageSize = hidden ? HISTORY_PAGE_SIZE_HIDDEN : HISTORY_PAGE_SIZE;
	const readDeps: ChainAccessDeps = hidden
		? {
				...deps,
				hiddenOnly: () => true,
				hiddenReadTimeoutMs: deps.hiddenReadTimeoutMs ?? HISTORY_READ_TIMEOUT_HIDDEN_MS
			}
		: deps;
	let start = -1;
	let atStart = false;
	for (let page = 0; page < pages; page++) {
		const limit = start === -1 ? pageSize : Math.min(pageSize, start);
		if (limit <= 0) {
			atStart = true;
			break;
		}
		const entries = await read<HistoryEntry[] | null>(
			'get_account_history',
			[account, start, limit],
			readDeps
		);
		if (!Array.isArray(entries) || entries.length === 0) {
			atStart = true;
			break;
		}
		// Ascending by sequence: newest last.
		for (let i = entries.length - 1; i >= 0; i--) {
			const hit = registerOpIn(entries[i], account);
			if (hit !== null) return hit;
		}
		const first = entries[0]?.[0];
		if (typeof first !== 'number' || first <= 0) {
			atStart = true;
			break;
		}
		start = first - 1;
	}
	if (hidden && !atStart) {
		throw new Error(
			`no register op among the newest ${pages * (pageSize + 1)} entries of @${account}'s chain history ` +
				'(over Tor/I2P only those are read), so this could not be checked'
		);
	}
	return { found: false };
}

/** A register op `account` signed, from one history entry, else null. */
export function registerOpIn(
	entry: HistoryEntry | undefined,
	account: string
): ChainRegistration | null {
	const e = entry?.[1];
	const op = e?.op;
	if (!Array.isArray(op) || op[0] !== 'custom_json') return null;
	const body = op[1] as {
		id?: unknown;
		json?: unknown;
		required_auths?: unknown;
		required_posting_auths?: unknown;
	};
	if (body?.id !== REGISTER_OP_ID || typeof body.json !== 'string') return null;
	const auths = [
		...(Array.isArray(body.required_auths) ? body.required_auths : []),
		...(Array.isArray(body.required_posting_auths) ? body.required_posting_auths : [])
	];
	if (auths[0] !== account) return null;
	let feeRecipient: string | null = null;
	let payload: Record<string, unknown> | null = null;
	try {
		const p = JSON.parse(body.json) as unknown;
		if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
			payload = p as Record<string, unknown>;
			const f = payload.fee_recipient;
			feeRecipient = typeof f === 'string' && f !== '' ? f : null;
		}
	} catch {
		payload = null;
	}
	return {
		found: true,
		trxId: typeof e?.trx_id === 'string' ? e.trx_id : '',
		block: typeof e?.block === 'number' ? e.block : 0,
		feeRecipient,
		payload
	};
}

/** Registration fields a re-publish would change besides fee_recipient:
 *  `[label, on-chain value, new value]` for each differing field, comparing
 *  the newest on-chain register payload with the one about to be sent. */
export function otherRegistrationChanges(
	prev: Record<string, unknown> | null,
	next: Record<string, unknown>
): Array<[string, string, string]> {
	const show = (v: unknown): string =>
		v === undefined || v === null || v === ''
			? '(none)'
			: typeof v === 'string'
				? v
				: JSON.stringify(sorted(v));
	const out: Array<[string, string, string]> = [];
	const fields: Array<[string, string]> = [
		['display_name', 'display name'],
		['origin', 'origin'],
		['contact_url', 'contact'],
		['alt_addresses', 'Tor/I2P addresses']
	];
	for (const [key, label] of fields) {
		const a = show(prev?.[key]);
		const b = show(next[key]);
		if (a !== b) out.push([label, a, b]);
	}
	return out;
}

function sorted(v: unknown): unknown {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
	return Object.fromEntries(
		Object.keys(v as Record<string, unknown>)
			.sort()
			.filter(
				(k) =>
					(v as Record<string, unknown>)[k] !== null && (v as Record<string, unknown>)[k] !== ''
			)
			.map((k) => [k, (v as Record<string, unknown>)[k]])
	);
}
