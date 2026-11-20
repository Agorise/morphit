/**
 * lib/torProjectRepoHeal.ts (v1.24.8): Tor from the Tor Project's own
 * repository — found by its site, else its .onion through Tor; its key and
 * release file proven first; the installed Tor copied as the way back; put
 * back when anything is short; then the daily updates take Tor's.
 *
 * The fixtures are what the servers printed on 2026-11-20
 * (components-check.sh): `apt-cache policy tor` on morphit.io, the Tor
 * Project's Release fields for noble.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATES_ENV } from '../src/lib/autoUpdates.ts';
import {
	TOR_ROLLBACK_DIR,
	TP_FINGERPRINT,
	TP_KEYRING,
	TP_ONION,
	TP_ONION_BASE,
	TP_ONION_PROXY,
	TP_SITE_BASE,
	TP_SOURCE,
	healTorProjectRepo,
	policyVersions,
	realTorRepoRuntime,
	releaseField,
	tpOnionProxyText,
	tpSourceText,
	type TorRepoRuntime
} from '../src/lib/torProjectRepoHeal.ts';

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.4 LTS"\nID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n`;
const MINT = `NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 22.3"\nVERSION_CODENAME=zena\nUBUNTU_CODENAME=noble\n`;
const UBU_TOR = '0.4.9.11-0ubuntu0.24.04.1';
const TP_TOR = '0.4.9.17-1~noble+1';
const UBU_SITE = 'https://mirror.hetzner.com/ubuntu/packages';
/** The Tor Project's InRelease for noble, as the servers read it (signature
 *  aside). */
const IN_RELEASE = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: TorProject
Suite: noble
Codename: noble
Date: Fri, 20 Nov 2026 11:28:01 UTC
Architectures: amd64 arm64
Components: main
SHA256:
-----BEGIN PGP SIGNATURE-----
-----END PGP SIGNATURE-----
`;
const KEY = Buffer.from(
	'-----BEGIN PGP PUBLIC KEY BLOCK-----\ntp\n-----END PGP PUBLIC KEY BLOCK-----\n'
);
const KEYRING = Buffer.from([0x99, 0x01, 0x0d, 0x04, 0xff, 0x80]);

/** A stand-in server: apt's view is rebuilt from its state. */
class Box implements TorRepoRuntime {
	files = new Map<string, string>();
	os = UBUNTU;
	archName = 'amd64';
	hidden = false;
	torTransport = false;
	pkgs: Record<string, string> = { tor: UBU_TOR, 'tor-geoipdb': UBU_TOR };
	/** Which way reaches the Tor Project: per route, what it serves. */
	serve: Record<'site' | 'onion', { key: Buffer; inRelease: Buffer } | null> = {
		site: { key: KEY, inRelease: Buffer.from(IN_RELEASE) },
		onion: { key: KEY, inRelease: Buffer.from(IN_RELEASE) }
	};
	keyFprs = [TP_FINGERPRINT];
	signedOk = true;
	readOk = true;
	downloadOk = true;
	downloadPartial = false;
	installNoChange = false;
	staleLists = false;
	candidateUbuntu = false;
	installOk = true;
	/** torWorks answers, in order (the last repeats). */
	works: boolean[] = [true];
	events: string[] = [];
	fetched: Array<{ url: string; viaTor: boolean }> = [];
	installs: string[][] = [];
	readFile = (p: string) => this.files.get(p) ?? null;
	writeFile = (p: string, d: string | Buffer) => {
		this.events.push(`write ${p}`);
		this.files.set(p, typeof d === 'string' ? d : d.toString('latin1'));
		return true;
	};
	removeFile = (p: string) => {
		this.events.push(`remove ${p}`);
		this.files.delete(p);
		return true;
	};
	installedVersions = (ps: readonly string[]) =>
		Object.fromEntries(ps.filter((p) => this.pkgs[p]).map((p) => [p, this.pkgs[p]!]));
	arch = () => this.archName;
	osRelease = () => this.os;
	hiddenOnly = () => this.hidden;
	getUrl = async (url: string, viaTor: boolean) => {
		this.fetched.push({ url, viaTor });
		const route =
			url.startsWith(TP_SITE_BASE) && !viaTor
				? 'site'
				: url.startsWith(TP_ONION_BASE) && viaTor
					? 'onion'
					: null;
		const s = route ? this.serve[route] : null;
		if (s === null) return null;
		if (url.endsWith(`/${TP_FINGERPRINT}.asc`)) return s.key;
		if (url.endsWith('/dists/noble/InRelease')) return s.inRelease;
		return null;
	};
	fingerprints = () => this.keyFprs;
	dearmor = () => KEYRING;
	verifySigned = () => this.signedOk;
	hasTorTransport = () => this.torTransport;
	/** apt has read the Tor Project's lists (an update with its source). */
	listsRead = false;
	aptUpdateSource = async () => {
		this.events.push('apt-update');
		if ((this.readOk || this.staleLists) && this.files.has(TP_SOURCE)) this.listsRead = true;
		return this.readOk;
	};
	private tpUri = () => /URIs: (\S+)/.exec(this.files.get(TP_SOURCE) ?? '')?.[1] ?? null;
	private tpHost = () => (this.tpUri() ?? '').replace(/^[a-z+]+:\/\//, '').split('/')[0]!;
	aptPolicy = () =>
		`Package files:\n 100 /var/lib/dpkg/status\n     release a=now\n` +
		(this.listsRead && this.files.has(TP_SOURCE)
			? ` 500 ${this.tpUri()} noble/main amd64 Packages\n     release o=TorProject,a=noble,n=noble,c=main,b=amd64\n     origin ${this.tpHost()}\n`
			: '') +
		` 500 ${UBU_SITE} noble-updates/universe amd64 Packages\n     release v=24.04,o=Ubuntu,a=noble-updates,n=noble,l=Ubuntu,c=universe,b=amd64\n     origin mirror.hetzner.com\n`;
	pkgPolicy = (pkg: string) => {
		const tp = this.listsRead && this.files.has(TP_SOURCE);
		const inst = this.pkgs[pkg] ?? '(none)';
		const cand = tp && !this.candidateUbuntu ? TP_TOR : UBU_TOR;
		const row = (v: string, src: string) =>
			`${v === inst ? ' ***' : '    '} ${v} 500\n        500 ${src}\n${v === inst ? '        100 /var/lib/dpkg/status\n' : ''}`;
		return (
			`${pkg}:\n  Installed: ${inst}\n  Candidate: ${cand}\n  Version table:\n` +
			(tp ? row(TP_TOR, `${this.tpUri()} noble/main amd64 Packages`) : '') +
			row(UBU_TOR, `${UBU_SITE} noble-updates/universe amd64 Packages`)
		);
	};
	downloadPackages = async (ps: Readonly<Record<string, string>>, dir: string) => {
		this.events.push(
			`download ${Object.entries(ps)
				.map(([p, v]) => `${p}=${v}`)
				.join(' ')}`
		);
		if (!this.downloadOk) return null;
		const files = Object.keys(ps).map((p) => join(dir, `${p}.deb`));
		return this.downloadPartial ? files.slice(0, 1) : files;
	};
	install = async (ps: readonly string[]) => {
		this.events.push(`install ${ps.join(' ')}`);
		this.installs.push([...ps]);
		if (!this.installOk) return false;
		if (this.installNoChange) return true;
		for (const p of ps) this.pkgs[p] = p === 'deb.torproject.org-keyring' ? '2025.08.08' : TP_TOR;
		return true;
	};
	dpkgInstall = async (files: readonly string[]) => {
		this.events.push(`dpkg -i ${files.join(' ')}`);
		for (const f of files) {
			const p = /([^/]+)\.deb$/.exec(f)![1]!;
			this.pkgs[p] = UBU_TOR;
		}
		return true;
	};
	restartTor = async () => {
		this.events.push('restart tor');
	};
	torWorks = async () => {
		this.events.push('tor-works?');
		return this.works.length > 1 ? this.works.shift()! : this.works[0]!;
	};
}
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const auto = async () => ({ strategy: 'applied', verified: true, detail: 'auto' });

describe("apt's and the Tor Project's own words", () => {
	it("reads the installed and candidate versions and each version's sites", () => {
		const t = `tor:
  Installed: ${UBU_TOR}
  Candidate: ${TP_TOR}
  Version table:
     ${TP_TOR} 500
        500 tor+http://${TP_ONION}/torproject.org noble/main amd64 Packages
 *** ${UBU_TOR} 500
        500 ${UBU_SITE} noble-updates/universe amd64 Packages
        100 /var/lib/dpkg/status
     0.4.8.10-1build2 500
        500 ${UBU_SITE} noble/universe amd64 Packages
`;
		expect(policyVersions(t)).toEqual({
			installed: UBU_TOR,
			candidate: TP_TOR,
			sites: {
				[TP_TOR]: [TP_ONION],
				[UBU_TOR]: ['mirror.hetzner.com'],
				'0.4.8.10-1build2': ['mirror.hetzner.com']
			}
		});
		expect(policyVersions('x:\n  Installed: (none)\n  Candidate: (none)\n').installed).toBeNull();
	});
	it('release fields; the source and the onion proxy Morphit writes', () => {
		expect(releaseField(IN_RELEASE, 'Codename')).toBe('noble');
		expect(releaseField(IN_RELEASE, 'Architectures')).toBe('amd64 arm64');
		expect(releaseField(IN_RELEASE, 'Label')).toBe('');
		expect(tpSourceText(TP_SITE_BASE, 'noble')).toContain(
			`Types: deb\nURIs: https://deb.torproject.org/torproject.org\nSuites: noble\nComponents: main\nSigned-By: ${TP_KEYRING}\n`
		);
		expect(tpOnionProxyText('127.0.0.1:9050')).toContain(
			`Acquire::http::Proxy::${TP_ONION} "socks5h://apt-transport-tor@127.0.0.1:9050";`
		);
	});
});

describe('healTorProjectRepo', () => {
	it("morphit.io's case: the site checks out; the installed Tor copied first; key, source; Tor from the Tor Project, settings kept, it connects; then the daily updates", async () => {
		const b = new Box();
		let refreshed = 0;
		const r = await healTorProjectRepo(ctx, b, {
			refreshAutoUpdates: async () => {
				refreshed++;
				return auto();
			}
		});
		expect(r).toMatchObject({ strategy: 'switched', verified: true });
		expect(r.detail).toBe(
			`Tor now comes from the Tor Project's own repository: ${UBU_TOR} → ${TP_TOR}, your Tor settings kept, and it connects (a hidden Blurt node answered through it). Its updates install by themselves from now on.`
		);
		expect(b.fetched).toEqual([
			{ url: `${TP_SITE_BASE}/${TP_FINGERPRINT}.asc`, viaTor: false },
			{ url: `${TP_SITE_BASE}/dists/noble/InRelease`, viaTor: false }
		]);
		expect(b.events.slice(0, 4)).toEqual([
			`download tor=${UBU_TOR} tor-geoipdb=${UBU_TOR}`,
			`write ${TP_KEYRING}`,
			`write ${TP_SOURCE}`,
			'apt-update'
		]);
		expect(b.files.get(TP_SOURCE)).toBe(tpSourceText(TP_SITE_BASE, 'noble'));
		expect(b.files.get(TP_KEYRING)).toBe(KEYRING.toString('latin1'));
		expect(b.files.has(TP_ONION_PROXY)).toBe(false);
		expect(b.installs).toEqual([['tor', 'tor-geoipdb', 'deb.torproject.org-keyring']]);
		expect(refreshed).toBe(1);
		// The next upgrade: in place, said quietly.
		const again = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(again).toMatchObject({ strategy: 'already', routine: true });
	});
	it("morphitir's case: the site does not answer; its .onion through Tor does; apt reaches that onion only through Tor", async () => {
		const b = new Box();
		b.serve.site = null;
		const r = await healTorProjectRepo(ctx, b, {
			socks: '127.0.0.1:9050',
			refreshAutoUpdates: auto
		});
		expect(r.strategy).toBe('switched');
		expect(r.detail).toContain("the Tor Project's own repository (through its .onion)");
		expect(b.fetched.map((f) => f.viaTor)).toEqual([false, true, true]);
		expect(b.files.get(TP_SOURCE)).toBe(tpSourceText(TP_ONION_BASE, 'noble'));
		expect(b.files.get(TP_ONION_PROXY)).toBe(tpOnionProxyText('127.0.0.1:9050'));
	});
	it("morphitlat's case (zero-clearnet, Linux Mint): never the site; the onion over apt's Tor transport", async () => {
		const b = new Box();
		b.os = MINT;
		b.hidden = true;
		b.torTransport = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('switched');
		expect(b.fetched.every((f) => f.viaTor && f.url.startsWith(TP_ONION_BASE))).toBe(true);
		expect(b.files.get(TP_SOURCE)).toBe(tpSourceText(`tor+${TP_ONION_BASE}`, 'noble'));
		expect(b.files.has(TP_ONION_PROXY)).toBe(false);
	});
	it('a key that is not the published one, or a release file it did not sign, or no Tor for this release: nothing is written, said calmly', async () => {
		for (const spoil of [
			(b: Box) => (b.keyFprs = ['0000000000000000000000000000000000000000']),
			(b: Box) => (b.signedOk = false),
			(b: Box) => {
				b.serve.site = {
					key: KEY,
					inRelease: Buffer.from(IN_RELEASE.replace('Codename: noble', 'Codename: jammy'))
				};
				b.serve.onion = b.serve.site;
			},
			(b: Box) => {
				b.archName = 'arm64';
				b.serve.site = {
					key: KEY,
					inRelease: Buffer.from(IN_RELEASE.replace('amd64 arm64', 'amd64'))
				};
				b.serve.onion = b.serve.site;
			},
			(b: Box) => {
				b.serve.site = null;
				b.serve.onion = null;
			}
		]) {
			const b = new Box();
			spoil(b);
			const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
			expect(r).toMatchObject({ strategy: 'unreachable', verified: true });
			expect(r.detail).toMatch(/^Tor: the Tor Project's repository could not be used \(/);
			expect(r.detail).toContain(
				`Tor stays on ${UBU_TOR} from Ubuntu for now; the next upgrade tries again.`
			);
			expect(b.events).toEqual([]);
		}
	});
	it('no copy of the installed Tor: nothing changes', async () => {
		const b = new Box();
		b.downloadOk = false;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r).toMatchObject({ strategy: 'no-way-back', verified: true });
		expect(b.events).toEqual([`download tor=${UBU_TOR} tor-geoipdb=${UBU_TOR}`]);
		expect(b.files.size).toBe(0);
	});
	it("apt cannot read the repository: Morphit's files removed again, Tor untouched", async () => {
		const b = new Box();
		b.readOk = false;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r).toMatchObject({ strategy: 'put-back', verified: false });
		expect(b.files.has(TP_SOURCE)).toBe(false);
		expect(b.files.has(TP_KEYRING)).toBe(false);
		expect(b.events.some((e) => e.startsWith('dpkg -i'))).toBe(false);
		expect(b.pkgs.tor).toBe(UBU_TOR);
		expect(r.detail).toContain('so it was put back: Tor ' + UBU_TOR + ', and it connects.');
	});
	it('a copy of only some of the installed Tor packages is no way back: nothing changes', async () => {
		const b = new Box();
		b.downloadPartial = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('no-way-back');
		expect(b.files.size).toBe(0);
	});
	it("an install that says it worked but left Ubuntu's Tor: put back, never called done", async () => {
		const b = new Box();
		b.installNoChange = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('put-back');
		expect(r.detail).toContain(`the install did not finish (Tor is ${UBU_TOR})`);
	});
	it('apt failing to read the repository is a failure even when older lists of it are there', async () => {
		const b = new Box();
		b.readOk = false;
		b.staleLists = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('put-back');
		expect(b.installs).toEqual([]);
	});
	it("apt still preferring Ubuntu's Tor after reading the repository: nothing is installed, put back", async () => {
		const b = new Box();
		b.candidateUbuntu = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('put-back');
		expect(b.installs).toEqual([]);
	});
	it("a clearnet server with apt's Tor transport installed still reaches the onion through the proxy line, not tor+", async () => {
		const b = new Box();
		b.serve.site = null;
		b.torTransport = true;
		await healTorProjectRepo(ctx, b, { socks: '127.0.0.1:9050', refreshAutoUpdates: auto });
		expect(b.files.get(TP_SOURCE)).toBe(tpSourceText(TP_ONION_BASE, 'noble'));
		expect(b.files.has(TP_ONION_PROXY)).toBe(true);
	});
	it("Morphit's source left from an attempt that did not finish, Tor still Ubuntu's: switched now, not called done", async () => {
		const b = new Box();
		b.files.set(TP_SOURCE, tpSourceText(TP_SITE_BASE, 'noble'));
		b.listsRead = true;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('switched');
		expect(b.pkgs.tor).toBe(TP_TOR);
	});
	it("the Tor Project's repository the admin set up himself: left alone, no second source beside it", async () => {
		const b = new Box();
		const own = '/etc/apt/sources.list.d/tor.sources';
		b.files.set(TP_SOURCE, tpSourceText(TP_SITE_BASE, 'noble'));
		b.listsRead = true;
		b.files.set(own, b.files.get(TP_SOURCE)!);
		b.files.delete(TP_SOURCE);
		// apt still knows it (from the admin's file).
		const policy = b.aptPolicy;
		b.files.set(TP_SOURCE, b.files.get(own)!);
		const withTp = policy();
		b.files.delete(TP_SOURCE);
		b.aptPolicy = () => withTp;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r).toMatchObject({ strategy: 'own-source', routine: true });
		expect(b.events).toEqual([]);
		expect(b.fetched).toEqual([]);
	});
	it('the install fails: put back', async () => {
		const b = new Box();
		b.installOk = false;
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r.strategy).toBe('put-back');
		expect(b.files.has(TP_SOURCE)).toBe(false);
		expect(b.pkgs.tor).toBe(UBU_TOR);
	});
	it("the new Tor does not connect: Ubuntu's copy reinstalled from the saved packages, the source removed, Tor restarted and checked", async () => {
		const b = new Box();
		b.works = [false, true];
		let refreshed = false;
		const r = await healTorProjectRepo(ctx, b, {
			refreshAutoUpdates: async () => {
				refreshed = true;
				return auto();
			}
		});
		expect(r).toMatchObject({ strategy: 'put-back', verified: false });
		expect(r.detail).toContain(`(Tor ${TP_TOR} did not connect)`);
		expect(b.events).toContain(
			`dpkg -i ${TOR_ROLLBACK_DIR}/tor.deb ${TOR_ROLLBACK_DIR}/tor-geoipdb.deb`
		);
		expect(b.events.indexOf('restart tor')).toBeGreaterThan(
			b.events.findIndex((e) => e.startsWith('dpkg -i'))
		);
		expect(b.pkgs.tor).toBe(UBU_TOR);
		expect(b.files.has(TP_SOURCE)).toBe(false);
		expect(refreshed).toBe(false);
		expect(r.detail).toContain(', and it connects.');
	});
	it('the keyring package already keeps the key: it is not written over', async () => {
		const b = new Box();
		b.pkgs['deb.torproject.org-keyring'] = '2025.08.08';
		await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(b.events).not.toContain(`write ${TP_KEYRING}`);
	});
	it('Tor updates off: a source Morphit added is removed (Tor stays); nothing to remove is quiet', async () => {
		const b = new Box();
		await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		b.files.set(UPDATES_ENV, 'MORPHIT_TOR_UPDATES=off\n');
		const r = await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto });
		expect(r).toMatchObject({ strategy: 'off', verified: true });
		expect(b.files.has(TP_SOURCE)).toBe(false);
		expect(b.pkgs.tor).toBe(TP_TOR);
		expect(await healTorProjectRepo(ctx, b, { refreshAutoUpdates: auto })).toMatchObject({
			routine: true
		});
		const s = new Box();
		s.files.set(UPDATES_ENV, 'MORPHIT_SECURITY_UPDATES=off\n');
		expect((await healTorProjectRepo(ctx, s)).strategy).toBe('off');
		expect(s.fetched).toEqual([]);
	});
	it('no Tor, or an architecture the Tor Project does not build for: nothing', async () => {
		const n = new Box();
		n.pkgs = {};
		expect(await healTorProjectRepo(ctx, n)).toMatchObject({ strategy: 'no-tor', routine: true });
		const a = new Box();
		a.archName = 'armhf';
		expect(await healTorProjectRepo(ctx, a)).toMatchObject({
			strategy: 'unsupported-arch',
			routine: true
		});
		expect(a.fetched).toEqual([]);
	});
	it('a switch the daily updates did not take up is said', async () => {
		const b = new Box();
		const r = await healTorProjectRepo(ctx, b, {
			refreshAutoUpdates: async () => ({
				strategy: 'partial',
				verified: false,
				detail: 'Automatic updates are not fully in place.'
			})
		});
		expect(r.verified).toBe(false);
		expect(r.detail).toContain('Automatic updates are not fully in place.');
	});
});

// The real gpg and gpgv, with a key made here.
describe.runIf(existsSync('/usr/bin/gpg') && existsSync('/usr/bin/gpgv'))(
	'the real key checks',
	() => {
		it('the fingerprint of an armored key; a release file signed by it passes, an altered one does not', () => {
			const home = mkdtempSync(join(tmpdir(), 'g'));
			try {
				const env = { ...process.env, GNUPGHOME: home };
				execFileSync(
					'gpg',
					[
						'--batch',
						'--passphrase',
						'',
						'--quick-gen-key',
						'test <t@t>',
						'ed25519',
						'sign',
						'never'
					],
					{ env, stdio: 'ignore' }
				);
				const fpr = execFileSync('gpg', ['--with-colons', '--list-keys'], { env, encoding: 'utf8' })
					.split('\n')
					.find((l) => l.startsWith('fpr:'))!
					.split(':')[9]!;
				const armored = execFileSync('gpg', ['--armor', '--export', fpr], { env });
				mkdirSync(join(home, 'r'));
				writeFileSync(join(home, 'r', 'Release'), 'Origin: TorProject\nCodename: noble\n');
				execFileSync(
					'gpg',
					[
						'--batch',
						'--clearsign',
						'-o',
						join(home, 'r', 'InRelease'),
						join(home, 'r', 'Release')
					],
					{ env, stdio: 'ignore' }
				);
				const inRelease = readFileSync(join(home, 'r', 'InRelease'));
				const rt = realTorRepoRuntime('127.0.0.1:9050');
				expect(rt.fingerprints(armored)).toContain(fpr);
				const keyring = rt.dearmor(armored)!;
				expect(keyring.length).toBeGreaterThan(0);
				expect(rt.verifySigned(keyring, inRelease)).toBe(true);
				expect(
					rt.verifySigned(keyring, Buffer.from(inRelease.toString().replace('noble', 'jammy')))
				).toBe(false);
				expect(rt.fingerprints(Buffer.from('not a key'))).toEqual([]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
);
