/**
 * Post-upgrade self-heal: bring an installed node's XMR fee-source list up to
 * date (v1.20.2).
 *
 * WHY. `morphit-ops init` writes MORPHIT_INDEXER_XMR_EXPLORER_URLS into
 * /opt/morphit/morphit.env with the defaults OF THAT DAY, and an upgrade never
 * rewrote it. Every node set up before v1.20.0 therefore still lists
 * localmonero.co/blocks, monerohash.com/explorer and exploremonero.com — none
 * of which answers the API anymore — and lacks moneroblocks.info and the
 * public Monero nodes. Such a node verifies XMR fees on exactly two working
 * explorers: if either is down, every XMR fee waits. (An Ansible install
 * leaves the key unset and already gets the indexer's current default.)
 *
 * WHAT IT CHANGES, in every env file the indexer reads that sets the key:
 *   - removes the retired explorers (RETIRED_XMR_FEE_EXPLORERS);
 *   - adds each current default source the list does not have — ONCE: what it
 *     offered is remembered in /var/lib/morphit/fee-explorer-defaults.json, so
 *     an operator who later removes a default on purpose is not overruled at
 *     the next upgrade;
 *   - keeps every other entry (an operator's own explorers) and their order.
 * Nothing else in the file changes. The indexer restarts later in the same
 * upgrade, so it takes effect on this one.
 *
 * `root` relocates every path (tests); '' on a real box.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
	statSync,
	chmodSync
} from 'node:fs';
import { dirname } from 'node:path';

// The indexer's own lists — one source of truth (pure module, no deps).
import {
	DEFAULT_XMR_EXPLORERS as DEFAULT_XMR_FEE_EXPLORERS,
	RETIRED_XMR_EXPLORERS as RETIRED_XMR_FEE_EXPLORERS
} from '../../../indexer/src/config/xmrExplorers.ts';

export { DEFAULT_XMR_FEE_EXPLORERS, RETIRED_XMR_FEE_EXPLORERS };

export const XMR_EXPLORER_ENV_KEY = 'MORPHIT_INDEXER_XMR_EXPLORER_URLS';

/** The env files the indexer sources, in its order (last one wins). */
export function xmrExplorerEnvFiles(root = ''): string[] {
	return [
		`${root}/opt/morphit/morphit.env`,
		`${root}/opt/morphit/morphit.config.env`,
		`${root}/etc/morphit/indexer.env`
	];
}

export const offeredStatePath = (root = ''): string =>
	`${root}/var/lib/morphit/fee-explorer-defaults.json`;

const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

export interface ExplorerListPlan {
	/** The new list, or null when nothing changes. */
	readonly next: readonly string[] | null;
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

/** PURE. `offered`: defaults an earlier upgrade already added once. */
export function planXmrExplorerList(
	current: readonly string[],
	offered: ReadonlySet<string>,
	defaults: readonly string[] = DEFAULT_XMR_FEE_EXPLORERS,
	retired: readonly string[] = RETIRED_XMR_FEE_EXPLORERS
): ExplorerListPlan {
	const retiredSet = new Set(retired.map(norm));
	const removed = current.filter((u) => retiredSet.has(norm(u)));
	const kept = current.filter((u) => !retiredSet.has(norm(u)));
	const have = new Set(kept.map(norm));
	let added = defaults.filter((d) => !have.has(norm(d)) && !offered.has(norm(d)));
	// Never leave the node with nothing to ask: an empty list turns XMR fee
	// checks off altogether.
	if (kept.length + added.length === 0) added = [...defaults];
	if (removed.length === 0 && added.length === 0) return { next: null, added: [], removed: [] };
	return { next: [...kept, ...added], added, removed };
}

const LINE_RE = new RegExp(
	`^([ \\t]*(?:export[ \\t]+)?${XMR_EXPLORER_ENV_KEY}[ \\t]*=[ \\t]*)(.*?)[ \\t]*$`,
	'm'
);

/** The list a file sets, with its quote character; null when the file does
 *  not set the key. PURE. */
export function readXmrExplorerLine(
	text: string
): { readonly list: string[]; readonly quote: '' | "'" | '"' } | null {
	const m = LINE_RE.exec(text);
	if (m === null) return null;
	let v = m[2] ?? '';
	let quote: '' | "'" | '"' = '';
	if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0]) {
		quote = v[0] as "'" | '"';
		v = v.slice(1, -1);
	}
	const list = v
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return { list, quote };
}

/** The file's text with the key's value replaced (prefix and quoting kept). PURE. */
export function writeXmrExplorerLine(
	text: string,
	list: readonly string[],
	quote: '' | "'" | '"'
): string {
	return text.replace(
		LINE_RE,
		(_all, prefix: string) => `${prefix}${quote}${list.join(',')}${quote}`
	);
}

function readOffered(root: string): Set<string> {
	try {
		const j = JSON.parse(readFileSync(offeredStatePath(root), 'utf8')) as { offered?: unknown };
		return new Set(
			Array.isArray(j.offered)
				? j.offered.filter((x): x is string => typeof x === 'string').map(norm)
				: []
		);
	} catch {
		return new Set();
	}
}

function writeOffered(root: string, offered: ReadonlySet<string>): void {
	const p = offeredStatePath(root);
	try {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify({ offered: [...offered].sort() }, null, 1)}\n`, {
			mode: 0o640
		});
	} catch {
		/* best-effort: without it the next upgrade offers the defaults again */
	}
}

export type ExplorerListOutcome =
	| { readonly kind: 'unset' }
	| { readonly kind: 'already' }
	| {
			readonly kind: 'updated';
			readonly files: readonly string[];
			readonly added: readonly string[];
			readonly removed: readonly string[];
	  }
	| { readonly kind: 'failed'; readonly reason: string };

export function healXmrExplorerList(
	root = '',
	log: (m: string) => void = () => {},
	warn: (m: string) => void = () => {}
): ExplorerListOutcome {
	const offered = readOffered(root);
	const files = xmrExplorerEnvFiles(root).filter((f) => existsSync(f));
	const setting = files
		.map((f) => {
			try {
				const text = readFileSync(f, 'utf8');
				const line = readXmrExplorerLine(text);
				return line === null ? null : { f, text, line };
			} catch {
				return null;
			}
		})
		.filter((x): x is NonNullable<typeof x> => x !== null);
	if (setting.length === 0) {
		// Unset: the indexer's own default (the current list) applies.
		return { kind: 'unset' };
	}
	const changed: string[] = [];
	const addedAll = new Set<string>();
	const removedAll = new Set<string>();
	for (const { f, text, line } of setting) {
		const plan = planXmrExplorerList(line.list, offered);
		if (plan.next === null) continue;
		const updated = writeXmrExplorerLine(text, plan.next, line.quote);
		try {
			const mode = statSync(f).mode & 0o777;
			const tmp = `${f}.morphit-tmp`;
			writeFileSync(tmp, updated, { mode });
			chmodSync(tmp, mode);
			renameSync(tmp, f);
			// Verify by reading back what is on disk.
			const back = readXmrExplorerLine(readFileSync(f, 'utf8'));
			if (back === null || back.list.join(',') !== plan.next.join(',')) {
				warn(`Could not update the Monero fee sources in ${f} (read-back differs).`);
				return { kind: 'failed', reason: `read-back differs in ${f}` };
			}
		} catch (err) {
			warn(
				`Could not update the Monero fee sources in ${f}: ${err instanceof Error ? err.message : String(err)}`
			);
			return { kind: 'failed', reason: String(err) };
		}
		changed.push(f);
		for (const a of plan.added) addedAll.add(a);
		for (const r of plan.removed) removedAll.add(r);
	}
	// Whatever the outcome, every current default has now been offered once.
	const nextOffered = new Set(offered);
	for (const d of DEFAULT_XMR_FEE_EXPLORERS) nextOffered.add(norm(d));
	writeOffered(root, nextOffered);
	if (changed.length === 0) return { kind: 'already' };
	const parts: string[] = [];
	if (addedAll.size > 0) parts.push(`added ${[...addedAll].join(', ')}`);
	if (removedAll.size > 0)
		parts.push(`removed ${[...removedAll].join(', ')} (no longer answering)`);
	log(`Monero fee checks: ${parts.join('; ')}.`);
	return { kind: 'updated', files: changed, added: [...addedAll], removed: [...removedAll] };
}
