/**
 * Installed-box heal: the relay's Web Push keys exist, and its push subject is
 * not the generator's placeholder.
 *
 * WHY. The Ansible role wrote the VAPID keys with
 * `generate-vapid-keys.sh … > /etc/morphit/relay-vapid.env` and `creates:`: a
 * failed first run left an EMPTY file that every later run trusted, so push
 * stayed off for good. And an empty subject (a tor-only node without a mailto:
 * contact) came out as the generator's `mailto:operator@example.com`, which
 * also survived a later move to clearnet.
 *
 * WHAT, on this server:
 *  - a missing-key file (empty, or no private key) is regenerated through the
 *    release's scripts/generate-vapid-keys.sh into a temporary file and moved
 *    into place only when the keys are in it (root:morphit 0640);
 *  - a placeholder subject becomes https://<MORPHIT_DOMAIN> on a clearnet
 *    node, or empty (push off) on a tor-only one — the keys are kept, so no
 *    existing subscription is lost;
 *  then the relay restarts and, on a clearnet node, VERIFY: its local health
 *  answer says web_push is on. Otherwise the file is read back.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

export const VAPID_FILE = '/etc/morphit/relay-vapid.env';
export const PLACEHOLDER_SUBJECT =
	/^MORPHIT_RELAY_VAPID_SUBJECT=["']?mailto:operator@example\.com["']?\s*$/m;

/** The subject this node should have: https://<domain>, or '' on tor-only. PURE. */
export function wantedSubject(torOnly: boolean, domain: string | null): string | null {
	if (torOnly) return '';
	return domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain}` : null;
}

export function hasKeys(text: string): boolean {
	return (
		/^MORPHIT_RELAY_VAPID_PRIVATE_KEY=\S/m.test(text) &&
		/^MORPHIT_RELAY_VAPID_PUBLIC_KEY=\S/m.test(text)
	);
}

export interface VapidRuntime {
	readFile(path: string): string | null;
	writeFile(path: string, text: string): boolean;
	torOnly(): boolean;
	domain(): string | null;
	/** generate-vapid-keys.sh --bare [--subject s] output; null on failure. */
	generate(subject: string): string | null;
	relayActive(): boolean;
	restartRelay(): boolean;
	/** web_push from the relay's local health answer; null if unknown. */
	webPush(): boolean | null;
	sleep(ms: number): Promise<void>;
}

export async function healVapid(
	ctx: HealCtx,
	opts: { runtime?: VapidRuntime; path?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const p = opts.path ?? VAPID_FILE;
	const text = rt.readFile(p);
	if (text === null)
		return {
			strategy: 'skipped',
			verified: true,
			detail: 'Web Push keys: none on this server (push not set up); nothing to do.'
		};
	const torOnly = rt.torOnly();
	const subject = wantedSubject(torOnly, rt.domain());
	let next = text;
	let what = '';
	if (!hasKeys(text)) {
		const gen = rt.generate(subject ?? '');
		if (gen === null || !hasKeys(gen))
			return {
				strategy: 'left-alone',
				verified: false,
				detail: `Web Push keys: ${p} has no keys and new ones could not be made here; on this server run: sudo bash /opt/morphit/scripts/generate-vapid-keys.sh --bare --subject https://<your domain> > /tmp/v && sudo mv /tmp/v ${p}`
			};
		next =
			subject === ''
				? gen.replace(/^MORPHIT_RELAY_VAPID_SUBJECT=.*$/m, 'MORPHIT_RELAY_VAPID_SUBJECT=')
				: gen;
		what = 'new keys made (the file was empty)';
	} else if (PLACEHOLDER_SUBJECT.test(text) && subject !== null) {
		next = text.replace(
			/^MORPHIT_RELAY_VAPID_SUBJECT=.*$/m,
			`MORPHIT_RELAY_VAPID_SUBJECT=${subject}`
		);
		what =
			subject === ''
				? 'placeholder subject removed (push stays off on a tor-only node)'
				: `subject set to ${subject} (was the example.com placeholder; keys kept)`;
	}
	if (next === text)
		return { strategy: 'already', verified: true, detail: 'Web Push keys: in place.' };
	if (!rt.writeFile(p, next) || rt.readFile(p) !== next)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Web Push keys: could not update ${p}.`
		};
	if (!rt.relayActive())
		return {
			strategy: 'written',
			verified: true,
			detail: `Web Push keys: ${what} (read back); the relay is not running here.`
		};
	const stop = ctx.spinner('Restarting the relay with its Web Push keys…');
	let push: boolean | null = null;
	try {
		rt.restartRelay();
		for (let i = 0; i < 15 && push === null; i++) {
			await rt.sleep(2_000);
			push = rt.webPush();
		}
	} finally {
		stop();
	}
	if (torOnly || subject === '')
		return {
			strategy: 'written',
			verified: true,
			detail: `Web Push keys: ${what} (read back; push stays off on a hidden-only relay).`
		};
	return push === true
		? {
				strategy: 'written',
				verified: true,
				detail: `Web Push keys: ${what}; the relay reports push on.`
			}
		: {
				strategy: 'written',
				verified: false,
				detail: `Web Push keys: ${what}, but the relay does not report push on yet; on this server run: curl -s -H 'X-Morphit-Local-Health: 1' http://127.0.0.1:8080/v1/health`
			};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healVapid(ctx);
}

const installRoot = (): string => {
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	return (
		(process.env.MORPHIT_INSTALL_DIR ?? '').trim() ||
		(m && m[1] && existsSync(join(m[1], 'scripts')) ? m[1] : '/opt/morphit')
	);
};

const realRuntime: VapidRuntime = {
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
			writeFileSync(tmp, text, { mode: 0o640 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	torOnly: () => isHiddenOnlyNode(),
	domain: () => {
		for (const f of [
			'/etc/morphit/first-online.env',
			'/opt/morphit/morphit.env',
			'/opt/morphit/morphit.config.env'
		]) {
			try {
				const m = /^MORPHIT_DOMAIN=["']?([^"'\s]+)/m.exec(readFileSync(f, 'utf8'));
				if (m) return m[1]!;
			} catch {
				/* next */
			}
		}
		return null;
	},
	generate: (subject) => {
		const d = mkdtempSync('/tmp/morphit-vapid-');
		try {
			const r = spawnSync(
				'bash',
				[
					join(installRoot(), 'scripts/generate-vapid-keys.sh'),
					'--bare',
					...(subject ? ['--subject', subject] : [])
				],
				{
					encoding: 'utf8',
					timeout: 60_000,
					cwd: d
				}
			);
			return r.status === 0 ? r.stdout : null;
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	},
	relayActive: () => spawnSync('systemctl', ['is-active', '--quiet', 'morphit-relay']).status === 0,
	restartRelay: () =>
		spawnSync('systemctl', ['restart', 'morphit-relay'], { timeout: 90_000 }).status === 0,
	webPush: () => {
		const r = spawnSync(
			'curl',
			[
				'-s',
				'-m',
				'5',
				'--noproxy',
				'*',
				'-H',
				'X-Morphit-Local-Health: 1',
				'http://127.0.0.1:8080/v1/health'
			],
			{ encoding: 'utf8' }
		);
		try {
			const v = (JSON.parse(r.stdout) as { web_push?: unknown }).web_push;
			return typeof v === 'boolean' ? v : null;
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
