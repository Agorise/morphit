/**
 * Installed-box heal: the relay's /v1/health stops publishing its operator
 * block to anonymous callers.
 *
 * WHY. relay.env.example shipped `MORPHIT_RELAY_VERBOSE_HEALTH=true`, and the
 * relay's own default was true, so every visitor could read the relay's
 * version, Node.js version, uptime, RPC node states and live signup counts.
 * The relay now serves that block only to a caller on the box that sends
 * `X-Morphit-Local-Health: 1` without forwarding headers (the indexer's own
 * check), unless the variable is true — which a box set up from the example
 * still has.
 *
 * WHAT, on this server:
 *  1. every env file the relay unit sources (in its order) that sets the
 *     variable to a true value gets `=false` on that line; nothing else in the
 *     file changes, and its owner and mode are kept;
 *  2. the relay restarts (only when a file changed and it is running) and is
 *     waited for;
 *  3. VERIFY by asking it, as a visitor would and as the indexer does:
 *     - the relay directly, with no header: no operator block;
 *     - each local web edge that answers (the frontend's loopback port that
 *       Tor/I2P reach, BunkerWeb or nginx on 443 for this domain), with a
 *       forged `X-Morphit-Local-Health: 1`: no operator block;
 *     - the relay directly with the header: the block IS there (the indexer's
 *       signup-anomaly check reads it).
 * FALLBACK when the block is still public after the restart: one more restart
 * (a restart that did not take). Otherwise a calm line naming the file and the
 * command for this server. All requests stay on 127.0.0.1 (names are given to
 * curl with --resolve, so nothing is looked up in DNS).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

export const VERBOSE_KEY = 'MORPHIT_RELAY_VERBOSE_HEALTH';
/** A field only the operator block has (signup_stats is there only when signups are wired). */
export const OPERATOR_MARKER = '"node_version"';

/** The env files the relay unit sources, in its order (last one wins). */
export function relayEnvFiles(root = ''): string[] {
	return [
		`${root}/opt/morphit/morphit.env`,
		`${root}/opt/morphit/morphit.config.env`,
		`${root}/etc/morphit/relay.env`,
		`${root}/etc/morphit/relay-vapid.env`
	];
}

const LINE = new RegExp(
	`^([ \\t]*(?:export[ \\t]+)?${VERBOSE_KEY}[ \\t]*=[ \\t]*)(.*?)[ \\t]*$`,
	'gm'
);
const TRUE = /^(["']?)(true|1|yes|on)\1$/i;

/** The text with every true assignment of the variable turned to false (the
 *  relay accepts true/1/yes/on). PURE. */
export function verboseOff(text: string): { text: string; changed: boolean } {
	let changed = false;
	const out = text.replace(LINE, (line, prefix: string, value: string) => {
		if (!TRUE.test(value.trim())) return line;
		changed = true;
		return `${prefix}false`;
	});
	return { text: out, changed };
}

/** The value of a plain `KEY=value` the files set (last file, last line wins). PURE. */
export function envValueIn(texts: readonly string[], key: string): string | null {
	let v: string | null = null;
	const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'gm');
	for (const t of texts)
		for (const m of t.matchAll(re)) v = (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2');
	return v;
}

export interface RelayHealthRuntime {
	readFile(path: string): string | null;
	/** Atomic replace keeping the owner and mode. */
	writeFile(path: string, text: string): boolean;
	relayActive(): boolean;
	restartRelay(): boolean;
	/** GET `url` on 127.0.0.1 (a name in it is resolved to 127.0.0.1 locally);
	 *  the body, or null when nothing answered. */
	get(url: string, headers: Readonly<Record<string, string>>): string | null;
	sleep(ms: number): Promise<void>;
}

export async function healRelayHealth(
	ctx: HealCtx,
	opts: { runtime?: RelayHealthRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const files = relayEnvFiles(opts.root ?? '');
	const texts = files.map((f) => ({ f, text: rt.readFile(f) }));
	const present = texts.filter((x): x is { f: string; text: string } => x.text !== null);

	// 1. Turn it off where it is on.
	const changed: string[] = [];
	const failed: string[] = [];
	for (const { f, text } of present) {
		const w = verboseOff(text);
		if (!w.changed) continue;
		if (rt.writeFile(f, w.text) && !verboseOff(rt.readFile(f) ?? text).changed) changed.push(f);
		else failed.push(f);
	}
	if (failed.length > 0)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Relay health: could not write ${failed.join(', ')}; on this server set ${VERBOSE_KEY}=false there, then run: sudo systemctl restart morphit-relay`
		};
	if (!rt.relayActive())
		return {
			strategy: changed.length > 0 ? 'env-only' : 'skipped',
			verified: true,
			detail:
				changed.length > 0
					? `Relay health: ${VERBOSE_KEY}=false written in ${changed.join(', ')} (read back); the relay is not running here, so it takes effect when it starts.`
					: 'Relay health: the relay does not run on this server.'
		};

	const after = present.map(({ f, text }) => rt.readFile(f) ?? text);
	const host = envValueIn(after, 'MORPHIT_RELAY_LISTEN_HOST') ?? '127.0.0.1';
	const port = envValueIn(after, 'MORPHIT_RELAY_LISTEN_PORT') ?? '8080';
	const direct = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/v1/health`;
	const domain = envValueIn(
		[`${opts.root ?? ''}/etc/morphit/first-online.env`, ...files].map((f) => rt.readFile(f) ?? ''),
		'MORPHIT_DOMAIN'
	);

	// 2. Restart, and wait until it answers.
	const restart = async (label: string): Promise<boolean> => {
		const stop = ctx.spinner(label);
		try {
			if (!rt.restartRelay()) return false;
			for (let i = 0; i < 20; i++) {
				if (rt.get(direct, {}) !== null) return true;
				await rt.sleep(1_500);
			}
			return false;
		} finally {
			stop();
		}
	};
	let strategy = changed.length > 0 ? 'env-false' : 'already';
	if (
		changed.length > 0 &&
		!(await restart('Restarting the relay so its health answer stops naming its internals…'))
	)
		ctx.warn(
			'The relay did not answer within 30 s of its restart; checking what it serves anyway.'
		);

	// 3. Observe.
	const edges = [
		'http://127.0.0.1:8090/relay/v1/health',
		...(domain && /^[a-z0-9.-]+$/i.test(domain) ? [`https://${domain}/relay/v1/health`] : [])
	];
	const observe = (): { publicBlock: string[]; localBlock: boolean; edgesSeen: number } => {
		const publicBlock: string[] = [];
		const anon = rt.get(direct, {});
		if (anon !== null && anon.includes(OPERATOR_MARKER)) publicBlock.push('the relay itself');
		let edgesSeen = 0;
		for (const e of edges) {
			const b = rt.get(e, { 'X-Morphit-Local-Health': '1' });
			if (b === null || !/"status"/.test(b)) continue;
			edgesSeen++;
			if (b.includes(OPERATOR_MARKER)) publicBlock.push(e.replace('/relay/v1/health', ''));
		}
		const local = rt.get(direct, { 'X-Morphit-Local-Health': '1' });
		return {
			publicBlock,
			localBlock: local !== null && local.includes(OPERATOR_MARKER),
			edgesSeen
		};
	};
	let seen = observe();
	if (seen.publicBlock.length > 0 && changed.length > 0) {
		strategy = 'second-restart';
		await restart('The relay still shows its internals; restarting it once more…');
		seen = observe();
	}
	const where = changed.length > 0 ? `${VERBOSE_KEY}=false in ${changed.join(', ')}; ` : '';
	if (seen.publicBlock.length > 0)
		return {
			strategy,
			verified: false,
			detail:
				`Relay health: ${where}anonymous callers still get the operator block from ${seen.publicBlock.join(', ')}. ` +
				`On this server check ${files.join(', ')} and the unit's drop-ins for ${VERBOSE_KEY}, then run: sudo systemctl restart morphit-relay`
		};
	return {
		strategy,
		verified: seen.localBlock,
		detail:
			`Relay health: ${where}anonymous callers get only the status (asked the relay directly` +
			(seen.edgesSeen > 0
				? ` and through ${seen.edgesSeen} local web edge(s) with a forged header)`
				: ')') +
			(seen.localBlock
				? "; the indexer's local check still gets the operator block."
				: "; the local check with X-Morphit-Local-Health got no operator block either, so the indexer's signup check sees nothing — on this server run: curl -s -H 'X-Morphit-Local-Health: 1' " +
					direct)
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healRelayHealth(ctx);
}

const sh = (cmd: string, args: string[], timeout = 15_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};

const realRuntime: RelayHealthRuntime = {
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: (p, text) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode: 0o600 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	relayActive: () => sh('systemctl', ['is-active', '--quiet', 'morphit-relay']).ok,
	restartRelay: () => sh('systemctl', ['restart', 'morphit-relay'], 90_000).ok,
	get: (url, headers) => {
		const u = new URL(url);
		const port = u.port || (u.protocol === 'https:' ? '443' : '80');
		const args = ['-s', '-k', '-m', '8', '--noproxy', '*', '-o', '-', '-w', '\n%{http_code}'];
		if (u.hostname !== '127.0.0.1') args.push('--resolve', `${u.hostname}:${port}:127.0.0.1`);
		for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
		const r = sh('curl', [...args, url]);
		const i = r.out.lastIndexOf('\n');
		const code = Number(r.out.slice(i + 1));
		return code > 0 ? r.out.slice(0, i) : null;
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
