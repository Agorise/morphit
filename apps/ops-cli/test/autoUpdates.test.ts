/**
 * lib/autoUpdates.ts (v1.24.7): the server keeps itself patched — Ubuntu's
 * security fixes (named by their real origin, so Linux Mint matches too),
 * Docker's own updates within the installed major version, and a restart at
 * night when one needs it — read back from apt.
 *
 * The fixtures are what the servers printed on 2026-11-19
 * (security-updates-check.sh) and what apt reports for Docker's repository.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	APT_CONF,
	DEFAULT_UPDATE_SETTINGS,
	DOCKER_PIN,
	STOPGAP_CONF,
	STOPGAP_TEXT,
	UPDATES_ENV,
	UPDATES_ENV_DEFAULT_TEXT,
	aptConfText,
	aptConfigValues,
	dockerPattern,
	dockerPinText,
	dockerRelease,
	healAutomaticUpdates,
	majorPin,
	parsePolicyReleases,
	parseUpdateSettings,
	ubuntuBase,
	type AutoUpdatesRuntime
} from '../src/lib/autoUpdates.ts';

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=noble\n`;
const MINT = `NAME="Linux Mint"\nVERSION="22.3 (Zena)"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 22.3"\nVERSION_ID="22.3"\nVERSION_CODENAME=zena\nUBUNTU_CODENAME=noble\n`;
const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_CODENAME=bookworm\n`;

/** `apt-cache policy` on morphit.io: Hetzner's mirror, Docker's repository. */
const POLICY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages
     release o=Docker,a=noble,n=noble,l=Docker CE,c=stable,b=amd64
     origin download.docker.com
 500 https://mirror.hetzner.com/ubuntu/security noble-security/main amd64 Packages
     release v=24.04,o=Ubuntu,a=noble-security,n=noble,l=Ubuntu,c=main,b=amd64
     origin mirror.hetzner.com
 500 https://mirror.hetzner.com/ubuntu/packages noble-updates/main amd64 Packages
     release v=24.04,o=Ubuntu,a=noble-updates,n=noble,l=Ubuntu,c=main,b=amd64
     origin mirror.hetzner.com
Pinned packages:
`;
/** morphitlat: apt through Tor, no Docker repository. */
const POLICY_TOR = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 tor+http://archive.ubuntu.com/ubuntu noble-security/main amd64 Packages
     release v=24.04,o=Ubuntu,a=noble-security,n=noble,l=Ubuntu,c=main,b=amd64
     origin archive.ubuntu.com
 500 tor+http://packages.linuxmint.com zena/main amd64 Packages
     release v=22.3,o=linuxmint,a=zena,n=zena,l=linuxmint,c=main,b=amd64
     origin packages.linuxmint.com
`;
const DOCKER_INSTALLED = {
	'docker-ce': '5:29.8.0-1~ubuntu.24.04~noble',
	'docker-ce-cli': '5:29.8.0-1~ubuntu.24.04~noble',
	'containerd.io': '2.3.5-1~ubuntu.24.04~noble',
	'docker-compose-plugin': '2.40.3-1~ubuntu.24.04~noble'
};

describe('the settings file', () => {
	it("defaults are the owner's choices: security fixes, a restart at 04:30, Docker within its major, security releases", () => {
		expect(DEFAULT_UPDATE_SETTINGS).toEqual({
			securityUpdates: true,
			autoRestart: true,
			restartTime: '04:30',
			dockerUpdates: true,
			installReleases: 'security'
		});
		expect(parseUpdateSettings(null)).toEqual({ settings: DEFAULT_UPDATE_SETTINGS, problems: [] });
		expect(parseUpdateSettings(UPDATES_ENV_DEFAULT_TEXT)).toEqual({
			settings: DEFAULT_UPDATE_SETTINGS,
			problems: []
		});
	});
	it('reads on/off in any spelling, a time, the release choice; quotes and spaces are fine', () => {
		const { settings, problems } = parseUpdateSettings(
			'MORPHIT_SECURITY_UPDATES = "yes"\nMORPHIT_AUTO_RESTART=OFF\nMORPHIT_AUTO_RESTART_TIME=3:05\nMORPHIT_DOCKER_UPDATES=0\nMORPHIT_AUTO_INSTALL_RELEASES=All\n'
		);
		expect(problems).toEqual([]);
		expect(settings).toEqual({
			securityUpdates: true,
			autoRestart: false,
			restartTime: '03:05',
			dockerUpdates: false,
			installReleases: 'all'
		});
		expect(parseUpdateSettings('MORPHIT_AUTO_INSTALL_RELEASES=no').settings.installReleases).toBe(
			'off'
		);
	});
	it('a value it does not understand keeps the default and is said', () => {
		const { settings, problems } = parseUpdateSettings(
			'MORPHIT_AUTO_RESTART=maybe\nMORPHIT_AUTO_RESTART_TIME=25:00\nMORPHIT_AUTO_INSTALL_RELEASES=sometimes\n'
		);
		expect(settings).toEqual(DEFAULT_UPDATE_SETTINGS);
		expect(problems).toEqual([
			'MORPHIT_AUTO_RESTART=maybe is neither on nor off; on is used',
			'MORPHIT_AUTO_RESTART_TIME=25:00 is not a time of day (HH:MM); 04:30 is used',
			'MORPHIT_AUTO_INSTALL_RELEASES=sometimes is not security, all or off; security is used'
		]);
	});
});

describe('which system this is', () => {
	it('Ubuntu by its codename; Linux Mint by the Ubuntu release under it; Debian is not handled', () => {
		expect(ubuntuBase(UBUNTU)).toEqual({
			codename: 'noble',
			name: 'Ubuntu 24.04.4 LTS',
			derivative: false
		});
		expect(ubuntuBase(MINT)).toEqual({
			codename: 'noble',
			name: 'Linux Mint 22.3',
			derivative: true
		});
		expect(ubuntuBase(DEBIAN)).toBeNull();
		expect(ubuntuBase(null)).toBeNull();
		expect(ubuntuBase('ID=ubuntu\nVERSION_CODENAME=noble; rm -rf /\n')).toBeNull();
	});
});

describe("apt's own words", () => {
	it("reads every source's release fields (a label with a space) and its site", () => {
		const r = parsePolicyReleases(POLICY);
		expect(r).toContainEqual({
			o: 'Docker',
			a: 'noble',
			n: 'noble',
			l: 'Docker CE',
			c: 'stable',
			site: 'download.docker.com'
		});
		expect(r).toContainEqual({
			o: 'Ubuntu',
			a: 'noble-security',
			n: 'noble',
			l: 'Ubuntu',
			c: 'main',
			site: 'mirror.hetzner.com'
		});
		expect(dockerRelease(r)).toEqual({
			o: 'Docker',
			a: 'noble',
			n: 'noble',
			l: 'Docker CE',
			c: 'stable',
			site: 'download.docker.com'
		});
		expect(dockerRelease(parsePolicyReleases(POLICY_TOR))).toBeNull();
	});
	it("apt-config dump: a scalar's last value; every item of a list", () => {
		const v = aptConfigValues(
			'APT::Periodic::Unattended-Upgrade "1";\nUnattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Origins-Pattern "";\nUnattended-Upgrade::Origins-Pattern:: "origin=Ubuntu,archive=noble-security";\nUnattended-Upgrade::Origins-Pattern:: "origin=Docker,codename=noble,label=Docker CE,site=download.docker.com";\n'
		);
		expect(v.scalar('Unattended-Upgrade::Automatic-Reboot')).toBe('true');
		expect(v.list('Unattended-Upgrade::Origins-Pattern')).toEqual([
			'origin=Ubuntu,archive=noble-security',
			'origin=Docker,codename=noble,label=Docker CE,site=download.docker.com'
		]);
		expect(v.scalar('Nothing')).toBeNull();
	});
});

describe('what is written', () => {
	it("names Ubuntu's security pockets by origin (Mint matches), Docker as apt reports it, and the restart", () => {
		const t = aptConfText({
			codename: 'noble',
			docker: dockerRelease(parsePolicyReleases(POLICY)),
			restart: true,
			time: '04:30'
		});
		expect(t).toContain('\t"origin=Ubuntu,archive=noble-security";\n');
		expect(t).toContain('\t"origin=UbuntuESMApps,archive=noble-apps-security";\n');
		expect(t).toContain('\t"origin=UbuntuESM,archive=noble-infra-security";\n');
		expect(t).toContain(
			'\t"origin=Docker,codename=noble,label=Docker CE,site=download.docker.com";\n'
		);
		expect(t).toContain('Unattended-Upgrade::Automatic-Reboot "true";\n');
		expect(t).toContain('Unattended-Upgrade::Automatic-Reboot-WithUsers "false";\n');
		expect(t).toContain('Unattended-Upgrade::Automatic-Reboot-Time "04:30";\n');
		expect(t).toContain('APT::Periodic::Unattended-Upgrade "1";\n');
		expect(t).not.toMatch(/distro_id/);
		const off = aptConfText({ codename: 'noble', docker: null, restart: false, time: '04:30' });
		expect(off).toContain('Unattended-Upgrade::Automatic-Reboot "false";\n');
		expect(off).not.toMatch(/Docker/);
	});
	it("only Docker's own site is Docker's repository; the pattern names that site, so a source elsewhere calling itself Docker is never updated from", () => {
		const elsewhere = POLICY.replace(
			'     origin download.docker.com',
			'     origin docker.mirror.example'
		);
		expect(dockerRelease(parsePolicyReleases(elsewhere))).toBeNull();
		expect(dockerPattern(dockerRelease(parsePolicyReleases(POLICY))!)).toBe(
			'origin=Docker,codename=noble,label=Docker CE,site=download.docker.com'
		);
	});
	it('a comma in a value is escaped, as unattended-upgrades reads patterns', () => {
		expect(dockerPattern({ o: 'Do,cker', a: '', n: 'noble', l: 'x', c: '', site: '' })).toBe(
			'origin=Do\\,cker,codename=noble,label=x'
		);
	});
	it('each Docker package stays on its installed major; "any version: never" comes last (apt takes the first match)', () => {
		expect(majorPin('5:29.8.0-1~ubuntu.24.04~noble')).toBe('5:29.*');
		expect(majorPin('2.3.5-1~ubuntu.24.04~noble')).toBe('2.*');
		expect(majorPin('~beta')).toBeNull();
		const pin = dockerPinText(DOCKER_INSTALLED)!;
		const recs = pin.split('\n\n').filter((r) => r.startsWith('Package:'));
		expect(recs).toEqual([
			'Package: docker-ce docker-ce-cli\nPin: version 5:29.*\nPin-Priority: 500',
			'Package: containerd.io docker-compose-plugin\nPin: version 2.*\nPin-Priority: 500',
			'Package: docker-ce docker-ce-cli containerd.io docker-compose-plugin\nPin: version *\nPin-Priority: -1\n'
		]);
		expect(dockerPinText({})).toBeNull();
	});
});

// ─── the heal, on a stand-in server ───────────────────────────────────────
class Box implements AutoUpdatesRuntime {
	files = new Map<string, string>();
	installed = new Set(['unattended-upgrades']);
	os: string | null = UBUNTU;
	policy = POLICY;
	docker: Record<string, string> = { ...DOCKER_INSTALLED };
	/** Candidate per package; by default the pin holds (a newer 29.x). */
	cands: Record<string, string> = {
		'docker-ce': '5:29.9.2-1~ubuntu.24.04~noble',
		'containerd.io': '2.4.2-2~ubuntu.24.04~noble'
	};
	hidden = false;
	installOk = true;
	installs: string[][] = [];
	timersOk = true;
	/** A file after Morphit's that sets a value (merged into the dump). */
	later = '';
	writeOk = true;
	apt = true;
	hasApt = () => this.apt;
	osRelease = () => this.os;
	readFile = (p: string) => this.files.get(p) ?? null;
	writeFile = (p: string, d: string) => (this.writeOk ? (this.files.set(p, d), true) : false);
	removeFile = (p: string) => this.files.delete(p);
	isInstalled = (p: string) => this.installed.has(p);
	installPackages = async (p: readonly string[]) => {
		this.installs.push([...p]);
		if (this.installOk) for (const x of p) this.installed.add(x);
		return this.installOk;
	};
	aptPolicy = () => this.policy;
	candidate = (p: string) => this.cands[p] ?? null;
	installedVersions = (ps: readonly string[]) =>
		Object.fromEntries(ps.filter((p) => this.docker[p]).map((p) => [p, this.docker[p]!]));
	/** apt-config dump as apt would merge Morphit's file. */
	aptConfig = () => {
		const conf = this.files.get(APT_CONF) ?? '';
		const lines: string[] = [];
		let inList = false;
		for (const l of conf.split('\n')) {
			if (/^Unattended-Upgrade::Origins-Pattern \{/.test(l)) {
				inList = true;
				continue;
			}
			if (inList) {
				if (l === '};') inList = false;
				else lines.push(`Unattended-Upgrade::Origins-Pattern:: ${l.trim()}`);
				continue;
			}
			if (/^\S+ ".*";$/.test(l)) lines.push(l);
		}
		return [...lines, this.later].join('\n');
	};
	enableTimers = (u: readonly string[]) => Object.fromEntries(u.map((x) => [x, this.timersOk]));
	hiddenOnly = () => this.hidden;
}
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };

describe('healAutomaticUpdates', () => {
	it('a server without the settings file: written with the defaults; apt set up; Docker pinned; said once, read back', async () => {
		const b = new Box();
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.files.get(UPDATES_ENV)).toBe(UPDATES_ENV_DEFAULT_TEXT);
		expect(b.files.get(APT_CONF)).toBe(
			aptConfText({
				codename: 'noble',
				docker: dockerRelease(parsePolicyReleases(POLICY)),
				restart: true,
				time: '04:30'
			})
		);
		expect(b.files.get(DOCKER_PIN)).toBe(dockerPinText(DOCKER_INSTALLED));
		expect(r).toMatchObject({ strategy: 'applied', verified: true, routine: false });
		expect(r.detail).toBe(
			"Automatic updates: Ubuntu's security fixes install by themselves every day, and so do Docker's own updates within Docker 29.x and containerd 2.x; when one needs a restart, the server restarts by itself at 04:30 (its own clock), unless someone is logged in when the day's updates finish (then it waits for a day's run that finds nobody) (read back from apt). To change it: /etc/morphit/updates.env."
		);
	});
	it('the stopgap file of 2026-11-19 (morphitlat) is removed once this one is in place; a file of that name with anything else stays', async () => {
		const b = new Box();
		b.os = MINT;
		b.policy = POLICY_TOR;
		b.files.set(STOPGAP_CONF, `${STOPGAP_TEXT}\n`);
		expect((await healAutomaticUpdates(ctx, b)).verified).toBe(true);
		expect(b.files.has(STOPGAP_CONF)).toBe(false);
		const own = new Box();
		own.files.set(STOPGAP_CONF, `${STOPGAP_TEXT}\nUnattended-Upgrade::Mail "me@example.org";\n`);
		await healAutomaticUpdates(ctx, own);
		expect(own.files.has(STOPGAP_CONF)).toBe(true);
	});
	it('the next upgrade finds it all in place: nothing written, counted quietly', async () => {
		const b = new Box();
		await healAutomaticUpdates(ctx, b);
		const before = new Map(b.files);
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.files).toEqual(before);
		expect(r).toMatchObject({ strategy: 'already', verified: true, routine: true });
	});
	it("morphitlat's case: Linux Mint gets Ubuntu's pockets by name and says why; no Docker repository there, so no pin", async () => {
		const b = new Box();
		b.os = MINT;
		b.policy = POLICY_TOR;
		b.hidden = true;
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.files.get(APT_CONF)).toContain('"origin=Ubuntu,archive=noble-security";');
		expect(b.files.has(DOCKER_PIN)).toBe(false);
		expect(r.verified).toBe(true);
		expect(r.detail).toMatch(
			/^Automatic updates: Ubuntu's security fixes install by themselves every day;/
		);
		expect(r.detail).toContain(
			"On Linux Mint 22.3, Ubuntu's security fixes are named by their real origin; the system's own setting named none of them."
		);
	});
	it('settings off: Morphit removes its own files, installs nothing; a later run with nothing to remove is quiet', async () => {
		const b = new Box();
		await healAutomaticUpdates(ctx, b);
		b.files.set(UPDATES_ENV, 'MORPHIT_SECURITY_UPDATES=off\n');
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.files.has(APT_CONF)).toBe(false);
		expect(b.files.has(DOCKER_PIN)).toBe(false);
		expect(r).toMatchObject({ strategy: 'off', verified: true, routine: false });
		expect(r.detail).toContain('MORPHIT_SECURITY_UPDATES=off');
		expect((await healAutomaticUpdates(ctx, b)).routine).toBe(true);
	});
	it('Docker updates off: no Docker pattern, no pin (an earlier pin removed); restart off: said plainly', async () => {
		const b = new Box();
		await healAutomaticUpdates(ctx, b);
		b.files.set(UPDATES_ENV, 'MORPHIT_DOCKER_UPDATES=off\nMORPHIT_AUTO_RESTART=off\n');
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.files.get(APT_CONF)).not.toMatch(/Docker/);
		expect(b.files.get(APT_CONF)).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
		expect(b.files.has(DOCKER_PIN)).toBe(false);
		expect(r.verified).toBe(true);
		expect(r.detail).toContain(
			'it does not restart by itself (MORPHIT_AUTO_RESTART=off), so a new kernel waits for you'
		);
	});
	it("another file after Morphit's turning the restart off is found and said, never claimed done", async () => {
		const b = new Box();
		b.later = 'Unattended-Upgrade::Automatic-Reboot "false";';
		const r = await healAutomaticUpdates(ctx, b);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain('Unattended-Upgrade::Automatic-Reboot is "false", not "true"');
	});
	it('a Docker candidate past its major (the pin not in force) is said', async () => {
		const b = new Box();
		b.cands['docker-ce'] = '5:30.0.0-1~ubuntu.24.04~noble';
		const r = await healAutomaticUpdates(ctx, b);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain(
			'docker-ce would move to 5:30.0.0-1~ubuntu.24.04~noble, past the pin'
		);
	});
	it('no Ubuntu security source in apt, or timers that will not run: said, with what to do', async () => {
		const b = new Box();
		b.policy = POLICY.replace(
			/release v=24\.04,o=Ubuntu,a=noble-security/,
			'release v=24.04,o=Ubuntu,a=noble-updates'
		);
		b.timersOk = false;
		const r = await healAutomaticUpdates(ctx, b);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain('apt knows no Ubuntu security source for noble');
		expect(r.detail).toContain('apt-daily-upgrade.timer is not enabled and active');
		expect(r.detail).toContain('sudo morphit-ops upgrade --heals');
	});
	it('unattended-upgrades missing: installed (behind a spinner); a failed install is a warning with the command', async () => {
		const b = new Box();
		b.installed.clear();
		expect((await healAutomaticUpdates(ctx, b)).verified).toBe(true);
		expect(b.installs).toEqual([['unattended-upgrades']]);
		const f = new Box();
		f.installed.clear();
		f.installOk = false;
		const r = await healAutomaticUpdates(ctx, f);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain('sudo apt-get install -y unattended-upgrades');
	});
	it('a zero-clearnet server whose apt does not go through Tor fetches nothing', async () => {
		const b = new Box();
		b.installed.clear();
		b.hidden = true;
		b.policy = POLICY.replace(/https:\/\//g, 'http://');
		const r = await healAutomaticUpdates(ctx, b);
		expect(b.installs).toEqual([]);
		expect(r.strategy).toBe('waiting');
		const t = new Box();
		t.installed.clear();
		t.hidden = true;
		t.policy = POLICY_TOR;
		t.os = MINT;
		await healAutomaticUpdates(ctx, t);
		expect(t.installs).toEqual([['unattended-upgrades']]);
	});
	it('not Ubuntu-based, or no apt: left as it is', async () => {
		const d = new Box();
		d.os = DEBIAN;
		expect((await healAutomaticUpdates(ctx, d)).strategy).toBe('not-ubuntu');
		expect(d.files.has(APT_CONF)).toBe(false);
		const n = new Box();
		n.apt = false;
		expect(await healAutomaticUpdates(ctx, n)).toMatchObject({
			strategy: 'not-apt',
			routine: true
		});
	});
	it('a setting it does not understand is said in the result', async () => {
		const b = new Box();
		b.files.set(UPDATES_ENV, 'MORPHIT_AUTO_RESTART_TIME=noon\n');
		const r = await healAutomaticUpdates(ctx, b);
		expect(r.routine).toBe(false);
		expect(r.detail).toContain(
			'In /etc/morphit/updates.env: MORPHIT_AUTO_RESTART_TIME=noon is not a time of day (HH:MM); 04:30 is used.'
		);
	});
	it('a file that cannot be written is said, never claimed done', async () => {
		const b = new Box();
		b.files.set(UPDATES_ENV, UPDATES_ENV_DEFAULT_TEXT);
		b.writeOk = false;
		const r = await healAutomaticUpdates(ctx, b);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain(`${APT_CONF} could not be written`);
	});
});

// With apt and unattended-upgrades here (MORPHIT_TEST_APT=1): what Morphit
// writes is read by the real apt, and the real unattended-upgrades picks Docker
// 29.9.2 — not 30.0.0 — from a stand-in Docker repository.
describe.runIf(process.env.MORPHIT_TEST_APT === '1')('the real apt and unattended-upgrades', () => {
	it('apt reads the settings; the pin holds Docker on 29.x; unattended-upgrades takes 29.9.2 and containerd 2.4.2', () => {
		const F = mkdtempSync(join(tmpdir(), 'morphit-apt-'));
		try {
			for (const d of [
				'repo/pool',
				'repo/dists/noble/stable/binary-amd64',
				'lists/partial',
				'cache/archives/partial',
				'prefs.d',
				'conf.d',
				'state/updates',
				'state/info',
				'build'
			])
				mkdirSync(join(F, d), { recursive: true });
			const pkg = (n: string, v: string) => {
				const d = join(F, 'build', `${n}-${v}`.replace(/[:~]/g, '_'), 'DEBIAN');
				mkdirSync(d, { recursive: true });
				writeFileSync(
					join(d, 'control'),
					`Package: ${n}\nVersion: ${v}\nArchitecture: amd64\nMaintainer: t <t@t>\nDescription: stand-in\n`
				);
				execFileSync(
					'dpkg-deb',
					['-b', join(d, '..'), join(F, 'repo/pool', `${n}_${v.replace(':', '%3a')}_amd64.deb`)],
					{ stdio: 'ignore' }
				);
			};
			for (const v of [
				'5:29.8.0-1~ubuntu.24.04~noble',
				'5:29.9.2-1~ubuntu.24.04~noble',
				'5:30.0.0-1~ubuntu.24.04~noble'
			])
				pkg('docker-ce', v);
			for (const v of [
				'2.3.5-1~ubuntu.24.04~noble',
				'2.4.2-2~ubuntu.24.04~noble',
				'3.0.0-1~ubuntu.24.04~noble'
			])
				pkg('containerd.io', v);
			writeFileSync(
				join(F, 'repo/dists/noble/stable/binary-amd64/Packages'),
				execFileSync('apt-ftparchive', ['packages', 'pool'], { cwd: join(F, 'repo') })
			);
			writeFileSync(
				join(F, 'repo/dists/noble/Release'),
				execFileSync(
					'apt-ftparchive',
					[
						'-o',
						'APT::FTPArchive::Release::Origin=Docker',
						'-o',
						'APT::FTPArchive::Release::Label=Docker CE',
						'-o',
						'APT::FTPArchive::Release::Suite=noble',
						'-o',
						'APT::FTPArchive::Release::Codename=noble',
						'-o',
						'APT::FTPArchive::Release::Components=stable',
						'-o',
						'APT::FTPArchive::Release::Architectures=amd64',
						'release',
						'dists/noble'
					],
					{ cwd: join(F, 'repo') }
				)
			);
			const installed = {
				'docker-ce': '5:29.8.0-1~ubuntu.24.04~noble',
				'containerd.io': '2.3.5-1~ubuntu.24.04~noble'
			};
			writeFileSync(
				join(F, 'state/status'),
				Object.entries(installed)
					.map(
						([p, v]) =>
							`Package: ${p}\nStatus: install ok installed\nPriority: optional\nArchitecture: amd64\nVersion: ${v}\nMaintainer: t <t@t>\nDescription: stand-in\n`
					)
					.join('\n')
			);
			writeFileSync(join(F, 'state/available'), '');
			// Served over HTTP, so apt reports a site for it, as for Docker's own.
			const port = 18_000 + Math.floor(Math.random() * 2_000);
			const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
				cwd: join(F, 'repo'),
				stdio: 'ignore'
			});
			try {
				writeFileSync(
					join(F, 'sources.list'),
					`deb [trusted=yes] http://127.0.0.1:${port} noble stable\n`
				);
				writeFileSync(join(F, 'conf.d/00direct'), 'Acquire::http::Proxy "DIRECT";\n');
				writeFileSync(
					join(F, 'apt.conf'),
					[
						`Dir::State::status "${F}/state/status";`,
						`Dir::State::Lists "${F}/lists";`,
						`Dir::Cache "${F}/cache";`,
						`Dir::Etc::SourceList "${F}/sources.list";`,
						'Dir::Etc::SourceParts "/nonexistent";',
						'Dir::Etc::Preferences "/nonexistent";',
						`Dir::Etc::PreferencesParts "${F}/prefs.d";`,
						`Dir::Etc::Parts "${F}/conf.d";`,
						'APT::Architecture "amd64";',
						''
					].join('\n')
				);
				const env = Object.fromEntries(
					Object.entries({ ...process.env, APT_CONFIG: join(F, 'apt.conf'), LC_ALL: 'C' }).filter(
						([k]) => !/^(https?|all)_proxy$/i.test(k)
					)
				);
				let up = false;
				for (let i = 0; i < 40 && !up; i++) {
					try {
						execFileSync('apt-get', ['update', '-q'], { env, stdio: 'ignore' });
						up = /127\.0\.0\.1/.test(
							execFileSync('apt-cache', ['policy'], { env, encoding: 'utf8' })
						);
					} catch {
						execFileSync('sleep', ['0.25']);
					}
				}
				expect(up).toBe(true);
				// What apt reports for this source, site included (here 127.0.0.1).
				const reported = parsePolicyReleases(
					execFileSync('apt-cache', ['policy'], { env, encoding: 'utf8' })
				).find((r) => r.o === 'Docker')!;
				expect(reported.site).toBe('127.0.0.1');
				const py = ['/usr/bin/python3.12', '/usr/bin/python3'].find((p) => existsSync(p))!;
				const dryRun = (): string => {
					try {
						return execFileSync(py, ['/usr/bin/unattended-upgrade', '--dry-run', '-d'], {
							env,
							encoding: 'utf8',
							stdio: ['ignore', 'pipe', 'pipe']
						});
					} catch (e) {
						return String((e as { stdout?: string }).stdout ?? '');
					}
				};
				writeFileSync(join(F, 'prefs.d/morphit-docker-major'), dockerPinText(installed)!);
				writeFileSync(
					join(F, 'conf.d/52morphit-automatic-updates'),
					aptConfText({ codename: 'noble', docker: reported, restart: true, time: '04:30' })
				);
				const v = aptConfigValues(execFileSync('apt-config', ['dump'], { env, encoding: 'utf8' }));
				expect(v.list('Unattended-Upgrade::Origins-Pattern')).toContain(
					'origin=Docker,codename=noble,label=Docker CE,site=127.0.0.1'
				);
				expect(v.scalar('Unattended-Upgrade::Automatic-Reboot-Time')).toBe('04:30');
				expect(
					execFileSync('apt-cache', ['policy', 'docker-ce'], { env, encoding: 'utf8' })
				).toMatch(/Candidate: 5:29\.9\.2/);
				const dry = dryRun();
				expect(dry).toMatch(/containerd\.io amd64 2\.4\.2-2/);
				expect(dry).toMatch(/docker-ce amd64 5:29\.9\.2/);
				expect(dry).not.toMatch(/30\.0\.0|3\.0\.0-1/);
				// The same packages from a site that is not the one named: nothing.
				writeFileSync(
					join(F, 'conf.d/52morphit-automatic-updates'),
					aptConfText({
						codename: 'noble',
						docker: { ...reported, site: 'download.docker.com' },
						restart: true,
						time: '04:30'
					})
				);
				expect(dryRun()).toMatch(/No packages found that can be upgraded unattended/);
			} finally {
				server.kill();
			}
		} finally {
			rmSync(F, { recursive: true, force: true });
		}
	});
});
