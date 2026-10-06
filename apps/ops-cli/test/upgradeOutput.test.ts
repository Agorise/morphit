/**
 * What `morphit-ops upgrade` prints. The v1.21.0 upgrade on morphit.io printed
 * about 470 lines: the whole release notes, Docker's build progress, npm's
 * package count, a line for every check that found nothing to change (some on
 * every upgrade), the 38 block numbers of the kept IPFS snapshots, a warning
 * and a question line about the same plain-text backups, and a body-limit
 * check that asked the site through public DNS and reported "could not reach".
 * Each test below drives the real function and checks what reaches the
 * operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	bodyProbeCandidates,
	bodyProbeResolve,
	printRoutineSummary,
	fullNotesPointer,
	readNotesFromTarball,
	rollback,
	runShowingOutputOnFailure,
	stepWarnings,
	releaseNotesMember,
	releaseNotesSummary,
	reportHeal,
	takeChildWarnings,
	takeUpgradeQuestions,
	upgradeSummaryLines,
	type UpgradeSummary
} from '../src/commands/upgrade.ts';
import { describeWebHeal, followWebHeal, writeWebHealState } from '../src/lib/webHeal.ts';
import { runIpfsGcHeal } from '../src/lib/ipfsGcHeal.ts';
import {
	HELPER_SCRIPTS,
	describeHelperRefresh,
	refreshHelperScripts
} from '../src/lib/refreshHelperScripts.ts';
import { loadOperatorConfig } from '../../../packages/operator-config/src/index.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const dirs: string[] = [];
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'upgrade-output-'));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
	delete process.env.MORPHIT_WEB_HEAL_STATE;
	delete process.env.MORPHIT_WEB_HEAL_LOG;
	delete process.env.MORPHIT_UPGRADE_QUESTIONS_FILE;
	delete process.env.MORPHIT_UPGRADE_WARNINGS_FILE;
});

/** Everything written to stdout and stderr while `fn` runs. */
async function captured(fn: () => unknown): Promise<string> {
	let out = '';
	const grab = (chunk: unknown): boolean => {
		out += String(chunk);
		return true;
	};
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	try {
		await fn();
	} finally {
		vi.restoreAllMocks();
	}
	return out;
}

describe('heal results that found nothing to change', () => {
	beforeEach(() => {
		// start from an empty count
		void captured(() => printRoutineSummary());
	});

	it('print nothing each, and one line for all of them', async () => {
		const out = await captured(async () => {
			await reportHeal(
				Promise.resolve({
					strategy: 'already',
					verified: true,
					routine: true,
					detail:
						"Indexer trusted proxies: the frontend's network 172.20.0.0/16 is already trusted."
				})
			);
			await reportHeal(
				Promise.resolve({
					strategy: 'skipped',
					verified: true,
					routine: true,
					detail: 'Bare-metal nginx: not running on this server; nothing to do.'
				})
			);
			await reportHeal(
				Promise.resolve({ strategy: 'applied', verified: true, detail: 'Tor onion PoW: on.' })
			);
			printRoutineSummary();
		});
		expect(out).not.toMatch(/already trusted/);
		expect(out).not.toMatch(/Bare-metal nginx/);
		expect(out).toMatch(/Tor onion PoW: on\./);
		expect(out).toMatch(/✓ 2 other checks found nothing to change\./);
	});

	// v1.21.1 review: folding by strategy alone hid action items behind
	// "✓ N other checks found nothing to change".
	it('an already/skipped result that names an action, a notice or a failure is always shown', async () => {
		const details = [
			[
				'skipped',
				"Service users: morphit-indexer.service is not this release's unit (it runs as root), so it was left as it is."
			],
			[
				'already',
				'Indexer asset policy: nothing in /etc/morphit/indexer.env undoes it; MORPHIT_X overrides it (left as it is: remove one of them on this server).'
			],
			['skipped', "BunkerWeb's jobs: Docker is not answering on this server; nothing to check."],
			[
				'skipped',
				'Tor onion PoW: this Tor was built without the proof-of-work module, so the onion has no DoS defence.'
			],
			[
				'already',
				'Hidden RPC nodes: morphit-indexer.service: MORPHIT_HIDDEN_RPC is your own setting in /etc/morphit/indexer.env — left as it is.'
			],
			[
				'kept-by-choice',
				'Backups: left as they are (your choice, recorded in /etc/morphit/x; you will not be asked again).'
			]
		] as const;
		const out = await captured(async () => {
			for (const [strategy, detail] of details)
				await reportHeal(Promise.resolve({ strategy, verified: true, detail }));
			printRoutineSummary();
		});
		for (const [, detail] of details) expect(out).toContain(detail.slice(0, 40));
		expect(out).not.toMatch(/other check/);
	});

	it('a result that was not observed is never folded away', async () => {
		const out = await captured(async () => {
			await reportHeal(
				Promise.resolve({
					strategy: 'skipped',
					verified: false,
					detail:
						'OS fetches: the release has no ops/tor-only scripts here, so nothing was checked.'
				})
			);
			printRoutineSummary();
		});
		expect(out).toMatch(/nothing was checked/);
		expect(out).not.toMatch(/other check/);
	});
});

describe('the release notes before the upgrade question', () => {
	it('show the opening of the real v1.21.0 notes, not all of them, and say where the rest is', () => {
		const notes = readFileSync(
			join(REPO, 'docs', 'release-notes', 'RELEASE-NOTES-v1.21.0.md'),
			'utf8'
		);
		expect(notes.split('\n').length).toBeGreaterThan(250);
		const s = releaseNotesSummary(notes);
		const firstSection = s.lines.findIndex((l) => /^##/.test(l));
		const opening = s.lines.slice(0, firstSection);
		expect(opening.length).toBeLessThanOrEqual(15);
		expect(opening.join('\n')).toMatch(/full security and privacy review/);
		expect(s.lines.length).toBeLessThan(notes.split('\n').length / 2);
		// Only must-read sections follow the opening.
		for (const h of s.lines.filter((l) => /^## /.test(l)))
			expect(h).toMatch(/Zero-clearnet|Every node/);
		expect(s.lines[0]).not.toMatch(/^# /);
		expect(s.more).toBe(true);
	});
	it('short notes are shown whole', () => {
		const s = releaseNotesSummary('# Morphit v9.9.9\n\nOne fix.\n');
		expect(s).toEqual({ lines: ['One fix.'], more: false });
	});
	it('sections an operator must read before answering are always shown (Upgrading, zero-clearnet, every node)', () => {
		const notes = readFileSync(
			join(REPO, 'docs', 'release-notes', 'RELEASE-NOTES-v1.21.0.md'),
			'utf8'
		);
		const text = releaseNotesSummary(notes).lines.join('\n');
		expect(text).toMatch(/^## Zero-clearnet nodes: upgrade from the signed offline bundle$/m);
		expect(text).toMatch(/^## Every node: questions and repairs after the upgrade$/m);
		expect(text).toMatch(/--from-file/);
		expect(text).not.toMatch(/^## Privacy$/m);
		const old = releaseNotesSummary(
			readFileSync(join(REPO, 'docs', 'release-notes', 'RELEASE-NOTES-v1.20.3.md'), 'utf8')
		).lines.join('\n');
		expect(old).toMatch(/^## Upgrading$/m);
		const nested = releaseNotesSummary(
			'# v9\n\nIntro.\n\n## Servers\n\nOther.\n\n### Zero-clearnet nodes\n\nUse --from-file.\n\n### Mail\n\nNo.\n'
		).lines.join('\n');
		expect(nested).toMatch(/### Zero-clearnet nodes\n\nUse --from-file\./);
		expect(nested).not.toMatch(/Mail/);
	});
});

describe('release notes on a Tor/I2P-only or offline upgrade (read from the tarball)', () => {
	it('finds the notes in the new layout and in the old one', () => {
		expect(
			releaseNotesMember(
				'./README.md\n./docs/release-notes/RELEASE-NOTES-v1.21.1.md\n./docs/release-notes/RELEASE-NOTES-v1.21.0.md\n',
				'v1.21.1'
			)
		).toBe('./docs/release-notes/RELEASE-NOTES-v1.21.1.md');
		expect(
			releaseNotesMember('./RELEASE-NOTES-v1.20.3.md\n./RELEASE-NOTES-v1.20.30.md\n', 'v1.20.3')
		).toBe('./RELEASE-NOTES-v1.20.3.md');
		expect(releaseNotesMember('./README.md\n', 'v1.21.1')).toBeNull();
	});
	it('reads them from a real release-shaped tarball (tar … -czf X .)', () => {
		const d = tmp();
		const src = join(d, 'src');
		mkdirSync(join(src, 'docs', 'release-notes'), { recursive: true });
		writeFileSync(
			join(src, 'docs', 'release-notes', 'RELEASE-NOTES-v9.9.9.md'),
			'# Morphit v9.9.9\n\nOne fix.\n'
		);
		writeFileSync(join(src, 'README.md'), '# readme\n');
		const tb = join(d, 'morphit-v9.9.9.tar.gz');
		spawnSync('tar', ['-C', src, '-czf', tb, '.']);
		const r = readNotesFromTarball(tb, 'v9.9.9');
		expect(r?.body).toBe('# Morphit v9.9.9\n\nOne fix.');
		expect(r?.member).toBe('./docs/release-notes/RELEASE-NOTES-v9.9.9.md');
	});
	it('the full notes: a web link when there is one, else the command that prints them from the tarball', () => {
		expect(fullNotesPointer('https://git.example/rel/v1', null, null)).toBe(
			'https://git.example/rel/v1'
		);
		expect(
			fullNotesPointer(
				'file:///tmp/m.tar.gz',
				'/tmp/m.tar.gz',
				'./docs/release-notes/RELEASE-NOTES-v1.md'
			)
		).toBe(
			"tar -xzOf '/tmp/m.tar.gz' './docs/release-notes/RELEASE-NOTES-v1.md' | less   (in another terminal, while this question waits)"
		);
		expect(fullNotesPointer('', null, null)).toBeNull();
		expect(fullNotesPointer('file:///tmp/m.tar.gz', null, null)).toBeNull();
	});
});

describe('the last lines of an upgrade', () => {
	const base: UpgradeSummary = {
		from: 'v1.21.0',
		to: 'v1.21.1',
		backupDir: '/opt/morphit.bak-1',
		schemaChanged: false,
		canaryLeft: false,
		canaryTimer: false,
		questions: [],
		backgroundLog: null,
		warnings: 0,
		frontendVerified: true
	};
	it('say "Nothing else to do." only when nothing is left', () => {
		const t = upgradeSummaryLines(base).join('\n');
		expect(t).toMatch(/now running v1\.21\.1/);
		expect(t).toMatch(/Nothing else to do\./);
	});
	it('list what is left, each with where to run it', () => {
		const t = upgradeSummaryLines({
			...base,
			canaryLeft: true,
			questions: ['what to do with the plain-text database backups (27 …)'],
			backgroundLog: '/var/log/morphit/after-upgrade-heal.log'
		}).join('\n');
		expect(t).not.toMatch(/Nothing else to do/);
		expect(t).toMatch(/Left for you:/);
		expect(t).toMatch(/on the computer that holds its key: bash ~\/\.morphit\/update-canary\.sh/);
		expect(t).toMatch(/backups \(27 …\)\. On this server: sudo morphit-ops upgrade --questions/);
		expect(t).toMatch(/sudo cat \/var\/log\/morphit\/after-upgrade-heal\.log/);
	});
	// v1.21.1 review: the last word came after warnings (MCP, Matrix, a
	// service that would not start, the IPFS seed, heals) and still said
	// "Nothing else to do." and "Every service restarted on it, and the site
	// serves it." without having checked either.
	it('after warnings: never "Nothing else to do.", and the warnings are named as left for you', () => {
		const t = upgradeSummaryLines({ ...base, warnings: 2 }).join('\n');
		expect(t).not.toMatch(/Nothing else to do/);
		expect(t).toMatch(/Left for you:[\s\S]*2 warnings above/);
		expect(t).not.toMatch(/Every service restarted/);
		expect(upgradeSummaryLines({ ...base, warnings: 1 }).join('\n')).toMatch(/One warning above/);
	});
	it('says the site serves the new version only when that was checked', () => {
		expect(upgradeSummaryLines(base).join('\n')).toMatch(/The site serves it \(checked\)\./);
		const t = upgradeSummaryLines({ ...base, frontendVerified: false }).join('\n');
		expect(t).not.toMatch(/site serves it/);
		expect(t).toMatch(/Every service restarted on it\./);
	});
	it('the heal phase (a child process) hands its warning count to the last lines', () => {
		const d = tmp();
		process.env.MORPHIT_UPGRADE_WARNINGS_FILE = join(d, 'w');
		writeFileSync(join(d, 'w'), '3\n');
		expect(takeChildWarnings()).toBe(3);
		expect(takeChildWarnings()).toBe(0);
	});
	it('a box that re-signs its own canary is told it is not urgent', () => {
		const t = upgradeSummaryLines({ ...base, canaryLeft: true, canaryTimer: true }).join('\n');
		expect(t).toMatch(/re-signs it within a week/);
		expect(t).not.toMatch(/update-canary\.sh/);
	});
	it('the heal phase hands its open questions to the last lines through a file', () => {
		const d = tmp();
		process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = join(d, 'q');
		writeFileSync(join(d, 'q'), 'one\n\ntwo\n');
		expect(takeUpgradeQuestions()).toEqual(['one', 'two']);
		expect(takeUpgradeQuestions()).toEqual([]);
	});
});

describe('the WAF body-limit check asks this server, not public DNS', () => {
	it('sends an https origin to 127.0.0.1 on its port', () => {
		expect(bodyProbeResolve('https://morphit.io')).toBe('morphit.io:443:127.0.0.1');
		expect(bodyProbeResolve('https://example.org:8443/')).toBe('example.org:8443:127.0.0.1');
	});
	it('leaves hidden addresses and IPs to the plain request', () => {
		expect(bodyProbeResolve(`http://${'a'.repeat(56)}.onion`)).toBeNull();
		expect(bodyProbeResolve(`https://${'b'.repeat(52)}.b32.i2p`)).toBeNull();
		expect(bodyProbeResolve('https://203.0.113.5')).toBeNull();
		expect(bodyProbeResolve('not a url')).toBeNull();
	});
});

describe('the WAF body-limit check: where it asks, in order', () => {
	it('this server at the address port, then at 443 (asked without the port), then the address itself; never a hidden address', () => {
		expect(bodyProbeCandidates('https://example.org:8443')).toEqual([
			{ url: 'https://example.org:8443/v1/broadcast', resolve: 'example.org:8443:127.0.0.1' },
			{ url: 'https://example.org/v1/broadcast', resolve: 'example.org:443:127.0.0.1' },
			{ url: 'https://example.org:8443/v1/broadcast', resolve: null }
		]);
		expect(bodyProbeCandidates('https://morphit.io')).toEqual([
			{ url: 'https://morphit.io/v1/broadcast', resolve: 'morphit.io:443:127.0.0.1' },
			{ url: 'https://morphit.io/v1/broadcast', resolve: null }
		]);
		expect(bodyProbeCandidates('http://203.0.113.5')).toEqual([
			{ url: 'http://203.0.113.5/v1/broadcast', resolve: null }
		]);
		expect(bodyProbeCandidates(`http://${'a'.repeat(56)}.onion`)).toBeNull();
		expect(bodyProbeCandidates(`http://${'a'.repeat(56)}.onion.`)).toBeNull();
		expect(bodyProbeCandidates(`https://${'b'.repeat(52)}.b32.i2p`)).toBeNull();
	});
});

describe('following the background web heal', () => {
	it("shows its results, not its wait labels (the upgrade's spinner shows those)", async () => {
		const d = tmp();
		process.env.MORPHIT_WEB_HEAL_STATE = join(d, 'web-heal.json');
		process.env.MORPHIT_WEB_HEAL_LOG = join(d, 'web-heal.log');
		writeFileSync(join(d, 'web-heal.log'), '');
		const started = new Date(1_000).toISOString();
		let t = 0;
		const seen: string[] = [];
		const steps = [
			() =>
				appendFileSync(
					join(d, 'web-heal.log'),
					'  Looking for the web containers…\n' +
						'  Applying the privacy and header settings to the web containers (each restarts once)…\n' +
						'✓ BunkerWeb: DNS blocklists — off (USE_DNSBL=no)\n'
				),
			() =>
				writeWebHealState({
					state: 'done',
					startedAt: started,
					finishedAt: started,
					result: 'applied'
				})
		];
		await followWebHeal(600_000, 1_000, {
			now: () => t,
			sleep: async (ms) => {
				t += ms;
				steps.shift()?.();
			},
			info: (m) => seen.push(m),
			spinner: () => () => {}
		});
		expect(seen).toEqual(['✓ BunkerWeb: DNS blocklists — off (USE_DNSBL=no)']);
	});
});

describe('the IPFS clean-up line', () => {
	const LINE = (result: string): string =>
		`MORPHIT_IPFS_GC result=${result} pins_before=40 pins_after=39 unpinned=1 staged_removed=0 kept_releases=v1.20.2,v1.20.3 kept_snapshots=${Array.from({ length: 38 }, (_, i) => 63_600_000 + i).join(',')} repo_bytes_before=3759374336 repo_bytes_after=3723182080`;
	const rt = (result: string) => ({
		kuboPresent: () => true,
		install: () => ({ ok: true }),
		run: () => ({ status: 0, output: LINE(result) }),
		spinner: () => () => {}
	});
	it('names the kept releases and counts the snapshots', () => {
		const seen: string[] = [];
		runIpfsGcHeal({ runtime: rt('done'), info: (m) => seen.push(m), warn: (m) => seen.push(m) });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/kept releases v1\.20\.2, v1\.20\.3 and 38 snapshots/);
		expect(seen[0]).not.toMatch(/63600000/);
		expect(seen[0]).not.toMatch(/weekly from now on/);
	});
	it('says nothing when nothing was superseded', () => {
		const seen: string[] = [];
		runIpfsGcHeal({
			runtime: rt('nothing-to-do'),
			info: (m) => seen.push(m),
			warn: (m) => seen.push(m)
		});
		expect(seen).toEqual([]);
	});
});

describe('refreshed helper scripts', () => {
	it('are named in one line, not one line each', () => {
		const d = tmp();
		const release = join(d, 'release');
		const helperDir = join(d, 'helpers');
		mkdirSync(helperDir);
		// Three installed helpers, each with an older copy than the release's.
		const some = HELPER_SCRIPTS.slice(0, 3);
		for (const h of some) {
			mkdirSync(join(release, h.release, '..'), { recursive: true });
			writeFileSync(join(release, h.release), '#!/bin/sh\necho new\n');
			writeFileSync(join(helperDir, h.name), '#!/bin/sh\necho old\n');
			chmodSync(join(helperDir, h.name), 0o755);
		}
		const logged: string[] = [];
		const results = refreshHelperScripts({
			releaseRoot: release,
			helperDir,
			log: (m) => logged.push(m)
		});
		expect(results.filter((r) => r.action === 'refreshed').map((r) => r.name)).toEqual(
			some.map((h) => h.name)
		);
		expect(logged).toEqual([]);
		const line = describeHelperRefresh(results, helperDir)!;
		expect(line).toMatch(/^Refreshed 3 helper scripts in /);
		for (const h of some) expect(line).toContain(h.name);
		const again = refreshHelperScripts({ releaseRoot: release, helperDir, log: () => {} });
		expect(describeHelperRefresh(again, helperDir)).toBeNull();
	});
});

describe('the operator config, loaded by morphit-ops', () => {
	it('loads without a "[operator-config] loaded …" line', async () => {
		const d = tmp();
		writeFileSync(join(d, 'morphit.config.env'), 'MORPHIT_RELAY_SIGNUP_ENABLED=true\n');
		const saved = process.env.MORPHIT_RELAY_SIGNUP_ENABLED;
		delete process.env.MORPHIT_RELAY_SIGNUP_ENABLED;
		const logs: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
		try {
			const r = loadOperatorConfig({ searchPaths: [d], quiet: true });
			expect(r.applied).toBe(1);
			expect(logs).toEqual([]);
			loadOperatorConfig({ searchPaths: [d] });
			expect(logs.join('\n')).toMatch(/\[operator-config\] (loaded|skipped)/);
		} finally {
			if (saved === undefined) delete process.env.MORPHIT_RELAY_SIGNUP_ENABLED;
			else process.env.MORPHIT_RELAY_SIGNUP_ENABLED = saved;
		}
	});
});

describe('a rollback after the heal phase', () => {
	it('still names the questions the heal phase left, and checks still running in the background', async () => {
		const d = tmp();
		process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = join(d, 'q');
		writeFileSync(join(d, 'q'), 'what to do with the plain-text database backups (27 …)\n');
		const installDir = join(d, 'opt', 'morphit');
		const backupDir = join(d, 'opt', 'morphit.bak');
		mkdirSync(installDir, { recursive: true });
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(join(backupDir, 'release-info.json'), '{}');
		const calls: string[] = [];
		const out = await captured(() =>
			rollback(installDir, backupDir, join(d, 'tmp'), new Error('restart failed'), undefined, [], {
				systemctl: (args) => {
					calls.push(args.join(' '));
					return { status: args[0] === 'is-active' ? 0 : 0 };
				}
			})
		);
		expect(out).toMatch(/plain-text database backups \(27 …\)/);
		expect(out).toMatch(/Stopped the background checks \(morphit-after-upgrade-heal\)/);
		expect(calls).toContain('stop morphit-after-upgrade-heal');
		expect(takeUpgradeQuestions()).toEqual([]);
	});
});

describe('a step whose output only matters when it fails (the frontend rebuild)', () => {
	it('prints nothing when it works, even with very large output (no buffer to overflow)', async () => {
		let ok = false;
		const out = await captured(() => {
			ok = runShowingOutputOnFailure(
				'sh',
				['-c', 'head -c 40000000 /dev/zero | tr "\\0" x; echo'],
				60_000
			);
		});
		expect(ok).toBe(true);
		expect(out).toBe('');
	});
	it('shows the last lines and fails when it fails', async () => {
		let ok = true;
		const out = await captured(() => {
			ok = runShowingOutputOnFailure(
				'sh',
				['-c', 'echo first; echo the-reason >&2; exit 3'],
				60_000
			);
		});
		expect(ok).toBe(false);
		expect(out).toMatch(/the-reason/);
	});
});

describe('a quiet build that worked still shows its warnings', () => {
	it("keeps esbuild's warning blocks and drops the rest (size table, progress)", () => {
		const out = [
			'',
			'  dist/main.js  2.1mb ⚠️',
			'',
			'▲ [WARNING] Import "x" will always be undefined [import-is-undefined]',
			'',
			'    src/a.ts:3:9:',
			'      3 │ import { x } from "./b";',
			'',
			'✓ ops-cli bundled'
		].join('\n');
		expect(stepWarnings(out)).toBe(
			[
				'▲ [WARNING] Import "x" will always be undefined [import-is-undefined]',
				'    src/a.ts:3:9:',
				'      3 │ import { x } from "./b";'
			].join('\n')
		);
		expect(stepWarnings('✓ ops-cli bundled\n')).toBe('');
	});
});

describe('the Matrix alert bot line', () => {
	it('says "restarted" only after the bot was seen running (a bot that exits at once restarted too)', () => {
		const src = readFileSync(
			join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'),
			'utf8'
		);
		const block =
			/const res = syncMatrixBotService\(true, \{ restart: true \}\);([\s\S]*?)\} else \{\n\t\t\t\/\/ No alert username/.exec(
				src
			)?.[1] ?? '';
		expect(block).toMatch(/'is-active', '--quiet', MATRIX_BOT_UNIT/);
		expect(block).toMatch(/if \(res\.ok && running\) info\(/);
		expect(block).not.toMatch(
			/if \(res\.ok\) info\('✓ Matrix alert bot restarted on this release\.'\)/
		);
	});
});

describe('the background web heal keeps its warnings findable', () => {
	it('its outcome names how many warnings it printed and where to read them (status and the summary point there)', () => {
		const t = '2026-10-06T12:00:00.000Z';
		const line = describeWebHeal(
			{ state: 'done', startedAt: t, finishedAt: t, result: 'applied', warnings: 2 },
			Date.parse(t)
		);
		expect(line).toMatch(/applied and checked/);
		expect(line).toMatch(/2 warnings, see on this server: sudo cat .*web-heal\.log/);
		expect(
			describeWebHeal(
				{ state: 'done', startedAt: t, finishedAt: t, result: 'applied' },
				Date.parse(t)
			)
		).not.toMatch(/warning/);
	});
	it('relays a warning line from the unit as a warning (counted)', async () => {
		const d = tmp();
		process.env.MORPHIT_WEB_HEAL_STATE = join(d, 'web-heal.json');
		const warned: string[] = [];
		const infos: string[] = [];
		const started = new Date(1_000).toISOString();
		writeWebHealState({
			state: 'done',
			startedAt: started,
			finishedAt: started,
			result: 'applied'
		});
		await followWebHeal(600_000, 1_000, {
			info: (m) => infos.push(m),
			warn: (m) => warned.push(m),
			spinner: () => () => {},
			readLogFrom: (from) =>
				from === 0 ? ['[WARN] WAF: could not restart BunkerWeb\n✓ ok\n', 100] : ['', from],
			now: () => 2_000,
			sleep: async () => {}
		});
		expect(warned).toEqual(['WAF: could not restart BunkerWeb']);
		expect(infos).toEqual(['✓ ok']);
	});
});

describe('a heal phase stopped at its time limit', () => {
	it('still hands its warning count and its open questions to the last lines', () => {
		const src = readFileSync(
			join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'),
			'utf8'
		);
		const onTerm =
			/const onTerm = \(\): void => \{([\s\S]*?)process\.exit\(143\);/.exec(src)?.[1] ?? '';
		expect(onTerm).toMatch(/printDeferredQuestions\(\);/);
		expect(onTerm).toMatch(/recordChildWarnings\(\);/);
	});
});
