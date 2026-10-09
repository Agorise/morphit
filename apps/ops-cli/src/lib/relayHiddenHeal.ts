/**
 * Bring an existing hidden-only node's RELAY into line with its indexer, on
 * upgrade.
 *
 * WHY THIS EXISTS (v1.18.0, F32). The relay is the process that broadcasts —
 * signups, relayed transfers — and until this release it had no way to use
 * hidden RPC at all. The ansible relay template never set its endpoint list, so
 * every tor-only install left the relay on the built-in clearnet default: the
 * indexer read the chain over Tor and I2P while the relay beside it talked to
 * clearnet RPC operators from the box's own address.
 *
 * The release fixes the template, but `morphit-ops upgrade` does not re-render
 * templates. An EXISTING tor-only node would therefore upgrade into a relay
 * still on clearnet — and since the "Zero use of clearnet internet" claim now
 * asks the relay, that node's claim would switch off with nothing telling the
 * operator why. The fix has to reach the nodes that were actually exposed, which
 * are all existing ones.
 *
 * WHAT IT CHANGES, AND WHAT IT NEVER TOUCHES.
 *   - Only a node whose INDEXER uses no clearnet: that is the operator's
 *     declared intent for the box.
 *   - Only when the relay's clearnet list is set NOWHERE. That is the exact
 *     shape the old tor-only template produced. The relay's clearnet list is
 *     then emptied, and it takes the indexer's hidden endpoints and proxies
 *     where it has none of its own.
 *   - A relay list the operator set explicitly is never rewritten. It gets a
 *     warning naming what to change, because an explicit setting is a decision
 *     and not a leftover.
 *
 * It reads the files the way the services do — sourced by bash, in the units'
 * order, last assignment wins — rather than grepping one file. A value set in
 * `morphit.env` and overridden in `relay.env` is the override, and only a shell
 * reads it that way.
 */

import { appendFileSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
	hiddenNetworkOf,
	isHiddenOnlyEndpointSet,
	isHiddenServiceOrigin
} from '@morphit/hidden-transport';
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';

/** The files `morphit-indexer.service` sources, in its order. Pinned against
 *  the unit file by test: a list that drifts from the unit reads a config the
 *  service never sees. */
export const INDEXER_ENV_FILES: readonly string[] = [
	'/opt/morphit/morphit.env',
	'/opt/morphit/morphit.config.env',
	'/etc/morphit/indexer.env'
];

/** The files `morphit-relay.service` sources, in its order. Pinned likewise. */
export const RELAY_ENV_FILES: readonly string[] = [
	'/opt/morphit/morphit.env',
	'/opt/morphit/morphit.config.env',
	'/etc/morphit/relay.env',
	'/etc/morphit/relay-vapid.env'
];

/** Where a missing setting is written: the first of these that exists. Each is
 *  sourced by the relay unit, so a line appended to either takes effect. */
export const RELAY_ENV_TARGETS: readonly string[] = [
	'/etc/morphit/relay.env',
	'/opt/morphit/morphit.env'
];

const INDEXER_NAMES = [
	'MORPHIT_INDEXER_RPC_ENDPOINTS',
	'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS',
	'MORPHIT_INDEXER_TOR_SOCKS',
	'MORPHIT_INDEXER_I2P_HTTP_PROXY'
] as const;
const RELAY_NAMES = [
	'MORPHIT_RELAY_BLURT_RPC',
	'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS',
	'MORPHIT_RELAY_TOR_SOCKS',
	'MORPHIT_RELAY_I2P_HTTP_PROXY'
] as const;

/** name → value, or undefined when no file sets it. Unset and empty are
 *  different things here: empty is how an operator says "no clearnet". */
export type EffectiveEnv = ReadonlyMap<string, string | undefined>;

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The value each name would have inside a service that sources `files`, in
 * order. Runs with an EMPTY environment, so nothing from the caller's own
 * process can stand in for a setting the files do not make. Throws if bash
 * cannot be run; the caller treats that as "cannot tell" and changes nothing.
 */
export function readEffectiveEnv(files: readonly string[], names: readonly string[]): EffectiveEnv {
	for (const n of names) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) throw new Error(`not an env name: ${n}`);
	}
	const script = [
		'set -a',
		`for f in ${files.map(shq).join(' ')}; do [ -f "$f" ] && . "$f"; done`,
		...names.map(
			(n) => `if [ -n "\${${n}+x}" ]; then printf '1\\0%s\\0' "$${n}"; else printf '0\\0\\0'; fi`
		)
	].join('\n');
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
		timeout: 10_000,
		stdio: ['ignore', 'pipe', 'ignore']
	});
	if (r.status !== 0 || typeof r.stdout !== 'string') {
		throw new Error(`could not read the service environment (bash exit ${r.status})`);
	}
	const parts = r.stdout.split('\0');
	const out = new Map<string, string | undefined>();
	names.forEach((n, i) => {
		const isSet = parts[i * 2] === '1';
		out.set(n, isSet ? (parts[i * 2 + 1] ?? '') : undefined);
	});
	return out;
}

const split = (s: string): string[] =>
	s
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);

/** An endpoint the relay's hidden knob accepts at boot. Mirrored from the
 *  indexer only when EVERY entry passes, so the heal can never write a list the
 *  relay then refuses to start with. */
const relayAcceptsHidden = (ep: string): boolean => {
	const net = hiddenNetworkOf(ep);
	return isHiddenServiceOrigin(ep) && (net === 'tor' || net === 'i2p');
};

export type RelayHeal =
	/** The indexer uses clearnet, so clearnet on the relay is not a leak. */
	| { readonly kind: 'indexer-uses-clearnet' }
	/** Nothing to do: the relay is hidden-only by the relay's own rule. */
	| { readonly kind: 'relay-already-hidden-only' }
	/** The old template's shape: settings to append. */
	| { readonly kind: 'add'; readonly settings: ReadonlyArray<readonly [string, string]> }
	/** Set explicitly by the operator; warn, never rewrite. */
	| { readonly kind: 'relay-lists-clearnet'; readonly clearnet: readonly string[] }
	/** The relay would be left with no endpoint at all; warn, never write. */
	| { readonly kind: 'relay-has-no-endpoints' };

/** Decide what, if anything, to change. PURE. */
export function decideRelayHeal(indexer: EffectiveEnv, relay: EffectiveEnv): RelayHeal {
	// The indexer's own rule (main.ts): hidden-only ⇔ its clearnet list is empty.
	// Unset means the built-in default, which is clearnet.
	const idxClearRaw = indexer.get('MORPHIT_INDEXER_RPC_ENDPOINTS');
	const idxClear =
		idxClearRaw === undefined ? [...DEFAULT_BLURT_RPC_ENDPOINTS] : split(idxClearRaw);
	if (idxClear.length > 0) return { kind: 'indexer-uses-clearnet' };

	const relayClearRaw = relay.get('MORPHIT_RELAY_BLURT_RPC');
	const relayHiddenRaw = relay.get('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS');
	const relayHidden =
		relayHiddenRaw === undefined ? [...DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS] : split(relayHiddenRaw);

	if (relayClearRaw !== undefined) {
		const clear = split(relayClearRaw);
		if (isHiddenOnlyEndpointSet(clear, relayHidden)) return { kind: 'relay-already-hidden-only' };
		const nonHidden = clear.filter((ep) => !isHiddenServiceOrigin(ep));
		return nonHidden.length > 0
			? { kind: 'relay-lists-clearnet', clearnet: nonHidden }
			: { kind: 'relay-has-no-endpoints' };
	}

	const settings: Array<readonly [string, string]> = [['MORPHIT_RELAY_BLURT_RPC', '']];
	let finalHidden = relayHidden;
	if (relayHiddenRaw === undefined) {
		const idxHiddenRaw = indexer.get('MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS');
		const idxHidden = idxHiddenRaw === undefined ? [] : split(idxHiddenRaw);
		if (idxHidden.length > 0 && idxHidden.every(relayAcceptsHidden)) {
			settings.push(['MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS', idxHidden.join(',')]);
			finalHidden = idxHidden;
		}
	}
	if (!isHiddenOnlyEndpointSet([], finalHidden)) return { kind: 'relay-has-no-endpoints' };

	for (const [idxName, relayName] of [
		['MORPHIT_INDEXER_TOR_SOCKS', 'MORPHIT_RELAY_TOR_SOCKS'],
		['MORPHIT_INDEXER_I2P_HTTP_PROXY', 'MORPHIT_RELAY_I2P_HTTP_PROXY']
	] as const) {
		const v = indexer.get(idxName);
		if (relay.get(relayName) === undefined && v !== undefined) settings.push([relayName, v]);
	}
	return { kind: 'add', settings };
}

/** The block appended to the relay's env file. It OPENS with a newline, which
 *  both ends a last line that had none and otherwise leaves one blank line. */
export function renderRelayHealBlock(settings: ReadonlyArray<readonly [string, string]>): string {
	return (
		'\n# ─── Added by morphit-ops upgrade (v1.18.0) ───────────────────\n' +
		"# This node's indexer uses no clearnet, and its relay had no endpoint list,\n" +
		'# so it was reaching the chain over clearnet from this box. The relay now\n' +
		"# uses hidden endpoints only — the indexer's own list and proxies where it\n" +
		'# sets them. Remove this block to undo it.\n' +
		settings.map(([k, v]) => `${k}=${shq(v)}\n`).join('')
	);
}

export interface RelayHealOptions {
	readonly indexerFiles?: readonly string[];
	readonly relayFiles?: readonly string[];
	readonly targets?: readonly string[];
	readonly info?: (m: string) => void;
	readonly warn?: (m: string) => void;
}

/** Where the file is copied before the heal appends to it, so a relay that
 *  does not come back can be put back exactly as it was. */
export function relayHealBackupPath(target: string): string {
	return `${target}.before-v1.18.0-relay-heal`;
}

/** Read, decide, apply, report. Never throws: an upgrade must never fail over
 *  a self-heal. Returns the decision, and the file written if any. */
export function healRelayHiddenOnly(opts: RelayHealOptions = {}): {
	decision: RelayHeal | null;
	wrote: string | null;
} {
	const info = opts.info ?? (() => undefined);
	const warn = opts.warn ?? (() => undefined);
	try {
		const indexer = readEffectiveEnv(opts.indexerFiles ?? INDEXER_ENV_FILES, INDEXER_NAMES);
		const relay = readEffectiveEnv(opts.relayFiles ?? RELAY_ENV_FILES, RELAY_NAMES);
		const decision = decideRelayHeal(indexer, relay);
		switch (decision.kind) {
			case 'indexer-uses-clearnet':
			case 'relay-already-hidden-only':
				return { decision, wrote: null };
			case 'relay-lists-clearnet':
				warn(
					"This node's indexer uses no clearnet, but its relay is set to reach the chain over " +
						`clearnet (${decision.clearnet.join(', ')}). That shows this box's address to those ` +
						'RPC operators, and the instance will not claim zero clearnet while it does. To make ' +
						'the relay hidden-only, set MORPHIT_RELAY_BLURT_RPC= (empty) and restart ' +
						'morphit-relay. Left unchanged because it was set explicitly.'
				);
				return { decision, wrote: null };
			case 'relay-has-no-endpoints':
				warn(
					"This node's indexer uses no clearnet, but its relay has no hidden endpoints to use " +
						'instead, so it was left as it is. Set MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS to the ' +
						"same list as the indexer's MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS."
				);
				return { decision, wrote: null };
			case 'add': {
				const target = (opts.targets ?? RELAY_ENV_TARGETS).find((f) => existsSync(f));
				if (target === undefined) {
					warn('Could not find the relay configuration file; the relay was left as it is.');
					return { decision, wrote: null };
				}
				// Copied first: if the relay does not come back with this, the
				// verifying caller restores the file exactly (see
				// applyAndVerifyRelayHeal). Worded as what was DONE, not as a
				// result nothing has observed yet (v1.18.0 review, O6).
				copyFileSync(target, relayHealBackupPath(target));
				appendFileSync(target, renderRelayHealBlock(decision.settings), 'utf8');
				info(
					`Set the relay to reach the chain over hidden services only, like the indexer ` +
						`(in ${target}).`
				);
				return { decision, wrote: target };
			}
		}
	} catch (err) {
		warn(
			`Could not check the relay's clearnet setting: ${err instanceof Error ? err.message : String(err)}`
		);
		return { decision: null, wrote: null };
	}
}

/** What systemd says about morphit-relay.service right now. */
export interface RelayUnitState {
	/** ActiveState: active, activating, failed, inactive, … */
	readonly activeState: string;
	/** SubState: running, auto-restart, failed, … */
	readonly subState: string;
	/** NRestarts: how often systemd restarted it; null when unknown. */
	readonly restarts: number | null;
}

/** Is the relay unit failing, as opposed to merely slow to answer? A relay
 *  that exits (a config it rejects, a crash) is restarted by systemd
 *  (Restart=on-failure), which shows as a failed/auto-restart state or a
 *  restart count that went up since ours. PURE. */
export function relayUnitIsFailing(since: RelayUnitState | null, now: RelayUnitState): boolean {
	if (now.activeState === 'failed' || now.activeState === 'inactive') return true;
	if (now.subState === 'auto-restart' || now.subState === 'failed') return true;
	return (
		since !== null &&
		since.restarts !== null &&
		now.restarts !== null &&
		now.restarts > since.restarts
	);
}

/** What the verifying heal needs from the machine. Injected so every branch
 *  can be driven for real in a test, without systemd. */
export interface RelayHealRuntime {
	/** Is morphit-relay running? */
	isActive(): boolean;
	/** systemd's view of the unit. */
	unitState(): RelayUnitState;
	/** Restart it. True when systemctl accepted the restart. */
	restart(): boolean;
	/** The relay's own /v1/health: did it answer, and what does it say? */
	health(): Promise<{ reachable: boolean; hiddenOnly: boolean | null }>;
	sleep(ms: number): Promise<void>;
	/** Show motion during the wait; returns the stop function. */
	spinner?(label: string): () => void;
}

export type RelayHealOutcome =
	| 'nothing-to-do'
	| 'written-relay-not-running'
	| 'verified'
	| 'written-not-in-effect'
	/** Running and not failing, but not answering yet: kept (ops-4). */
	| 'written-still-starting'
	| 'reverted';

/**
 * Apply the heal, then PROVE it (v1.18.0 review, O6).
 *
 * The heal used to print "The relay now reaches the chain over hidden services
 * only" the moment it appended the lines — before any restart, from the old
 * binary's restart loop that skips an inactive relay and counts a restart as
 * success whether or not the relay then stays up. Nothing ever read the
 * relay's own answer. By the project's rule for anything that touches a live
 * box: try it, observe the running state, fall back, and say which happened.
 *
 *   - relay not running: the setting is in place for its next start — said so;
 *   - relay restarted and its /v1/health says hidden_only: VERIFIED, said so;
 *   - relay up but still not hidden-only: a later file overrides ours — kept,
 *     with the exact setting to look for;
 *   - relay FAILING (systemd reports it failed, or restarting it — a crash
 *     loop): the file is put back exactly as it was and the relay restarted on
 *     it — the upgrade must never leave a relay down over a self-heal;
 *   - relay running but not answering yet: KEPT, and said so calmly.
 *
 * "Not answering within 60 s" used to mean "revert".
 * But the relay does not listen until its first chain read succeeds, and over
 * Tor that read tries each hidden endpoint with a 60 s timeout — a healthy
 * tor-only relay can take minutes. Every upgrade put such a relay back on
 * clearnet RPC, re-opening the leak this heal closes. Only systemd's "this unit
 * is failing" reverts now; slow is not failing. (The deadline stays short: the
 * old binary that runs this self-heal phase kills it after 300 s.)
 */
export async function applyAndVerifyRelayHeal(
	opts: RelayHealOptions & { readonly runtime: RelayHealRuntime; readonly deadlineMs?: number }
): Promise<RelayHealOutcome> {
	const info = opts.info ?? (() => undefined);
	const warn = opts.warn ?? (() => undefined);
	const rt = opts.runtime;
	const applied = healRelayHiddenOnly(opts);
	if (applied.wrote === null) return 'nothing-to-do';
	const target = applied.wrote;

	if (!rt.isActive()) {
		info('The relay is not running now; it will use hidden services only when it next starts.');
		return 'written-relay-not-running';
	}

	const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
	const stop =
		rt.spinner?.('Restarting the relay and checking it came back hidden-only…') ??
		(() => undefined);
	let last: { reachable: boolean; hiddenOnly: boolean | null } = {
		reachable: false,
		hiddenOnly: null
	};
	let failing = false;
	try {
		const before = safeUnitState(rt);
		if (!rt.restart()) {
			failing = true;
		} else {
			while (Date.now() < deadline) {
				await rt.sleep(1_000);
				last = await rt.health().catch(() => ({ reachable: false, hiddenOnly: null }));
				if (last.reachable) break;
				const now = safeUnitState(rt);
				if (now !== null && relayUnitIsFailing(before, now)) {
					failing = true;
					break;
				}
			}
			if (!last.reachable && !failing) {
				const now = safeUnitState(rt);
				// Unknown state is not proof of failure; nor of health. Keep the
				// setting only when systemd positively reports the relay running.
				failing = now === null || relayUnitIsFailing(before, now) || now.activeState !== 'active';
			}
		}
	} finally {
		stop();
	}

	if (last.reachable && last.hiddenOnly === true) {
		info(
			'The relay now reaches the chain over hidden services only — checked: it restarted, and ' +
				'its own health report says so.'
		);
		return 'verified';
	}
	if (last.reachable) {
		warn(
			`The relay restarted and is working, but it still reports that it uses clearnet RPC, so ` +
				`another configuration file is overriding the setting added to ${target}. Look for ` +
				`MORPHIT_RELAY_BLURT_RPC in the relay's other env files; an empty value means ` +
				`"no clearnet". Nothing else was changed.`
		);
		return 'written-not-in-effect';
	}

	if (!failing) {
		info(
			`The relay restarted with hidden-only RPC and is still starting: its first chain read over ` +
				`Tor/I2P can take a few minutes. The setting in ${target} is kept. To watch it finish, run ` +
				`'journalctl -u morphit-relay -f'.`
		);
		return 'written-still-starting';
	}

	// Failing: put the file back exactly and restart on it.
	try {
		copyFileSync(relayHealBackupPath(target), target);
	} catch {
		/* the restart below still runs; the warning names the file */
	}
	const stopRevert =
		rt.spinner?.('Restarting the relay on its previous settings…') ?? (() => undefined);
	try {
		rt.restart();
	} finally {
		stopRevert();
	}
	warn(
		`The relay kept failing after being set to hidden-only RPC, so ${target} was put ` +
			`back as it was and the relay restarted on it: it is on its previous settings, ` +
			`reaching the chain as before. 'journalctl -u morphit-relay' shows why it did not ` +
			`start, and the next 'sudo morphit-ops upgrade' tries again.`
	);
	return 'reverted';
}

/** systemd's view, or null if it cannot be read. */
function safeUnitState(rt: RelayHealRuntime): RelayUnitState | null {
	try {
		return rt.unitState();
	} catch {
		return null;
	}
}
