/**
 * hiddenUpgradeWait — what a zero-clearnet upgrade tells the operator when the
 * release is not reachable over Tor/I2P YET (v1.21.6).
 *
 * WHY. A Tor/I2P-only node never downloads a release from a code host: it reads
 * @morphit's signed release record through its own indexer (whose Blurt nodes
 * it reaches over Tor and I2P), then asks the other instances of the federation
 * for a copy whose SHA-256 matches that record. Right after a release, most
 * instances have not upgraded yet, so they have no copy to share; and a Tor
 * circuit or an I2P tunnel is sometimes slow to build. morphitlat, 2026-10-10:
 * two upgrades in a row stopped with a red ✗ and a nested error ("could not
 * reach this node's own indexer … no answer within 60s"); the third, a minute
 * later, went through. Nothing was wrong — it was simply early, and slow.
 *
 * So a failure here is a WAIT, not an error: the operator is told, in plain
 * words, what was searched, what each instance answered, that nothing changed,
 * and what they can do — try again now, let it keep trying, or come back once
 * more trusted instances have upgraded and can share the release.
 *
 * PURE (no I/O): the classification and the text are unit-tested; the
 * upgrade command prints the lines and asks the question.
 */

/** Which part of the zero-clearnet upgrade could not finish. */
export type HiddenWaitStage = 'record' | 'peers' | 'fetch';

/** What one peer address answered. */
export type PeerResult = 'missing' | 'no_answer' | 'unreachable' | 'mismatch' | 'error';

export interface PeerOutcome {
	/** The instance's name as the federation directory gives it (or its address). */
	readonly name: string;
	readonly network: 'Tor' | 'I2P';
	readonly result: PeerResult;
}

/**
 * The zero-clearnet upgrade could not get the release YET. `message` keeps the
 * technical reason (logs, --json); `stage`, `version` and `peers` drive the
 * operator's explanation.
 */
export class HiddenUpgradeWaitError extends Error {
	readonly stage: HiddenWaitStage;
	readonly version: string | null;
	readonly peers: readonly PeerOutcome[];
	/** For the record stage: the indexer answered, but without the record. */
	readonly recordNotListed: boolean;
	/** How long this attempt searched, in ms. */
	readonly searchedMs: number;
	constructor(
		message: string,
		info: {
			stage: HiddenWaitStage;
			version: string | null;
			peers?: readonly PeerOutcome[];
			recordNotListed?: boolean;
			searchedMs?: number;
		}
	) {
		super(message);
		this.name = 'HiddenUpgradeWaitError';
		this.stage = info.stage;
		this.version = info.version;
		this.peers = info.peers ?? [];
		this.recordNotListed = info.recordNotListed ?? false;
		this.searchedMs = info.searchedMs ?? 0;
	}
}

/** A peer fetch failure (hiddenUpgradeFetch's reason text) in plain categories. */
export function classifyPeerFailure(reason: string): PeerResult {
	const r = reason.toLowerCase();
	if (r.startsWith('sha_mismatch')) return 'mismatch';
	// The peer's IPFS gateway answered, but does not hold (or cannot find) the
	// release: 404/410 "not found", or kubo's 5xx when it could not fetch it.
	if (/http (404|410|5\d\d)\b/.test(r) || r.startsWith('no_release')) return 'missing';
	if (/timeout|timed out|aborted|und_err_(headers|body|connect)_timeout/.test(r))
		return 'no_answer';
	if (
		/econnrefused|econnreset|ehostunreach|enetunreach|enotfound|socket|socks|proxy|connect|terminated|other side closed|fetch failed/.test(
			r
		)
	) {
		return 'unreachable';
	}
	return 'error';
}

const RESULT_TEXT: Record<PeerResult, (v: string) => string> = {
	missing: (v) => `does not have v${v} yet`,
	no_answer: () => 'did not answer in time',
	unreachable: () => 'could not be reached',
	mismatch: () => 'offered a file that does not match the signed record (ignored)',
	error: () => 'could not hand over a copy'
};

/** "1 min 05 s" / "45 s". */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

/** One line per instance: its addresses' answers side by side. */
export function peerLines(peers: readonly PeerOutcome[], version: string): string[] {
	const byName = new Map<string, PeerOutcome[]>();
	for (const p of peers) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
	const out: string[] = [];
	for (const [name, list] of byName) {
		const results = new Set(list.map((p) => p.result));
		if (results.size === 1) {
			const nets = list.map((p) => p.network).join(' and ');
			out.push(`${name} (${nets}): ${RESULT_TEXT[list[0]!.result](version)}`);
		} else {
			out.push(
				`${name}: ${list.map((p) => `${p.network} — ${RESULT_TEXT[p.result](version)}`).join('; ')}`
			);
		}
	}
	return out;
}

/** The operator's choices after a wait. */
export type HiddenWaitChoice = 'retry' | 'keep-trying' | 'later';

/** How the "keep trying by itself" option paces itself. */
export const KEEP_TRYING_EVERY_MS = 5 * 60_000;
export const KEEP_TRYING_FOR_MS = 60 * 60_000;

/** Read the operator's answer ("1", "2", "3", or Enter for the default 1). */
export function parseWaitChoice(answer: string): HiddenWaitChoice | null {
	const a = answer.trim().toLowerCase();
	if (a === '' || a === '1' || a === 'r' || a === 'retry') return 'retry';
	if (a === '2' || a === 'k' || a === 'keep') return 'keep-trying';
	if (a === '3' || a === 'l' || a === 'later' || a === 'q' || a === 'n' || a === 'no')
		return 'later';
	return null;
}

/**
 * The explanation shown when the zero-clearnet upgrade has to wait. `current`
 * is the version this server runs (null when unknown); `interactive` adds the
 * three choices, otherwise it ends with how to try again.
 */
export function renderHiddenWait(
	e: HiddenUpgradeWaitError,
	opts: { readonly current: string | null; readonly interactive: boolean }
): string[] {
	const v = e.version ?? 'the new release';
	const vTag = e.version !== null ? `v${e.version}` : 'the new release';
	const stays =
		opts.current !== null
			? `Nothing was changed: this server still runs ${opts.current} and keeps working.`
			: 'Nothing was changed: this server keeps running the version it has.';
	const rule = '━'.repeat(58);
	const lines: string[] = [''];
	if (e.stage === 'record') {
		lines.push(
			rule,
			`  ⏳ Not yet: @morphit's signed record for ${vTag} could not be read`,
			rule,
			''
		);
		lines.push(
			'  This server uses no clearnet at all. It reads the Blurt chain through its',
			'  own indexer, which asks Blurt nodes over Tor and I2P — so a single answer',
			'  can take a minute or more, and sometimes none comes in time.',
			''
		);
		lines.push(
			e.recordNotListed
				? `  Its indexer answered, but the history it got does not list the record for ${vTag} yet.`
				: `  For ${formatDuration(e.searchedMs)}, the indexer's Blurt nodes did not answer in time.`,
			'  This usually clears up on a later try: the indexer moves to another node,',
			'  and Tor circuits and I2P tunnels are rebuilt.'
		);
	} else if (e.stage === 'peers') {
		lines.push(rule, `  ⏳ Not yet: no instance to fetch ${vTag} from over Tor/I2P`, rule, '');
		lines.push(
			'  This server uses no clearnet at all, so it gets each release from the other',
			'  Morphit instances in the federation, over Tor and I2P. Its federation',
			'  directory does not list any instance with a Tor or I2P address yet.',
			'  The directory fills in as this server finds and checks other instances.'
		);
	} else {
		lines.push(rule, `  ⏳ Not yet: no instance could share ${vTag} over Tor/I2P`, rule, '');
		lines.push(
			'  This server uses no clearnet at all, so it never downloads a release from a',
			`  code host. For ${formatDuration(e.searchedMs)} it searched the other Morphit instances in the`,
			'  federation, over both Tor and I2P, for a copy that matches the SHA-256 in',
			"  @morphit's signed record."
		);
		const pl = peerLines(e.peers, v);
		if (pl.length > 0) {
			lines.push('', '  What each instance answered:');
			for (const l of pl) lines.push(`    • ${l}`);
		}
		lines.push(
			'',
			'  This is normal right after a release: an instance can share a release only',
			'  once it has upgraded itself, and Tor circuits and I2P tunnels are sometimes',
			'  slow to build.'
		);
	}
	lines.push('', `  ${stays}`, '');
	if (opts.interactive) {
		lines.push(
			'  What would you like to do?',
			'    1. Try again now',
			`    2. Keep trying by itself — again ${KEEP_TRYING_EVERY_MS / 60_000} minutes after each try, for up to ${KEEP_TRYING_FOR_MS / 60_000} minutes`,
			'       (it still asks you before installing anything)',
			'    3. Stop for now, and try again later — once more trusted instances have',
			'       upgraded, they can share the release with this server',
			''
		);
	} else {
		lines.push(
			'  Try again later, once more trusted instances have upgraded and can share',
			'  the release with this server:  sudo morphit-ops upgrade',
			''
		);
	}
	return lines;
}
