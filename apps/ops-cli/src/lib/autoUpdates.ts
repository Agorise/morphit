/**
 * Installed-box heal (v1.24.7): the server keeps itself patched, and says so
 * only when it cannot.
 *
 * WHY. The owner's goal is servers that look after themselves without
 * worrying their admins about every new vulnerability. The servers' own
 * answers (`security-updates-check.sh`, 2026-11-19) showed where that stopped:
 *  - every server installed Ubuntu's security fixes daily, but none restarted
 *    for them: kernel and libc fixes had waited 5–6 days on three servers, and
 *    one still ran the kernel of its last restart 84 days before;
 *  - morphitlat runs Linux Mint 22.3 (Ubuntu 24.04 underneath). The usual
 *    setting names Ubuntu's security pocket as `${distro_id}:…-security`,
 *    which on Mint reads `Linuxmint:zena-security` and matches nothing: it had
 *    never installed a security fix (235 were waiting);
 *  - Docker Engine and containerd come from Docker's own repository on every
 *    server, which Ubuntu's automatic updates never touch.
 *
 * WHAT, on this server (settings in /etc/morphit/updates.env, written with
 * their defaults when missing; the owner's choices of 2026-11-19 are those
 * defaults):
 *  1. unattended-upgrades installed (over Tor on a zero-clearnet node whose apt
 *     goes through Tor; nothing is fetched otherwise there);
 *  2. /etc/apt/apt.conf.d/52morphit-automatic-updates, after the system's own
 *     files so its values win: daily package lists and installs; Ubuntu's
 *     security pockets named by their real origin (`origin=Ubuntu`), so Mint
 *     and other Ubuntu-based systems match them; Docker's repository, named by
 *     the origin, codename and label apt itself reports for it (never
 *     assumed); and a restart at MORPHIT_AUTO_RESTART_TIME when an update
 *     needs one, unless someone is logged in when the day's run finishes
 *     (unattended-upgrades checks then and schedules `shutdown -r <time>`;
 *     read in its code, 2.9.1: it does so even after a run that installed
 *     nothing, so a restart already pending is done the next night);
 *  3. /etc/apt/preferences.d/morphit-docker-major: each Docker package stays
 *     on its installed major version (Docker 29.x, containerd 2.x); a new
 *     major waits for a Morphit release tested with it. Proven with apt and
 *     unattended-upgrades 2.9.1 against a stand-in repository: without the pin
 *     it takes 30.0, with it 29.9;
 *  4. the apt-daily timers on.
 * v1.24.8:
 *  5. Node.js from NodeSource's repository (it runs the Morphit services; a
 *     server installed online takes Node 22 from deb.nodesource.com, which
 *     none of the above touched, so its Node kept every hole found since it
 *     was installed): its updates within the installed major version install
 *     by themselves (named by site and origin as apt reports them, pinned in
 *     /etc/apt/preferences.d/morphit-node-major like Docker), and apt runs
 *     ops/scripts/morphit-node-restart.sh after each package change, which
 *     restarts the Morphit services still running a node an update replaced
 *     (a running program keeps its old file). A server installed from the
 *     offline bundle runs the Node the release brings (lib/nodeRuntimeHeal.ts);
 *  6. settings files changed on the server are kept when a package brings a
 *     new default (`--force-confdef --force-confold`): without it,
 *     unattended-upgrades skips any package whose update would ask about one
 *     (read in its code, 2.9.1: conffile_prompt), so a security fix for a
 *     package whose settings the server changed never installed.
 * VERIFIED by reading apt's own merged settings back (`apt-config dump`), by
 * apt knowing an Ubuntu security source, by Docker's and Node's candidate
 * versions staying on the installed major, and by both timers being enabled
 * and active.
 * Never throws; changes nothing it does not own.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { runAsync } from './spinRun.ts';

export const UPDATES_ENV = '/etc/morphit/updates.env';
export const APT_CONF = '/etc/apt/apt.conf.d/52morphit-automatic-updates';
export const DOCKER_PIN = '/etc/apt/preferences.d/morphit-docker-major';
export const NODE_PIN = '/etc/apt/preferences.d/morphit-node-major';
/** NodeSource's packages that are pinned to their installed major version. */
export const NODE_PACKAGES = ['nodejs'] as const;
/** The site NodeSource's repository is fetched from. */
export const NODESOURCE_SITE = 'deb.nodesource.com';
/** The script apt runs after each package change (relative to the install). */
export const NODE_RESTART_SCRIPT = 'ops/scripts/morphit-node-restart.sh';
/** Settings files changed on the server stay as they are. */
export const KEEP_LOCAL_CONFIG = ['--force-confdef', '--force-confold'] as const;
/** The one-line stopgap the owner was given on 2026-11-19 for Linux Mint
 *  (morphitlat), before this heal existed; this file replaces it. */
export const STOPGAP_CONF = '/etc/apt/apt.conf.d/52morphit-security-updates';
export const STOPGAP_TEXT =
	'Unattended-Upgrade::Origins-Pattern { "origin=Ubuntu,archive=noble-security"; };';
export const APT_TIMERS = ['apt-daily.timer', 'apt-daily-upgrade.timer'] as const;

export type ReleaseInstalls = 'security' | 'all' | 'off';

export interface UpdateSettings {
	/** Ubuntu's security fixes install by themselves. */
	readonly securityUpdates: boolean;
	/** The server restarts by itself when an update needs it. */
	readonly autoRestart: boolean;
	/** When, by the server's own clock (HH:MM). */
	readonly restartTime: string;
	/** Docker's own updates, within the installed major version. */
	readonly dockerUpdates: boolean;
	/** Node.js from NodeSource, within the installed major version (v1.24.8). */
	readonly nodeUpdates: boolean;
	/** Tor from the Tor Project's own repository (v1.24.8,
	 *  lib/torProjectRepoHeal.ts). */
	readonly torUpdates: boolean;
	/** Which new Morphit releases install by themselves (lib/autoInstallRelease.ts). */
	readonly installReleases: ReleaseInstalls;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
	securityUpdates: true,
	autoRestart: true,
	restartTime: '04:30',
	dockerUpdates: true,
	nodeUpdates: true,
	torUpdates: true,
	installReleases: 'security'
};

/** The Node.js setting's lines (v1.24.8); added to an updates.env written
 *  before it existed. */
export const NODE_SETTING_TEXT = `#
# Node.js from NodeSource's repository (it runs the Morphit services): its
# updates within the installed major version (Node 22) install by themselves,
# and the Morphit services restart onto the new one. A new major version waits
# for a Morphit release tested with it:
MORPHIT_NODE_UPDATES=on
`;

/** The Tor setting's lines (v1.24.8). */
export const TOR_SETTING_TEXT = `#
# Tor from the Tor Project's own repository (Ubuntu's copy falls months
# behind Tor's security releases): Morphit moves Tor there, keeping your Tor
# settings, and its updates install by themselves (Tor restarts for a moment):
MORPHIT_TOR_UPDATES=on
`;

/** Settings added after v1.24.7: [key, its lines], in the file's order. */
export const ADDED_SETTINGS: ReadonlyArray<readonly [string, string]> = [
	['MORPHIT_NODE_UPDATES', NODE_SETTING_TEXT],
	['MORPHIT_TOR_UPDATES', TOR_SETTING_TEXT]
];

/** What /etc/morphit/updates.env holds when Morphit writes it. */
export const UPDATES_ENV_DEFAULT_TEXT = `# Morphit — automatic updates on this server (since v1.24.7).
# morphit-ops upgrade sets apt up to match this file. After a change, on this
# server: sudo morphit-ops upgrade --heals
#
# Ubuntu's security fixes install by themselves every day (on or off):
MORPHIT_SECURITY_UPDATES=on
#
# When one of them needs a restart (a new kernel, libc), the server restarts
# by itself at this time of its own clock, unless someone is logged in when
# the day's updates finish (then it waits for a day's run that finds nobody):
MORPHIT_AUTO_RESTART=on
MORPHIT_AUTO_RESTART_TIME=04:30
#
# Docker Engine and containerd from Docker's own repository: their updates
# within the installed major version (Docker 29.x) install by themselves too.
# A new major version waits for a Morphit release tested with it:
MORPHIT_DOCKER_UPDATES=on
${NODE_SETTING_TEXT}${TOR_SETTING_TEXT}#
# New Morphit releases. "security": a release marked as a security release
# installs itself early in the morning (05:15 by this server's clock), checked
# against @morphit's on-chain record first
# and rolled back if anything fails; "all": every release does; "off": you
# upgrade yourself (sudo morphit-ops, option 2):
MORPHIT_AUTO_INSTALL_RELEASES=security
`;

const ON = /^(on|yes|true|1)$/i;
const OFF = /^(off|no|false|0)$/i;

/** PURE. The settings in an updates.env text (null: no file), and what in it
 *  was not understood (that setting keeps its default). */
export function parseUpdateSettings(text: string | null): {
	settings: UpdateSettings;
	problems: string[];
} {
	const s: { -readonly [K in keyof UpdateSettings]: UpdateSettings[K] } = {
		...DEFAULT_UPDATE_SETTINGS
	};
	const problems: string[] = [];
	const values = new Map<string, string>();
	for (const raw of (text ?? '').split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		values.set(m[1]!, m[2]!.replace(/^(["'])(.*)\1$/, '$2').trim());
	}
	const flag = (key: string, set: (v: boolean) => void, def: boolean): void => {
		const v = values.get(key);
		if (v === undefined) return;
		if (ON.test(v)) set(true);
		else if (OFF.test(v)) set(false);
		else problems.push(`${key}=${v} is neither on nor off; ${def ? 'on' : 'off'} is used`);
	};
	flag(
		'MORPHIT_SECURITY_UPDATES',
		(v) => (s.securityUpdates = v),
		DEFAULT_UPDATE_SETTINGS.securityUpdates
	);
	flag('MORPHIT_AUTO_RESTART', (v) => (s.autoRestart = v), DEFAULT_UPDATE_SETTINGS.autoRestart);
	flag(
		'MORPHIT_DOCKER_UPDATES',
		(v) => (s.dockerUpdates = v),
		DEFAULT_UPDATE_SETTINGS.dockerUpdates
	);
	flag('MORPHIT_NODE_UPDATES', (v) => (s.nodeUpdates = v), DEFAULT_UPDATE_SETTINGS.nodeUpdates);
	flag('MORPHIT_TOR_UPDATES', (v) => (s.torUpdates = v), DEFAULT_UPDATE_SETTINGS.torUpdates);
	const time = values.get('MORPHIT_AUTO_RESTART_TIME');
	if (time !== undefined) {
		const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
		if (m) s.restartTime = `${m[1]!.padStart(2, '0')}:${m[2]}`;
		else
			problems.push(
				`MORPHIT_AUTO_RESTART_TIME=${time} is not a time of day (HH:MM); ${DEFAULT_UPDATE_SETTINGS.restartTime} is used`
			);
	}
	const rel = values.get('MORPHIT_AUTO_INSTALL_RELEASES');
	if (rel !== undefined) {
		const v = rel.toLowerCase();
		if (v === 'security' || v === 'all') s.installReleases = v;
		else if (OFF.test(v)) s.installReleases = 'off';
		else
			problems.push(
				`MORPHIT_AUTO_INSTALL_RELEASES=${rel} is not security, all or off; security is used`
			);
	}
	return { settings: s, problems };
}

/** PURE. The Ubuntu release this system is (or is built on), from
 *  /etc/os-release: Ubuntu itself, or one that names an UBUNTU_CODENAME
 *  (Linux Mint, Pop!_OS …). null for anything else. */
export function ubuntuBase(osRelease: string | null): {
	codename: string;
	name: string;
	derivative: boolean;
} | null {
	const get = (k: string): string => {
		const m = new RegExp(`^${k}=(.*)$`, 'm').exec(osRelease ?? '');
		return m ? m[1]!.trim().replace(/^(["'])(.*)\1$/, '$2') : '';
	};
	const id = get('ID').toLowerCase();
	const like = get('ID_LIKE').toLowerCase().split(/\s+/);
	const codename = get('UBUNTU_CODENAME') || (id === 'ubuntu' ? get('VERSION_CODENAME') : '');
	if (!/^[a-z]+$/.test(codename) || (id !== 'ubuntu' && !like.includes('ubuntu'))) return null;
	return { codename, name: get('PRETTY_NAME') || id, derivative: id !== 'ubuntu' };
}

/** One apt source as `apt-cache policy` reports it. */
export interface AptRelease {
	readonly o: string;
	readonly a: string;
	readonly n: string;
	readonly l: string;
	readonly c: string;
	/** The site it is fetched from (`download.docker.com`), '' for a local one. */
	readonly site: string;
}

/** PURE. The sources in `apt-cache policy` (no arguments): each
 *  " 500 <uri> <suite>/<component> <arch> Packages" line, its "release o=…"
 *  line and its "origin <site>" line. */
export function parsePolicyReleases(policy: string): AptRelease[] {
	const out: AptRelease[] = [];
	const lines = policy.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const rel = /^\s+release (.*)$/.exec(lines[i]!);
		if (!rel) continue;
		const f = new Map<string, string>();
		// Values may hold spaces ("l=Docker CE"); fields are comma-separated.
		for (const part of rel[1]!.split(',')) {
			const eq = part.indexOf('=');
			if (eq > 0) f.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
		}
		const origin = /^\s+origin (\S+)\s*$/.exec(lines[i + 1] ?? '');
		out.push({
			o: f.get('o') ?? '',
			a: f.get('a') ?? '',
			n: f.get('n') ?? '',
			l: f.get('l') ?? '',
			c: f.get('c') ?? '',
			site: origin ? origin[1]! : ''
		});
	}
	return out;
}

/** PURE. Docker's own repository among apt's sources, or null. */
export function dockerRelease(releases: readonly AptRelease[]): AptRelease | null {
	return releases.find((r) => r.site === 'download.docker.com' && r.o !== '' && r.n !== '') ?? null;
}

/** PURE. NodeSource's repository among apt's sources, or null. */
export function nodeSourceRelease(releases: readonly AptRelease[]): AptRelease | null {
	return releases.find((r) => r.site === NODESOURCE_SITE && r.o !== '' && r.n !== '') ?? null;
}

/** The Tor Project's repository: its site and its onion (both its own). */
export const TORPROJECT_SITES = [
	'deb.torproject.org',
	'apow7mjfryruh65chtdydfmqfpj5btws7nbocgtaovhvezgccyjazpqd.onion'
] as const;

/** PURE. The Tor Project's repository among apt's sources, or null. */
export function torProjectRelease(releases: readonly AptRelease[]): AptRelease | null {
	return (
		releases.find(
			(r) => (TORPROJECT_SITES as readonly string[]).includes(r.site) && r.o !== '' && r.n !== ''
		) ?? null
	);
}

/** PURE. The DPkg::Post-Invoke command that runs the restart script, or null
 *  for a path that is not plainly a path (it goes into apt's settings and a
 *  shell). */
export function nodeRestartHook(script: string | null): string | null {
	if (script === null || !/^\/[A-Za-z0-9._/-]+$/.test(script)) return null;
	return `if [ -x ${script} ]; then ${script} || true; fi`;
}

/** An Origins-Pattern value: commas inside a value are escaped, as
 *  unattended-upgrades reads them; it compares values with fnmatch, so
 *  `*`, `?` and `[` are matched as themselves (NodeSource's origin is
 *  ". nodistro", as apt reports it on morphit.io). */
const pv = (v: string): string => v.replace(/[*?[]/g, (c) => `[${c}]`).replace(/,/g, '\\,');

/** PURE. The security patterns for an Ubuntu base. */
export function securityPatterns(codename: string): string[] {
	return [
		`origin=Ubuntu,archive=${codename}-security`,
		`origin=UbuntuESMApps,archive=${codename}-apps-security`,
		`origin=UbuntuESM,archive=${codename}-infra-security`
	];
}

/** PURE. The pattern for a vendor's repository (Docker's, NodeSource's), from
 *  what apt reports for it — and from its site, so another source that calls
 *  itself "Docker" (a mirror, someone's own repository) is never updated from
 *  (proven with apt over HTTP: the same packages from another site are not
 *  taken). */
export function repoPattern(r: AptRelease): string {
	return `origin=${pv(r.o)},codename=${pv(r.n)}${r.l ? `,label=${pv(r.l)}` : ''}${r.site ? `,site=${pv(r.site)}` : ''}`;
}
export const dockerPattern = repoPattern;

/** PURE. /etc/apt/apt.conf.d/52morphit-automatic-updates. */
export function aptConfText(o: {
	readonly codename: string;
	readonly docker: AptRelease | null;
	readonly node?: AptRelease | null;
	readonly tor?: AptRelease | null;
	/** nodeRestartHook()'s command (null: none). */
	readonly hook?: string | null;
	readonly restart: boolean;
	readonly time: string;
}): string {
	const patterns = [
		...securityPatterns(o.codename),
		...(o.docker ? [repoPattern(o.docker)] : []),
		...(o.node ? [repoPattern(o.node)] : []),
		...(o.tor ? [repoPattern(o.tor)] : [])
	];
	return [
		'// Morphit (morphit-ops upgrade, since v1.24.7): this server keeps itself patched.',
		`// Change it in ${UPDATES_ENV}, then on this server: sudo morphit-ops upgrade --heals`,
		'// (this file is rewritten from that one).',
		'APT::Periodic::Update-Package-Lists "1";',
		'APT::Periodic::Unattended-Upgrade "1";',
		'Unattended-Upgrade::Origins-Pattern {',
		...patterns.map((p) => `\t"${p}";`),
		'};',
		`Unattended-Upgrade::Automatic-Reboot "${o.restart ? 'true' : 'false'}";`,
		'Unattended-Upgrade::Automatic-Reboot-WithUsers "false";',
		`Unattended-Upgrade::Automatic-Reboot-Time "${o.time}";`,
		'Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";',
		'// A settings file changed on this server stays as it is when a package brings',
		'// a new default, so no update stops to ask (unattended-upgrades skips one that would).',
		`DPkg::Options { ${KEEP_LOCAL_CONFIG.map((x) => `"${x}";`).join(' ')} };`,
		...(o.hook
			? [
					'// After a Node.js update, the Morphit services restart onto the new Node.',
					`DPkg::Post-Invoke { "${o.hook}"; };`
				]
			: []),
		''
	].join('\n');
}

/** Docker's packages that are pinned to their installed major version. */
export const DOCKER_PACKAGES = [
	'docker-ce',
	'docker-ce-cli',
	'docker-ce-rootless-extras',
	'containerd.io',
	'docker-compose-plugin',
	'docker-buildx-plugin'
] as const;

/** PURE. `5:29.8.0-1~ubuntu…` → `5:29.*`; `2.3.5-1~…` → `2.*`; null when the
 *  version does not start with a number. */
export function majorPin(version: string): string | null {
	const m = /^(?:(\d+):)?(\d+)\./.exec(version.trim());
	if (!m) return null;
	return `${m[1] !== undefined ? `${m[1]}:` : ''}${m[2]}.*`;
}

/** PURE. /etc/apt/preferences.d/morphit-docker-major for the installed Docker
 *  packages (name → version): each may move within its pin, and to nothing
 *  else. apt takes the FIRST record that matches a version, so the "any
 *  version: never" record comes last. null when none is installed. */
export function dockerPinText(installed: Readonly<Record<string, string>>): string | null {
	return majorPinText(
		[
			'# Morphit (morphit-ops upgrade, since v1.24.7): Docker updates by itself within',
			'# the major version installed here. A new major version waits for a Morphit',
			`# release tested with it. Off: MORPHIT_DOCKER_UPDATES=off in ${UPDATES_ENV}.`
		],
		DOCKER_PACKAGES,
		installed
	);
}

/** PURE. /etc/apt/preferences.d/morphit-node-major (v1.24.8), as for Docker. */
export function nodePinText(installed: Readonly<Record<string, string>>): string | null {
	return majorPinText(
		[
			'# Morphit (morphit-ops upgrade, since v1.24.8): Node.js updates by itself within',
			'# the major version installed here. A new major version waits for a Morphit',
			`# release tested with it. Off: MORPHIT_NODE_UPDATES=off in ${UPDATES_ENV}.`
		],
		NODE_PACKAGES,
		installed
	);
}

function majorPinText(
	header: readonly string[],
	packages: readonly string[],
	installed: Readonly<Record<string, string>>
): string | null {
	const groups = new Map<string, string[]>();
	for (const p of packages) {
		const v = installed[p];
		if (!v) continue;
		const pin = majorPin(v);
		if (pin === null) continue;
		groups.set(pin, [...(groups.get(pin) ?? []), p]);
	}
	if (groups.size === 0) return null;
	const all = [...groups.values()].flat();
	return [
		...header,
		...[...groups.entries()].flatMap(([pin, pkgs]) => [
			'',
			`Package: ${pkgs.join(' ')}`,
			`Pin: version ${pin}`,
			'Pin-Priority: 500'
		]),
		'',
		`Package: ${all.join(' ')}`,
		'Pin: version *',
		'Pin-Priority: -1',
		''
	].join('\n');
}

/** PURE. The values `apt-config dump` reports: last wins for a scalar; every
 *  item for a list (`Key:: "item";`). */
export function aptConfigValues(dump: string): {
	scalar(key: string): string | null;
	list(key: string): string[];
} {
	const scalars = new Map<string, string>();
	const lists = new Map<string, string[]>();
	for (const line of dump.split('\n')) {
		const li = /^(\S+?):: "(.*)";$/.exec(line);
		if (li) {
			lists.set(li[1]!, [...(lists.get(li[1]!) ?? []), li[2]!]);
			continue;
		}
		const sc = /^(\S+) "(.*)";$/.exec(line);
		if (sc) scalars.set(sc[1]!, sc[2]!);
	}
	return {
		scalar: (k) => scalars.get(k) ?? null,
		list: (k) => lists.get(k) ?? []
	};
}

export interface AutoUpdatesRuntime {
	hasApt(): boolean;
	osRelease(): string | null;
	readFile(path: string): string | null;
	/** Atomic (temp file, then rename); never through a link. */
	writeFile(path: string, data: string, mode: number): boolean;
	removeFile(path: string): boolean;
	isInstalled(pkg: string): boolean;
	/** `apt-get install -y <pkgs>` with this server's apt settings. */
	installPackages(pkgs: readonly string[]): Promise<boolean>;
	/** `apt-cache policy` (no arguments). */
	aptPolicy(): string;
	/** `apt-cache policy <pkg>`'s Candidate (null: none). */
	candidate(pkg: string): string | null;
	/** Installed version of each package that is installed. */
	installedVersions(pkgs: readonly string[]): Record<string, string>;
	/** `apt-config dump`. */
	aptConfig(): string;
	/** `systemctl enable --now` each; then whether each is enabled and active. */
	enableTimers(units: readonly string[]): Record<string, boolean>;
	hiddenOnly(): boolean;
	/** The absolute path of ops/scripts/morphit-node-restart.sh in this
	 *  install when it is there, executable, owned by root and writable by
	 *  nobody else (apt runs it as root), else null (v1.24.8). */
	nodeRestartScript(): string | null;
}

const MAJOR_OF = (v: string | null): string | null => (v === null ? null : majorPin(v));

/** "Node 22.x" for the installed nodejs package ('' when none). */
function nodeMajor(installed: Readonly<Record<string, string>>): string {
	const m = /^(?:\d+:)?(\d+)\./.exec(installed['nodejs'] ?? '');
	return m ? `Node ${m[1]}.x` : '';
}

/** Header line of the updates.env Morphit writes. */
const UPDATES_ENV_HEADER = '# Morphit — automatic updates on this server';

/** "Docker 29.x and containerd 2.x" for the installed Docker packages. */
function dockerMajors(installed: Readonly<Record<string, string>>): string {
	const parts: string[] = [];
	const d = installed['docker-ce'];
	const c = installed['containerd.io'];
	const major = (v: string) => /^(?:\d+:)?(\d+)\./.exec(v)?.[1];
	if (d && major(d)) parts.push(`Docker ${major(d)}.x`);
	if (c && major(c)) parts.push(`containerd ${major(c)}.x`);
	return parts.join(' and ');
}

export async function healAutomaticUpdates(
	ctx: HealCtx,
	rt: AutoUpdatesRuntime
): Promise<HealResult> {
	if (!rt.hasApt())
		return {
			strategy: 'not-apt',
			verified: true,
			routine: true,
			detail: 'Automatic updates: no apt on this server.'
		};

	// 0. The settings (written with their defaults the first time).
	let text = rt.readFile(UPDATES_ENV);
	let created = false;
	if (text === null) {
		if (rt.writeFile(UPDATES_ENV, UPDATES_ENV_DEFAULT_TEXT, 0o644)) {
			text = UPDATES_ENV_DEFAULT_TEXT;
			created = true;
		}
	}
	// A file Morphit wrote before a setting existed gets that setting's lines at
	// its end (the admin's own lines stay as they are).
	let added = false;
	if (text !== null && text.startsWith(UPDATES_ENV_HEADER)) {
		const missing = ADDED_SETTINGS.filter(
			([key]) => !new RegExp(`^\\s*${key}\\s*=`, 'm').test(text!)
		);
		if (missing.length > 0) {
			const next = `${text}${text.endsWith('\n') ? '' : '\n'}${missing.map(([, t]) => t).join('')}`;
			if (rt.writeFile(UPDATES_ENV, next, 0o644) && rt.readFile(UPDATES_ENV) === next) {
				text = next;
				added = true;
			}
		}
	}
	const { settings, problems } = parseUpdateSettings(text);
	const said = problems.length > 0 ? ` In ${UPDATES_ENV}: ${problems.join('; ')}.` : '';

	if (!settings.securityUpdates) {
		const removed = [APT_CONF, DOCKER_PIN, NODE_PIN].filter((p) => rt.readFile(p) !== null);
		const gone = removed.every((p) => rt.removeFile(p) && rt.readFile(p) === null);
		return {
			strategy: 'off',
			verified: gone,
			routine: removed.length === 0 && problems.length === 0,
			detail: gone
				? `Automatic updates are off on this server, as set in ${UPDATES_ENV} (MORPHIT_SECURITY_UPDATES=off): Morphit installs nothing by itself and does not restart the server.${removed.length > 0 ? ` Its apt settings were removed (${removed.join(', ')}).` : ''}${said}`
				: `Automatic updates are off in ${UPDATES_ENV}, but Morphit's apt settings could not be removed (${removed.join(', ')}). On this server: sudo rm ${removed.join(' ')}`
		};
	}

	// 1. An Ubuntu base.
	const base = ubuntuBase(rt.osRelease());
	if (base === null)
		return {
			strategy: 'not-ubuntu',
			verified: true,
			detail: `Automatic updates: this server is not Ubuntu or built on it, so its update settings are left as they are.${said}`
		};

	// 2. unattended-upgrades.
	let policy = rt.aptPolicy();
	if (!rt.isInstalled('unattended-upgrades')) {
		const viaTor = /tor\+https?:\/\//.test(policy) || /socks5h?:\/\//.test(rt.aptConfig());
		if (rt.hiddenOnly() && !viaTor)
			return {
				strategy: 'waiting',
				verified: false,
				detail:
					"Automatic updates: unattended-upgrades is not installed, and this zero-clearnet server's apt does not fetch through Tor yet, so nothing was fetched. The next upgrade installs it once apt goes through Tor."
			};
		const stop = ctx.spinner('Installing unattended-upgrades (automatic security updates)…');
		try {
			await rt.installPackages(['unattended-upgrades']);
		} finally {
			stop();
		}
		if (!rt.isInstalled('unattended-upgrades'))
			return {
				strategy: 'install-failed',
				verified: false,
				detail:
					'Automatic updates: unattended-upgrades could not be installed, so this server does not patch itself. On this server: sudo apt-get install -y unattended-upgrades — then: sudo morphit-ops upgrade --heals'
			};
		policy = rt.aptPolicy();
	}

	// 3. The settings files.
	const releases = parsePolicyReleases(policy);
	const docker = settings.dockerUpdates ? dockerRelease(releases) : null;
	const installedDocker = docker ? rt.installedVersions(DOCKER_PACKAGES) : {};
	const pin = docker ? dockerPinText(installedDocker) : null;
	const node = settings.nodeUpdates ? nodeSourceRelease(releases) : null;
	const installedNode = node ? rt.installedVersions(NODE_PACKAGES) : {};
	const nodePin = node ? nodePinText(installedNode) : null;
	const hook = nodeRestartHook(rt.nodeRestartScript());
	const tor = settings.torUpdates ? torProjectRelease(releases) : null;
	const conf = aptConfText({
		codename: base.codename,
		docker: pin !== null ? docker : null,
		node: nodePin !== null ? node : null,
		tor,
		hook,
		restart: settings.autoRestart,
		time: settings.restartTime
	});
	const changed: string[] = [];
	const failed: string[] = [];
	const put = (path: string, want: string | null): void => {
		const have = rt.readFile(path);
		if (want === null) {
			if (have !== null) (rt.removeFile(path) ? changed : failed).push(path);
			return;
		}
		if (have === want) return;
		(rt.writeFile(path, want, 0o644) ? changed : failed).push(path);
	};
	put(APT_CONF, conf);
	put(DOCKER_PIN, pin);
	put(NODE_PIN, nodePin);
	// The stopgap, only when it holds exactly that one line (anything else in a
	// file of that name is someone's own, and stays).
	if (rt.readFile(STOPGAP_CONF)?.trim() === STOPGAP_TEXT) put(STOPGAP_CONF, null);
	const timers = rt.enableTimers(APT_TIMERS);

	// 4. Read back.
	const cfg = aptConfigValues(rt.aptConfig());
	const wrong: string[] = [];
	const patterns = cfg.list('Unattended-Upgrade::Origins-Pattern');
	for (const p of securityPatterns(base.codename).slice(0, 1))
		if (!patterns.includes(p)) wrong.push(`apt does not list ${p}`);
	const expect = (key: string, value: string): void => {
		const got = cfg.scalar(key);
		if (got !== value)
			wrong.push(`${key} is ${got === null ? 'not set' : `"${got}"`}, not "${value}"`);
	};
	expect('APT::Periodic::Update-Package-Lists', '1');
	expect('APT::Periodic::Unattended-Upgrade', '1');
	expect('Unattended-Upgrade::Automatic-Reboot', settings.autoRestart ? 'true' : 'false');
	if (settings.autoRestart) {
		expect('Unattended-Upgrade::Automatic-Reboot-Time', settings.restartTime);
		expect('Unattended-Upgrade::Automatic-Reboot-WithUsers', 'false');
	}
	const options = cfg.list('DPkg::Options');
	for (const o of KEEP_LOCAL_CONFIG)
		if (!options.includes(o)) wrong.push(`apt does not pass ${o} to dpkg`);
	if (hook !== null && !cfg.list('DPkg::Post-Invoke').includes(hook))
		wrong.push(`apt does not run ${NODE_RESTART_SCRIPT} after a package change`);
	const dockerHeld: string[] = [];
	if (pin !== null) {
		if (!patterns.includes(repoPattern(docker!)))
			wrong.push(`apt does not list ${repoPattern(docker!)}`);
		for (const p of ['docker-ce', 'containerd.io']) {
			const inst = installedDocker[p];
			if (!inst) continue;
			const cand = rt.candidate(p);
			if (cand !== null && MAJOR_OF(cand) !== MAJOR_OF(inst))
				dockerHeld.push(`${p} would move to ${cand}`);
		}
	}
	if (tor !== null && !patterns.includes(repoPattern(tor)))
		wrong.push(`apt does not list ${repoPattern(tor)}`);
	const nodeHeld: string[] = [];
	if (nodePin !== null) {
		if (!patterns.includes(repoPattern(node!)))
			wrong.push(`apt does not list ${repoPattern(node!)}`);
		for (const p of NODE_PACKAGES) {
			const inst = installedNode[p];
			if (!inst) continue;
			const cand = rt.candidate(p);
			if (cand !== null && MAJOR_OF(cand) !== MAJOR_OF(inst))
				nodeHeld.push(`${p} would move to ${cand}`);
		}
	}
	const noSecuritySource = !releases.some(
		(r) => r.o === 'Ubuntu' && r.a === `${base.codename}-security`
	);
	const timersOff = APT_TIMERS.filter((t) => timers[t] !== true);

	const problemsFound = [
		...failed.map((p) => `${p} could not be written`),
		...wrong.map((w) => `${w} (another file in /etc/apt/apt.conf.d may set it after Morphit's)`),
		...dockerHeld.map((d) => `${d}, past the pin in ${DOCKER_PIN}`),
		...nodeHeld.map((d) => `${d}, past the pin in ${NODE_PIN}`),
		...(noSecuritySource
			? [
					`apt knows no Ubuntu security source for ${base.codename} (o=Ubuntu, a=${base.codename}-security) yet: check /etc/apt/sources.list.d`
				]
			: []),
		...timersOff.map((t) => `${t} is not enabled and active`)
	];
	if (problemsFound.length > 0)
		return {
			strategy: 'partial',
			verified: false,
			detail: `Automatic updates are not fully in place on this server: ${problemsFound.join('; ')}. On this server, after fixing it: sudo morphit-ops upgrade --heals${said}`
		};

	const vendors = [
		...(pin !== null ? [`Docker's own updates within ${dockerMajors(installedDocker)}`] : []),
		...(nodePin !== null
			? [
					`Node.js's updates within ${nodeMajor(installedNode)}${hook !== null ? ' (the Morphit services then restart onto the new Node)' : ''}`
				]
			: []),
		...(tor !== null ? ["Tor's own updates from the Tor Project"] : [])
	];
	const what =
		vendors.length > 0
			? `Ubuntu's security fixes install by themselves every day, and so do ${vendors.join(', and ')}`
			: "Ubuntu's security fixes install by themselves every day";
	const restart = settings.autoRestart
		? `; when one needs a restart, the server restarts by itself at ${settings.restartTime} (its own clock), unless someone is logged in when the day's updates finish (then it waits for a day's run that finds nobody)`
		: `; it does not restart by itself (MORPHIT_AUTO_RESTART=off), so a new kernel waits for you`;
	const mint = base.derivative
		? ` On ${base.name}, Ubuntu's security fixes are named by their real origin; the system's own setting named none of them.`
		: '';
	return {
		strategy: changed.length > 0 ? 'applied' : 'already',
		verified: true,
		routine: changed.length === 0 && !created && !added && problems.length === 0,
		detail: `Automatic updates: ${what}${restart} (read back from apt).${mint} To change it: ${UPDATES_ENV}.${said}`
	};
}

// ── the real server ───────────────────────────────────────────────────────

function run(cmd: string, args: readonly string[], timeout = 60_000): { ok: boolean; out: string } {
	try {
		const r = spawnSync(cmd, [...args], {
			encoding: 'utf8',
			timeout,
			maxBuffer: 32 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, LC_ALL: 'C' }
		});
		return { ok: r.status === 0, out: `${r.stdout ?? ''}` };
	} catch {
		return { ok: false, out: '' };
	}
}

function readRegular(path: string): string | null {
	try {
		const st = lstatSync(path);
		return st.isFile() ? readFileSync(path, 'utf8') : null;
	} catch {
		return null;
	}
}

export function realAutoUpdatesRuntime(deps: {
	readonly hiddenOnly: () => boolean;
	/** The Morphit install (default /opt/morphit). */
	readonly installDir?: string;
}): AutoUpdatesRuntime {
	return {
		hasApt: () => existsSync('/usr/bin/apt-get') && existsSync('/usr/bin/apt-config'),
		osRelease: () => readRegular('/etc/os-release') ?? readRegular('/usr/lib/os-release'),
		readFile: readRegular,
		writeFile: (path, data, mode) => {
			const tmp = join(dirname(path), `.${randomBytes(4).toString('hex')}.morphit.tmp`);
			try {
				try {
					const st = lstatSync(path);
					if (!st.isFile()) return false;
				} catch {
					/* new file */
				}
				writeFileSync(tmp, data, { mode, flag: 'wx' });
				renameSync(tmp, path);
				return readRegular(path) === data;
			} catch {
				rmSync(tmp, { force: true });
				return false;
			}
		},
		removeFile: (path) => {
			try {
				if (!lstatSync(path).isFile()) return false;
				rmSync(path);
				return true;
			} catch {
				return false;
			}
		},
		isInstalled: (pkg) =>
			/^install ok installed$/.test(run('dpkg-query', ['-W', '-f=${Status}', pkg]).out.trim()),
		installPackages: async (pkgs) =>
			(
				await runAsync(
					'apt-get',
					['-o', 'DPkg::Lock::Timeout=300', 'install', '-y', '-q', ...pkgs],
					{
						timeoutMs: 15 * 60_000,
						env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
					}
				)
			).status === 0,
		aptPolicy: () => run('apt-cache', ['policy']).out,
		candidate: (pkg) => {
			const m = /^\s+Candidate: (\S+)/m.exec(run('apt-cache', ['policy', pkg]).out);
			return m && m[1] !== '(none)' ? m[1]! : null;
		},
		installedVersions: (pkgs) => {
			const out: Record<string, string> = {};
			for (const p of pkgs) {
				const r = run('dpkg-query', ['-W', '-f=${Status}\t${Version}', p]);
				const [status, version] = r.out.split('\t');
				if (status === 'install ok installed' && version) out[p] = version.trim();
			}
			return out;
		},
		aptConfig: () => run('apt-config', ['dump']).out,
		enableTimers: (units) => {
			const out: Record<string, boolean> = {};
			for (const u of units) {
				run('systemctl', ['enable', '--now', u]);
				out[u] =
					run('systemctl', ['is-enabled', u]).out.trim() === 'enabled' &&
					run('systemctl', ['is-active', u]).out.trim() === 'active';
			}
			return out;
		},
		hiddenOnly: deps.hiddenOnly,
		nodeRestartScript: () => {
			const p = join(deps.installDir ?? '/opt/morphit', NODE_RESTART_SCRIPT);
			try {
				const st = lstatSync(p);
				// apt runs it as root: only a root-owned file nobody else can write.
				return st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0 && (st.mode & 0o111) !== 0
					? p
					: null;
			} catch {
				return null;
			}
		}
	};
}
