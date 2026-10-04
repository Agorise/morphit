/**
 * The Matrix alert bot on an installed tor-only node.
 *
 * The tor-only install wizard used to switch the bot on with a clearnet
 * homeserver (matrix.org by default) and no Tor route, so the box talked to
 * the clearnet. The bot now refuses that itself when its env says
 * MORPHIT_MATRIX_BOT_TOR_ONLY=1, and reaches a .onion homeserver through
 * MORPHIT_MATRIX_BOT_SOCKS_PROXY.
 *
 * On a tor-only node, once per upgrade:
 *   - homeserver on this machine or a .onion → set the tor-only flag and Tor's
 *     SOCKS route in matrix-bot.env (restart the bot if it runs);
 *   - clearnet homeserver, bot set up or running → say so; at a terminal the
 *     operator may type KEEP-CLEARNET to keep it as it is; otherwise
 *     (no answer, any other answer, not asked) set the flag and stop and
 *     disable the bot. The decision is written to a root-only file and shown;
 *     a kept bot is not asked about again. The upgrade itself never waits for
 *     the answer: it is asked by `sudo morphit-ops upgrade --questions`, which
 *     also brings back a bot stopped earlier when the operator keeps it.
 *     While kept, the tor-only egress rule is not loaded (lib/torOnlyEgressHeal.ts):
 *     it would cut the bot off.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import {
	KEY_SOCKS,
	KEY_TOR_ONLY,
	MATRIX_BOT_ENV_PATH,
	MATRIX_BOT_UNIT,
	matrixBotReadiness,
	parseMatrixBotEnvText,
	upsertEnvKey
} from './matrixBot.ts';
import { envFlagOn, homeserverRoute, torSocksUrl } from './matrixRoute.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';

export const MATRIX_TOR_ONLY_DECISION = '/etc/morphit/matrix-bot.tor-only-decision';
export const KEEP_CLEARNET_ANSWER = 'KEEP-CLEARNET';

export interface MatrixTorOnlyRuntime {
	hiddenOnly(): boolean;
	/** matrix-bot.env text, or null when there is none. */
	readEnv(): string | null;
	writeEnv(text: string): boolean;
	/** Tor's SocksPort, host:port. */
	socks(): string;
	unitActive(): boolean;
	unitEnabled(): boolean;
	restart(): boolean;
	/** `systemctl disable --now`. */
	disableNow(): boolean;
	/** `systemctl enable --now`. */
	enableNow?(): boolean;
	/** A typed answer at a terminal; null when there is no terminal. */
	ask(question: string): Promise<string | null>;
	readDecision(): string | null;
	writeDecision(text: string): void;
	now(): Date;
}

export async function healMatrixBotTorOnly(
	ctx: HealCtx,
	rt: MatrixTorOnlyRuntime
): Promise<HealResult> {
	if (!rt.hiddenOnly()) return { strategy: 'not-tor-only', verified: true, detail: '' };
	const env = rt.readEnv();
	if (env === null) return { strategy: 'no-bot', verified: true, detail: '' };
	const decision = rt.readDecision();
	if (decision !== null && decision.startsWith('kept-clearnet')) {
		return {
			strategy: 'kept-by-operator',
			verified: true,
			detail: `Matrix bot: kept on its clearnet homeserver by the operator's decision (${decision.trim()}); this node is not zero-clearnet while it runs, and the tor-only egress rule is not loaded.`
		};
	}
	const p = parseMatrixBotEnvText(env);
	const hs = p.homeserverRaw.trim();
	const route = homeserverRoute(hs);
	const socks = torSocksUrl(rt.socks());
	const withRoute = upsertEnvKey(upsertEnvKey(env, KEY_TOR_ONLY, '1'), KEY_SOCKS, socks);
	const routeSet = envFlagOn(p.torOnlyRaw) && p.socksRaw.trim() === socks;

	if (route === 'loopback' || route === 'onion' || hs === '') {
		if (routeSet) return { strategy: 'already', verified: true, detail: '' };
		if (!rt.writeEnv(withRoute)) {
			return {
				strategy: 'write-failed',
				verified: false,
				detail: `Matrix bot: could not write ${MATRIX_BOT_ENV_PATH}.`
			};
		}
		const running = rt.unitActive();
		if (running) rt.restart();
		const after = parseMatrixBotEnvText(rt.readEnv() ?? '');
		const ok =
			envFlagOn(after.torOnlyRaw) &&
			after.socksRaw.trim() === socks &&
			(!running || rt.unitActive());
		return {
			strategy: 'tor-route-set',
			verified: ok,
			detail: ok
				? `Matrix bot: set to reach ${hs === '' ? 'its homeserver' : hs} only through Tor (${socks}).`
				: `Matrix bot: the Tor route was written to ${MATRIX_BOT_ENV_PATH} but the bot did not come back; check: journalctl -u morphit-matrix-bot -n 30`
		};
	}

	// A clearnet (or unreadable) homeserver on a tor-only node.
	const setUp = matrixBotReadiness({ exists: true, mxidRaw: p.mxidRaw, tokenRaw: p.tokenRaw }).run;
	const active = rt.unitActive();
	if (!setUp && !active) {
		if (routeSet) return { strategy: 'already', verified: true, detail: '' };
		const ok = rt.writeEnv(withRoute);
		return {
			strategy: 'flag-set',
			verified: ok,
			detail: ok
				? `Matrix bot: not set up; it will only accept a homeserver on this machine or a .onion one (${hs || 'none'} would not be used).`
				: `Matrix bot: could not write ${MATRIX_BOT_ENV_PATH}.`
		};
	}
	ctx.warn(
		`This is a tor-only node, and its Matrix alert bot uses the clearnet homeserver ${hs || '(unreadable)'}: ` +
			'every alert and sync shows that homeserver this server’s address. The bot can use a homeserver on ' +
			'this machine or a .onion one instead (sudo morphit-ops matrix setup).'
	);
	const answer = await rt.ask(
		`Type ${KEEP_CLEARNET_ANSWER} to keep the bot on ${hs} (this node is then not zero-clearnet, and the tor-only egress rule — only Tor and i2pd may reach the internet — is not loaded, as it would cut the bot off); anything else stops it`
	);
	const when = rt.now().toISOString();
	if (answer !== null && answer.trim() === KEEP_CLEARNET_ANSWER) {
		// Kept after an earlier stop: lift the flag (and the Tor route) that
		// stop wrote, and start the bot again.
		let text = env;
		if (envFlagOn(p.torOnlyRaw)) {
			text = upsertEnvKey(text, KEY_TOR_ONLY, '');
			if (p.socksRaw.trim() === socks) text = upsertEnvKey(text, KEY_SOCKS, '');
		}
		const wrote = text === env || rt.writeEnv(text);
		if (!rt.unitActive()) rt.enableNow?.();
		rt.writeDecision(`kept-clearnet ${when} ${hs}\n`);
		const running = rt.unitActive();
		return {
			strategy: 'kept-by-operator',
			verified: wrote && running,
			detail:
				`Matrix bot: kept on ${hs} as the operator typed ${KEEP_CLEARNET_ANSWER} (recorded in ${MATRIX_TOR_ONLY_DECISION}); ` +
				(running
					? 'this node is not zero-clearnet while it runs, and the tor-only egress rule is not loaded.'
					: `it is not running — check: journalctl -u ${MATRIX_BOT_UNIT} -n 30`)
		};
	}
	const wrote = rt.writeEnv(withRoute);
	rt.disableNow();
	const stopped = !rt.unitActive() && !rt.unitEnabled();
	const why = answer === null ? 'not asked during the upgrade' : 'not kept';
	rt.writeDecision(`stopped ${when} ${hs} (${why})\n`);
	return {
		strategy: 'stopped',
		verified: wrote && stopped,
		detail:
			wrote && stopped
				? `Matrix bot: stopped and disabled — its homeserver ${hs} is on the clearnet (${why}; recorded in ${MATRIX_TOR_ONLY_DECISION}). Alerts are off until it uses a homeserver on this machine or a .onion one: sudo morphit-ops matrix setup` +
					(answer === null
						? `. To keep it on ${hs} anyway (this node is then not zero-clearnet): sudo morphit-ops upgrade --questions`
						: '')
				: `Matrix bot: could not stop it; on this server run: sudo systemctl disable --now ${MATRIX_BOT_UNIT}`
	};
}

/**
 * After the restarts: a bot this heal stopped stays stopped. The upgrader of
 * v1.20.2 and older enables and restarts the bot whenever its MXID and token
 * are set, after the heals ran; the new bot then exits at once (a clearnet
 * homeserver with the tor-only flag), but the unit is enabled again and the
 * stop this heal reported would not be true. Disable it again and say so.
 */
export async function recheckStoppedMatrixBot(
	_ctx: HealCtx,
	rt: MatrixTorOnlyRuntime
): Promise<HealResult> {
	const decision = rt.readDecision() ?? '';
	if (!decision.startsWith('stopped'))
		return { strategy: 'not-stopped', verified: true, detail: '' };
	const p = parseMatrixBotEnvText(rt.readEnv() ?? '');
	const hs = p.homeserverRaw.trim();
	const route = homeserverRoute(hs);
	// The operator has since moved the bot to a homeserver it may use.
	if (!envFlagOn(p.torOnlyRaw) || route === 'loopback' || route === 'onion')
		return { strategy: 'not-stopped', verified: true, detail: '' };
	if (!rt.unitActive() && !rt.unitEnabled())
		return { strategy: 'already', verified: true, detail: '' };
	rt.disableNow();
	const ok = !rt.unitActive() && !rt.unitEnabled();
	return {
		strategy: 'disabled-again',
		verified: ok,
		detail: ok
			? `Matrix bot: the upgrade enabled it again after this heal had stopped it (its homeserver ${hs} is on the clearnet); disabled again.`
			: `Matrix bot: the upgrade enabled it again after this heal had stopped it; on this server run: sudo systemctl disable --now ${MATRIX_BOT_UNIT}`
	};
}

function systemctl(args: readonly string[]): number {
	const r = spawnSync('systemctl', args as string[], { stdio: 'ignore', timeout: 60_000 });
	return typeof r.status === 'number' ? r.status : 1;
}

/** The real runtime: this box's files, systemd and terminal. */
export function realMatrixTorOnlyRuntime(
	ask: (q: string) => Promise<string | null>
): MatrixTorOnlyRuntime {
	return {
		hiddenOnly: () => isHiddenOnlyNode(),
		readEnv: () => {
			try {
				return existsSync(MATRIX_BOT_ENV_PATH) ? readFileSync(MATRIX_BOT_ENV_PATH, 'utf8') : null;
			} catch {
				return null;
			}
		},
		writeEnv: (text) => {
			try {
				writeFileSync(MATRIX_BOT_ENV_PATH, text);
				return true;
			} catch {
				return false;
			}
		},
		socks: () => torSocksFromEnv(),
		unitActive: () => systemctl(['is-active', '--quiet', MATRIX_BOT_UNIT]) === 0,
		unitEnabled: () => systemctl(['is-enabled', '--quiet', MATRIX_BOT_UNIT]) === 0,
		restart: () => systemctl(['restart', MATRIX_BOT_UNIT]) === 0,
		disableNow: () => systemctl(['disable', '--now', MATRIX_BOT_UNIT]) === 0,
		enableNow: () => systemctl(['enable', '--now', MATRIX_BOT_UNIT]) === 0,
		ask,
		readDecision: () => {
			try {
				return readFileSync(MATRIX_TOR_ONLY_DECISION, 'utf8');
			} catch {
				return null;
			}
		},
		writeDecision: (text) => {
			try {
				writeFileSync(MATRIX_TOR_ONLY_DECISION, text, { mode: 0o600 });
			} catch {
				/* the decision is also in this upgrade's output */
			}
		},
		now: () => new Date()
	};
}
