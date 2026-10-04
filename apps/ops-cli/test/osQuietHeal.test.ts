import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { healOsQuiet, type QuietRuntime } from '../src/lib/osQuietHeal.ts';

const REPO = resolve(__dirname, '..', '..', '..');
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server: the REAL ops/tor-only scripts on a fake root, with stub systemctl and pro. */
function server(opts: { motd?: string; proNews?: 'True' | 'False'; maskFails?: boolean } = {}) {
	const d = mkdtempSync(join(tmpdir(), 'osquiet-'));
	dirs.push(d);
	const root = join(d, 'root');
	mkdirSync(join(root, 'etc/default'), { recursive: true });
	mkdirSync(join(root, 'etc/update-manager'), { recursive: true });
	// Ubuntu 24.04's update-manager-core default: a daily login-time check at
	// changelogs.ubuntu.com (Prompt=never stops it before any request).
	writeFileSync(
		join(root, 'etc/update-manager/release-upgrades'),
		'# Default behavior for the release upgrader.\n[DEFAULT]\nPrompt=lts\n'
	);
	writeFileSync(
		join(root, 'etc/default/motd-news'),
		opts.motd ?? 'ENABLED=1\nURLS="https://motd.ubuntu.com"\n'
	);
	const bin = join(d, 'bin');
	mkdirSync(bin);
	const state = join(d, 'units');
	writeFileSync(state, '');
	writeFileSync(
		join(bin, 'systemctl'),
		`#!/bin/sh
S=${state}
case "$1" in
 cat) case "$2" in pollinate.service|fwupd-refresh.timer|fwupd-refresh.service|snapd.service|ua-timer.timer) exit 0;; *) exit 1;; esac;;
 is-enabled) grep -qx "$2" "$S" && { echo masked; exit 0; }; echo enabled; exit 0;;
 mask) ${opts.maskFails ? 'exit 1' : 'echo "$2" >> "$S"; exit 0'};;
 unmask) grep -vx "$2" "$S" > "$S.n"; mv "$S.n" "$S"; exit 0;;
 *) exit 0;;
esac
`
	);
	const pro = join(d, 'pro-news');
	writeFileSync(pro, opts.proNews ?? 'True');
	writeFileSync(
		join(bin, 'pro'),
		`#!/bin/sh
case "$1 $2" in
 "config show") echo "apt_news $(cat ${pro})";;
 "config set") echo "$3" | sed 's/apt_news=//;s/false/False/;s/true/True/' > ${pro};;
esac
`
	);
	chmodSync(join(bin, 'systemctl'), 0o755);
	chmodSync(join(bin, 'pro'), 0o755);
	const env = {
		...process.env,
		MORPHIT_OS_ROOT: root,
		MORPHIT_SYSTEMCTL: join(bin, 'systemctl'),
		MORPHIT_PRO_BIN: join(bin, 'pro')
	};
	let n = 0;
	const rt: QuietRuntime = {
		run: (s, mode, bk) =>
			spawnSync(
				'sh',
				[
					join(
						REPO,
						'ops/tor-only',
						s === 'os' ? 'morphit-tor-only-os.sh' : 'morphit-tor-egress.sh'
					),
					mode,
					...(bk ? [bk] : [])
				],
				{ env, stdio: 'ignore' }
			).status ?? 1,
		scriptsPresent: () => true,
		backupDir: (p) => {
			const b = join(d, `bk-${p}-${n++}`);
			mkdirSync(b);
			return b;
		}
	};
	return {
		rt,
		motd: () => readFileSync(join(root, 'etc/default/motd-news'), 'utf8'),
		upgrades: () => readFileSync(join(root, 'etc/update-manager/release-upgrades'), 'utf8'),
		masked: () => readFileSync(state, 'utf8').split('\n').filter(Boolean).sort(),
		proNews: () => readFileSync(pro, 'utf8').trim()
	};
}

describe('the OS fetches a server does not need are off on every node', () => {
	it('a stock Ubuntu server: motd news, Pro apt news, fwupd refresh and pollinate off, read back; snapd and the Pro timer untouched', async () => {
		const s = server();
		const r = await healOsQuiet(ctx, { runtime: s.rt });
		expect(r.strategy).toBe('applied');
		expect(r.verified).toBe(true);
		expect(s.motd()).toMatch(/^ENABLED=0$/m);
		expect(s.proNews()).toBe('False');
		expect(s.upgrades()).toMatch(/^Prompt=never$/m);
		expect(s.upgrades()).not.toMatch(/^Prompt=lts$/m);
		expect(s.masked()).toEqual([
			'fwupd-refresh.service',
			'fwupd-refresh.timer',
			'pollinate.service'
		]);
	});
	it('already quiet: nothing changes', async () => {
		const s = server({ motd: 'ENABLED=0\n', proNews: 'False' });
		await healOsQuiet(ctx, { runtime: s.rt });
		const r = await healOsQuiet(ctx, { runtime: s.rt });
		expect(r.strategy).toBe('already');
		expect(s.motd()).toBe('ENABLED=0\n');
	});
	it('masking does not take: that part is put back and named, the news part still applied', async () => {
		const s = server({ maskFails: true });
		const r = await healOsQuiet(ctx, { runtime: s.rt });
		expect(r.strategy).toBe('partial');
		expect(r.verified).toBe(false);
		expect(s.masked()).toEqual([]);
		expect(s.motd()).toMatch(/^ENABLED=0$/m);
	});
});
