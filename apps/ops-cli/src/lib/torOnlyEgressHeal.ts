/**
 * Installed-box heal: a tor-only node enforces "only Tor and i2pd reach the
 * internet" in the kernel, and the OS jobs that would try are off.
 *
 * Existing tor-only nodes get exactly what a fresh tor-only install gets from
 * the Ansible tor role: both drive ops/tor-only/morphit-tor-egress.sh (its
 * header explains the rule) and ops/systemd/morphit-tor-egress.service.
 * A node that is not tor-only is never touched.
 *
 * ORDER, each step VERIFIED before the next:
 *  0. Tor must reach the Tor network NOW (an HTTP answer from one of the
 *     public hidden Blurt RPC nodes, through the SocksPort); otherwise
 *     nothing changes — a rule could not then be checked to leave Tor working.
 *  1. snapd, fwupd's refresh, pollinate and Ubuntu Pro's timer masked
 *     (`systemctl is-enabled` = masked).
 *  2. i2pd reseeds through Tor (its config read back; i2pd restarted and
 *     seen active).
 *  3. the Docker daemon pulls through Tor (drop-in read back; a running
 *     daemon restarts only when it changed — the web container restarts
 *     with it).
 *  4. the egress rule: written, loaded, its unit enabled; then OBSERVED — the
 *     loaded table matches, a connection attempt by user `nobody` is refused
 *     by it (its counter rises), and Tor still reaches the Tor network.
 * FALLBACK: if Tor stops working after step 4, the rule is lifted (table
 * deleted, unit disabled, file put back) and that is said calmly; the next
 * upgrade tries again. Steps 1–3 only remove clearnet traffic and stay.
 *
 * A Matrix bot the operator KEPT on its clearnet homeserver (KEEP-CLEARNET,
 * lib/matrixTorOnlyHeal.ts) cannot work under the rule: its user is not
 * allowed out, and neither are the DNS lookups it needs. While that decision
 * stands, step 4 is not applied and the heal says the node is not
 * zero-clearnet; where the rule is already loaded it stays, and the heal says
 * the bot is cut off and how to settle it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';
import { MATRIX_TOR_ONLY_DECISION } from './matrixTorOnlyHeal.ts';

export const EGRESS_SCRIPT = 'morphit-tor-egress.sh';
export const EGRESS_UNIT = 'morphit-tor-egress.service';

export interface EgressRuntime {
	torOnly(): boolean;
	/** Does Tor reach the Tor network now (an HTTP answer from a hidden node)? */
	torWorks(): Promise<boolean>;
	/** Install the release's script and unit (only when different); true when in place. */
	install(): boolean;
	/** morphit-tor-egress.sh <mode> [backup dir] → exit status. */
	script(mode: string): number;
	systemctl(args: readonly string[]): { ok: boolean; out: string };
	sleep(ms: number): Promise<void>;
	/** The Matrix bot's tor-only decision file, or null when there is none. */
	matrixDecision?(): string | null;
}

export async function healTorOnlyEgress(
	ctx: HealCtx,
	opts: { runtime?: EgressRuntime } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	if (!rt.torOnly())
		return {
			strategy: 'skipped',
			verified: true,
			detail: 'Tor-only egress rule: this node is not tor-only; nothing changed.'
		};
	let stop = ctx.spinner(
		'Checking that Tor reaches the Tor network before tightening this server…'
	);
	let before: boolean;
	try {
		before = await rt.torWorks();
	} finally {
		stop();
	}
	if (!before)
		return {
			strategy: 'deferred',
			verified: false,
			detail:
				'Tor-only egress rule: Tor does not reach the Tor network right now, so nothing was changed (a rule could not be checked to leave Tor working). The next upgrade tries again.'
		};
	if (!rt.install())
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Tor-only egress rule: could not install ${EGRESS_SCRIPT} / ${EGRESS_UNIT} from this release; nothing was changed.`
		};
	const notes: string[] = [];
	const problems: string[] = [];

	// 1. OS jobs that would only go to clearnet.
	if (rt.script('units-check') !== 0) {
		rt.script('units-apply');
		if (rt.script('units-check') === 0)
			notes.push('snapd, fwupd refresh, pollinate and Ubuntu Pro timer masked');
		else
			problems.push(
				'some clearnet OS jobs could not be masked (see `sudo sh /usr/local/lib/morphit/morphit-tor-egress.sh units-check`)'
			);
	}
	// 2. i2pd reseed through Tor.
	if (rt.script('i2pd-check') !== 0) {
		rt.script('i2pd-apply');
		stop = ctx.spinner('Restarting i2pd so it reseeds through Tor…');
		try {
			rt.systemctl(['restart', 'i2pd']);
			await rt.sleep(3_000);
		} finally {
			stop();
		}
		const active = rt.systemctl(['is-active', 'i2pd']).ok;
		if (rt.script('i2pd-check') === 0 && active)
			notes.push('i2pd reseeds through Tor (config read back, i2pd running)');
		else
			problems.push(
				`i2pd ${active ? 'config could not be updated' : 'did not come back after its restart'}; on this server run: sudo systemctl status i2pd`
			);
	}
	// 3. Docker pulls through Tor.
	if (rt.script('docker-check') !== 0) {
		rt.script('docker-apply');
		stop = ctx.spinner(
			'Restarting Docker so it pulls images through Tor (the web container restarts with it)…'
		);
		try {
			rt.systemctl(['daemon-reload']);
			rt.systemctl(['try-restart', 'docker']);
			await rt.sleep(5_000);
		} finally {
			stop();
		}
		const dockerHere = rt.systemctl(['cat', 'docker.service']).ok;
		if (
			rt.script('docker-check') === 0 &&
			(!dockerHere || rt.systemctl(['is-active', 'docker']).ok)
		)
			notes.push('Docker pulls images through Tor');
		else
			problems.push(
				'Docker could not be set to pull through Tor; on this server run: sudo systemctl status docker'
			);
	}
	// 4. The rule — not while the operator keeps the Matrix bot on clearnet.
	if ((rt.matrixDecision?.() ?? '').startsWith('kept-clearnet')) {
		const loaded = rt.script('egress-check') === 0;
		const rest = [...notes, ...problems];
		const settle = `move the bot to a homeserver on this machine or a .onion one (sudo morphit-ops matrix setup), then: sudo rm ${MATRIX_TOR_ONLY_DECISION}`;
		return {
			strategy: loaded ? 'kept-bot-blocked' : 'kept-clearnet-bot',
			verified: false,
			detail: loaded
				? `Tor-only egress rule: it is loaded and it refuses the Matrix bot the operator kept on its clearnet homeserver (KEEP-CLEARNET, ${MATRIX_TOR_ONLY_DECISION}): the bot cannot reach it, so its alerts do not arrive. Either ${settle}; or lift the rule: sudo sh /usr/local/lib/morphit/${EGRESS_SCRIPT} egress-revert /var/lib/morphit-tor-only/egress-backup && sudo systemctl disable ${EGRESS_UNIT}${rest.length ? `; ${rest.join('; ')}` : ''}.`
				: `Tor-only egress rule: not loaded — the operator kept the Matrix bot on its clearnet homeserver (KEEP-CLEARNET, ${MATRIX_TOR_ONLY_DECISION}), and the rule (only Tor and i2pd may reach the internet, no DNS) would cut it off. This node is not zero-clearnet while that decision stands. To have the rule: ${settle}, then: sudo morphit-ops upgrade --heals${rest.length ? `; ${rest.join('; ')}` : ''}.`
		};
	}
	let strategy = 'already';
	if (rt.script('egress-check') !== 0) {
		strategy = 'applied';
		stop = ctx.spinner('Loading the rule that lets only Tor and i2pd reach the internet…');
		let loaded = false;
		try {
			loaded = rt.script('egress-apply') === 0;
			if (loaded) rt.systemctl(['enable', EGRESS_UNIT]);
		} finally {
			stop();
		}
		if (!loaded) {
			rt.script('egress-revert');
			return {
				strategy: 'left-alone',
				verified: false,
				detail: `Tor-only egress rule: nftables refused the rule, so it was not loaded and nothing else depends on it${notes.length ? `; ${notes.join('; ')}` : ''}.`
			};
		}
	}
	stop = ctx.spinner(
		'Checking the rule on the running system (a blocked test connection, and Tor still working)…'
	);
	let checked = false;
	let probed = false;
	let torAfter = false;
	try {
		checked = rt.script('egress-check') === 0;
		probed = rt.script('egress-probe') === 0;
		torAfter = await rt.torWorks();
	} finally {
		stop();
	}
	if (!torAfter) {
		rt.script('egress-revert');
		rt.systemctl(['disable', EGRESS_UNIT]);
		return {
			strategy: 'reverted',
			verified: false,
			detail: `Tor-only egress rule: Tor stopped reaching the Tor network with the rule loaded, so the rule was lifted again and this server is as before. The next upgrade tries again${notes.length ? `; ${notes.join('; ')}` : ''}.`
		};
	}
	const enabled = rt.systemctl(['is-enabled', EGRESS_UNIT]).out.trim() === 'enabled';
	const ok = checked && probed && enabled && problems.length === 0;
	const ruleLine =
		checked && probed
			? `only Tor and i2pd reach the internet (rule loaded${enabled ? ' and loaded at every boot' : ''}; a test connection by an ordinary user was refused; Tor still works)`
			: `the rule is ${checked ? 'loaded but a test connection was not refused' : 'not loaded as written'} — on this server run: sudo sh /usr/local/lib/morphit/${EGRESS_SCRIPT} egress-check`;
	return {
		strategy,
		verified: ok,
		detail: `Tor-only egress rule: ${[ruleLine, ...notes, ...problems, ...(enabled ? [] : [`${EGRESS_UNIT} is not enabled; on this server run: sudo systemctl enable ${EGRESS_UNIT}`])].join('; ')}.`
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healTorOnlyEgress(ctx);
}

const sh = (
	cmd: string,
	args: readonly string[],
	timeout = 60_000,
	env?: NodeJS.ProcessEnv
): { status: number; out: string } => {
	try {
		const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout, env: env ?? process.env });
		return { status: r.status ?? 1, out: r.stdout ?? '' };
	} catch {
		return { status: 1, out: '' };
	}
};

function installRoot(): string {
	const env = (process.env.MORPHIT_INSTALL_DIR ?? '').trim();
	if (env !== '') return env;
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	if (m && m[1] && existsSync(join(m[1], 'ops'))) return m[1];
	return '/opt/morphit';
}

function realRuntime(): EgressRuntime {
	const socks = torSocksFromEnv();
	const helper = `/usr/local/lib/morphit/${EGRESS_SCRIPT}`;
	const bk = '/var/lib/morphit-tor-only/egress-backup';
	const put = (src: string, dst: string, mode: number): boolean => {
		try {
			const want = readFileSync(src);
			let have: Buffer | null = null;
			try {
				have = readFileSync(dst);
			} catch {
				/* not there yet */
			}
			if (have !== null && have.equals(want)) return true;
			mkdirSync(join(dst, '..'), { recursive: true });
			const tmp = `${dst}.morphit-tmp`;
			writeFileSync(tmp, want, { mode });
			renameSync(tmp, dst);
			return readFileSync(dst).equals(want);
		} catch {
			return false;
		}
	};
	return {
		torOnly: () => isHiddenOnlyNode(),
		torWorks: async () => {
			const onions = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => /\.onion:/.test(u)).slice(
				0,
				3
			);
			for (const u of onions) {
				const r = sh(
					'curl',
					[
						'-s',
						'-o',
						'/dev/null',
						'-m',
						'40',
						'-w',
						'%{http_code}',
						'--socks5-hostname',
						socks,
						`${u}/`
					],
					50_000
				);
				if (/^[1-5]\d\d$/.test(r.out.trim())) return true;
			}
			return false;
		},
		install: () => {
			const root = installRoot();
			const ok1 = put(join(root, 'ops/tor-only', EGRESS_SCRIPT), helper, 0o755);
			const ok2 = put(
				join(root, 'ops/systemd', EGRESS_UNIT),
				`/etc/systemd/system/${EGRESS_UNIT}`,
				0o644
			);
			if (ok1 && ok2) sh('systemctl', ['daemon-reload']);
			return ok1 && ok2;
		},
		script: (mode) => {
			try {
				mkdirSync(bk, { recursive: true, mode: 0o700 });
			} catch {
				/* the script says so if it needs it */
			}
			return sh('sh', [helper, mode, bk], 60_000, { ...process.env, MORPHIT_TOR_SOCKS: socks })
				.status;
		},
		systemctl: (args) => {
			const r = sh('systemctl', args, 180_000);
			return { ok: r.status === 0, out: r.out };
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		matrixDecision: () => {
			try {
				return readFileSync(MATRIX_TOR_ONLY_DECISION, 'utf8');
			} catch {
				return null;
			}
		}
	};
}
