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
	statSync,
	writeFileSync
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	bodyProbeCandidates,
	bodyProbeResolve,
	checkMcpAnswers,
	installDepsWithNpmCi,
	isRoutineHeal,
	printRoutineSummary,
	probeBroadcastBody,
	fullNotesPointer,
	readNotesFromTarball,
	restartFrontendContainer,
	rollback,
	runShowingOutputOnFailure,
	runStepWithSpinner,
	showReleaseNotes,
	stepWarnings,
	releaseNotesMember,
	releaseNotesSummary,
	reportHeal,
	syncMatrixBotOnUpgrade,
	takeChildWarnings,
	takeUpgradeQuestions,
	upgradeSummaryLines,
	verifyServedFrontend,
	type UpgradeSummary
} from '../src/commands/upgrade.ts';
import { describeWebHeal, followWebHeal, writeWebHealState } from '../src/lib/webHeal.ts';
import { runIpfsGcHeal } from '../src/lib/ipfsGcHeal.ts';
import { plainText, sanitizeForTerm } from '../src/render/term.ts';
import { commandInTerminal, runInTerminal, spinnerFrames } from './helpers/pty.ts';
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
		frontendVerified: true,
		servicesVerified: true
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
		expect(upgradeSummaryLines({ ...base, warnings: 1 }).join('\n')).toMatch(/One warning above/);
	});
	// 2026-10-08 (morphitir): one seed-check warning dropped "Every service
	// restarted on it" although each service had been seen to stay up on the
	// new version. The sentence now follows that check, not the warning count.
	it('says every service restarted exactly when each was seen to stay up, warnings or not', () => {
		expect(upgradeSummaryLines({ ...base, warnings: 2 }).join('\n')).toMatch(
			/Every service restarted on it \(checked\)\./
		);
		expect(
			upgradeSummaryLines({ ...base, warnings: 2, servicesVerified: false }).join('\n')
		).not.toMatch(/Every service restarted/);
		expect(upgradeSummaryLines({ ...base, servicesVerified: false }).join('\n')).not.toMatch(
			/Every service restarted/
		);
	});
	it('says the site serves the new version only when that was checked', () => {
		expect(upgradeSummaryLines(base).join('\n')).toMatch(/The site serves it \(checked\)\./);
		const t = upgradeSummaryLines({ ...base, frontendVerified: false }).join('\n');
		expect(t).not.toMatch(/site serves it/);
		expect(t).toMatch(/Every service restarted on it \(checked\)\./);
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
		run: async () => ({ status: 0, output: LINE(result) }),
		spinner: () => () => {}
	});
	it('names the kept releases and counts the snapshots', async () => {
		const seen: string[] = [];
		await runIpfsGcHeal({
			runtime: rt('done'),
			info: (m) => seen.push(m),
			warn: (m) => seen.push(m)
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/kept releases v1\.20\.2, v1\.20\.3 and 38 snapshots/);
		expect(seen[0]).not.toMatch(/63600000/);
		expect(seen[0]).not.toMatch(/weekly from now on/);
	});
	it('says nothing when nothing was superseded', async () => {
		const seen: string[] = [];
		await runIpfsGcHeal({
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
	beforeEach(() => {
		process.env.MORPHIT_STEP_LOG_DIR = join(tmp(), 'log');
	});
	afterEach(() => {
		delete process.env.MORPHIT_STEP_LOG_DIR;
	});
	it('prints nothing but its label when it works, even with very large output (no buffer to overflow)', async () => {
		let ok = false;
		const out = await captured(async () => {
			ok = await runShowingOutputOnFailure(
				'Rebuilding…',
				'sh',
				['-c', 'head -c 40000000 /dev/zero | tr "\\0" x; echo'],
				60_000
			);
		});
		expect(ok).toBe(true);
		// Without a terminal the spinner prints its label once, nothing else.
		expect(out).toBe('  Rebuilding…\n');
	});
	it('shows the last lines and fails when it fails', async () => {
		let ok = true;
		const out = await captured(async () => {
			ok = await runShowingOutputOnFailure(
				'Rebuilding…',
				'sh',
				['-c', 'echo first; echo the-reason >&2; exit 3'],
				60_000
			);
		});
		expect(ok).toBe(false);
		expect(out).toMatch(/the-reason/);
		expect(out).toMatch(/sh failed \(exit code 3\)/);
	});
	// v1.21.1 review A-F4: only the last 30/40 lines were shown and the full
	// output deleted, so an early cause was lost; a kill was "exited 1" or
	// "ETIMEDOUT".
	it('keeps the FULL output of a failed step (root-only) and says where — an early cause is in it', async () => {
		const out = await captured(() =>
			runShowingOutputOnFailure(
				'Rebuilding…',
				'sh',
				['-c', 'echo REAL-CAUSE >&2; for i in $(seq 1 60); do echo progress$i; done; exit 3'],
				60_000
			)
		);
		expect(out).not.toMatch(/REAL-CAUSE/);
		expect(out).toMatch(/progress60/);
		const path = /Its full output is kept on this server: sudo cat (\S+)/.exec(out)?.[1] ?? '';
		expect(path.startsWith(process.env.MORPHIT_STEP_LOG_DIR!)).toBe(true);
		const kept = readFileSync(path, 'utf8');
		expect(kept).toMatch(/^REAL-CAUSE\nprogress1\n/);
		expect(kept).toMatch(/progress60\n$/);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
	it('says so plainly when a step was stopped at its time limit', async () => {
		let ok = true;
		const out = await captured(async () => {
			ok = await runShowingOutputOnFailure(
				'Rebuilding…',
				'sh',
				['-c', 'echo started; sleep 30'],
				1_000
			);
		});
		expect(ok).toBe(false);
		expect(out).toMatch(/sh was stopped: it was still running after 1 s, its time limit/);
		expect(out).not.toMatch(/ETIMEDOUT|exited 1/);
		expect(out).toMatch(/started/);
	});
	it('says so plainly when a step was killed by a signal', async () => {
		const out = await captured(() =>
			runShowingOutputOnFailure('Rebuilding…', 'sh', ['-c', 'echo before-kill; kill -9 $$'], 60_000)
		);
		expect(out).toMatch(/before-kill/);
		expect(out).toMatch(/sh was stopped by a signal \(SIGKILL\)/);
	});
	it('a command that cannot be started is named as such', async () => {
		const out = await captured(() =>
			runShowingOutputOnFailure('Rebuilding…', 'no-such-binary-xyz', [], 60_000)
		);
		expect(out).toMatch(/no-such-binary-xyz could not be started \(.*ENOENT/);
	});
});

describe('a quiet step (npm, esbuild) that fails', () => {
	beforeEach(() => {
		process.env.MORPHIT_STEP_LOG_DIR = join(tmp(), 'log');
	});
	afterEach(() => {
		delete process.env.MORPHIT_STEP_LOG_DIR;
	});
	it('shows its last lines and how it ended; one that works shows only its build warnings', async () => {
		let code = 0;
		const out = await captured(async () => {
			code = await runStepWithSpinner(
				'Building morphit-ops for this release…',
				'sh',
				['-c', 'echo "✘ [ERROR] Could not resolve \\"x\\""; exit 1'],
				{ quietOnSuccess: true, name: 'npm run build' }
			);
		});
		expect(code).toBe(1);
		expect(out).toMatch(/✘ \[ERROR\] Could not resolve "x"/);
		expect(out).toMatch(/npm run build failed \(exit code 1\)\. Its full output is kept/);
		const ok = await captured(() =>
			runStepWithSpinner(
				'Building…',
				'sh',
				['-c', 'echo "  dist/main.js 2.1mb"; echo "▲ [WARNING] big"; echo "✓ bundled"'],
				{ quietOnSuccess: true }
			)
		);
		expect(ok).toBe('  Building…\n▲ [WARNING] big\n');
	});
	it('npm ci that fails stops the upgrade (it rolls back); one that works goes on', async () => {
		const d = tmp();
		const bin = join(d, 'bin');
		mkdirSync(bin);
		const install = join(d, 'install');
		mkdirSync(install);
		writeFileSync(
			join(install, 'package-lock.json'),
			JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' } } })
		);
		const saved = process.env.PATH;
		process.env.PATH = `${bin}:${saved ?? ''}`;
		try {
			writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm error code E401" >&2\nexit 1\n', {
				mode: 0o755
			});
			let err: unknown = null;
			const out = await captured(async () => {
				try {
					await installDepsWithNpmCi(install, join(d, 'backup'));
				} catch (e) {
					err = e;
				}
			});
			expect(String(err)).toMatch(/npm ci exited 1/);
			expect(out).toMatch(/npm error code E401/);
			writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			await expect(captured(() => installDepsWithNpmCi(install, join(d, 'backup')))).resolves.toBe(
				'  Installing dependencies (npm ci) — this can take a minute…\n'
			);
		} finally {
			process.env.PATH = saved;
		}
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
	/** systemctl: every action works; `is-active` answers $BOT_ACTIVE. */
	function botBox(): { bin: string; env: string } {
		const d = tmp();
		const bin = join(d, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'systemctl'),
			'#!/bin/sh\nfor a in "$@"; do echo "$a"; done >> "$CALLS"\n[ "$1" = is-active ] && exit "${BOT_ACTIVE:-0}"\nexit 0\n',
			{ mode: 0o755 }
		);
		const env = join(d, 'matrix-bot.env');
		writeFileSync(
			env,
			'MORPHIT_MATRIX_BOT_ALERT_MXID=@op:example.org\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_x\n'
		);
		return { bin, env };
	}
	async function withBox<T>(
		box: { bin: string },
		active: string,
		fn: () => Promise<T>
	): Promise<T> {
		const saved = {
			PATH: process.env.PATH,
			BOT_ACTIVE: process.env.BOT_ACTIVE,
			CALLS: process.env.CALLS
		};
		process.env.PATH = `${box.bin}:${saved.PATH ?? ''}`;
		process.env.BOT_ACTIVE = active;
		process.env.CALLS = join(box.bin, 'calls');
		try {
			return await fn();
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}
	it('says "restarted" only after the bot was SEEN running a few seconds later', async () => {
		const box = botBox();
		const ok = await withBox(box, '0', () =>
			captured(() => syncMatrixBotOnUpgrade({ envPath: box.env, settleMs: 50 }))
		);
		expect(ok).toMatch(/✓ Matrix alert bot restarted on this release \(seen running\)\./);
		expect(readFileSync(join(box.bin, 'calls'), 'utf8')).toMatch(
			/restart\nmorphit-matrix-bot\.service/
		);
		// A bot that exits at once "restarted" too: then it says it is not running.
		const down = await withBox(box, '3', () =>
			captured(() => syncMatrixBotOnUpgrade({ envPath: box.env, settleMs: 50 }))
		);
		expect(down).not.toMatch(/✓ Matrix alert bot restarted/);
		expect(down).toMatch(
			/\[WARN\] The Matrix alert bot was restarted but is not running a few seconds later/
		);
	});
	// v1.21.4 review (A7): a bot that did not stay up must also take
	// "Every service restarted on it (checked)." out of the last lines.
	it('tells the upgrade whether the bot was seen running', async () => {
		const box = botBox();
		let up: unknown;
		let down: unknown;
		await withBox(box, '0', () =>
			captured(async () => {
				up = await syncMatrixBotOnUpgrade({ envPath: box.env, settleMs: 50 });
			})
		);
		await withBox(box, '3', () =>
			captured(async () => {
				down = await syncMatrixBotOnUpgrade({ envPath: box.env, settleMs: 50 });
			})
		);
		expect(up).toBe(true);
		expect(down).toBe(false);
	});
	it('the few seconds it waits show a spinner at a terminal (never a silent pause)', () => {
		const box = botBox();
		const r = runInTerminal(
			'src/commands/upgrade.ts',
			`await $.syncMatrixBotOnUpgrade({ envPath: ${JSON.stringify(box.env)}, settleMs: 1500 });`,
			{
				env: {
					PATH: `${box.bin}:${process.env.PATH ?? ''}`,
					BOT_ACTIVE: '0',
					CALLS: join(box.bin, 'calls')
				}
			}
		);
		expect(r.out).toMatch(/seen running/);
		expect(spinnerFrames(r.out, 'Checking the Matrix alert bot stays up…')).toBeGreaterThanOrEqual(
			5
		);
	}, 60_000);
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
	it('still hands its warning count and its open questions to the last lines', async () => {
		const d = tmp();
		const runner = join(d, 'child.mts');
		writeFileSync(
			runner,
			[
				`const up = await import(${JSON.stringify(join(REPO, 'apps/ops-cli/src/commands/upgrade.ts'))});`,
				`const term = await import(${JSON.stringify(join(REPO, 'apps/ops-cli/src/render/term.ts'))});`,
				`await up.runPostUpgradeSelfHealChild(() => [`,
				`  ['a heal that warns', () => term.warn('first')],`,
				`  ['the slow heal', () => (console.log('SLOW STARTED'), new Promise(() => setInterval(() => {}, 1000)))]`,
				`]);`
			].join('\n')
		);
		const env = {
			...process.env,
			MORPHIT_UPGRADE_SUMMARIZES: '1',
			MORPHIT_UPGRADE_WARNINGS_FILE: join(d, 'w'),
			MORPHIT_UPGRADE_QUESTIONS_FILE: join(d, 'q')
		};
		const child = spawn(join(REPO, 'node_modules/.bin/tsx'), [runner], { env });
		let out = '';
		const slow = new Promise<void>((res) => {
			const on = (b: Buffer): void => {
				out += b;
				if (/SLOW STARTED/.test(out)) res();
			};
			child.stdout.on('data', on);
			child.stderr.on('data', on);
		});
		const closed = new Promise<number | null>((res) => child.on('close', (c) => res(c)));
		await Promise.race([slow, closed]);
		child.kill('SIGTERM');
		expect(await closed).toBe(143);
		expect(out).toMatch(/stopped its heal step at the time limit, during the slow heal/);
		process.env.MORPHIT_UPGRADE_WARNINGS_FILE = join(d, 'w');
		// "first" and the time-limit line itself.
		expect(takeChildWarnings()).toBe(2);
	}, 60_000);
});

// ── v1.21.1 review A: what the operator sees while a step runs ─────────────

describe('a slow step at a terminal turns the braille spinner (never a silent pause, A-F3)', () => {
	it('a step the upgrade runs (npm, the seed, the MCP deploy, …)', () => {
		const r = runInTerminal(
			'src/commands/upgrade.ts',
			"await $.runStepWithSpinner('Doing a slow step…', 'sleep', ['1.5']);"
		);
		expect(spinnerFrames(r.out, 'Doing a slow step…')).toBeGreaterThanOrEqual(5);
	}, 60_000);

	it('the frontend container rebuild (up to 5 minutes)', () => {
		const d = tmp();
		const bin = join(d, 'bin');
		mkdirSync(bin);
		const compose = join(d, 'stack', 'docker-compose.yml');
		mkdirSync(join(d, 'stack'), { recursive: true });
		writeFileSync(compose, 'services: {}\n');
		const inspect = JSON.stringify([
			{
				Name: '/fe-1',
				Config: {
					Image: 'morphit-frontend',
					Labels: {
						'com.docker.compose.project': 'stack',
						'com.docker.compose.service': 'frontend',
						'com.docker.compose.project.config_files': compose,
						'com.docker.compose.project.working_dir': join(d, 'stack')
					}
				},
				State: { Running: true }
			}
		]);
		writeFileSync(join(d, 'inspect.json'), inspect);
		writeFileSync(
			join(bin, 'docker'),
			`#!/bin/sh\ncase "$1" in inspect) cat ${join(d, 'inspect.json')} ;; compose) sleep 1.5 ;; esac\nexit 0\n`,
			{ mode: 0o755 }
		);
		const r = runInTerminal(
			'src/commands/upgrade.ts',
			`await $.restartFrontendContainer('fe-1', ${JSON.stringify(join(d, 'install'))});`,
			{ env: { PATH: `${bin}:${process.env.PATH ?? ''}` } }
		);
		expect(r.out).toMatch(/✓ Frontend container "fe-1" rebuilt/);
		expect(
			spinnerFrames(
				r.out,
				'Rebuilding the frontend container "fe-1" so it serves the current config + build (this can take a few minutes)…'
			)
		).toBeGreaterThanOrEqual(5);
	}, 60_000);

	it('the IPFS clean-up (up to 4 minutes)', () => {
		const d = tmp();
		const release = join(d, 'release');
		mkdirSync(join(release, 'ops', 'ipfs'), { recursive: true });
		mkdirSync(join(release, 'ops', 'systemd'), { recursive: true });
		writeFileSync(
			join(release, 'ops', 'ipfs', 'morphit-ipfs-gc.sh'),
			'#!/bin/sh\nsleep 1.5\necho "MORPHIT_IPFS_GC result=nothing-to-do pins_before=1 pins_after=1"\n'
		);
		for (const u of ['morphit-ipfs-gc.service', 'morphit-ipfs-gc.timer'])
			writeFileSync(
				join(release, 'ops', 'systemd', u),
				readFileSync(join(REPO, 'ops', 'systemd', u), 'utf8')
			);
		const repo = join(d, 'ipfs');
		mkdirSync(repo);
		writeFileSync(join(repo, 'config'), '{}');
		const bin = join(d, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'ipfs'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		mkdirSync(join(d, 'helpers'));
		mkdirSync(join(d, 'systemd'));
		const r = runInTerminal(
			'src/lib/ipfsGcHeal.ts',
			[
				`const sp = await import(${JSON.stringify(join(REPO, 'apps/ops-cli/src/init/spinner.ts'))});`,
				`const o = await $.healIpfsGc({ info: (m) => console.log('I', m), warn: (m) => console.log('W', m), spinner: (l) => sp.startDotsSpinner(l) });`,
				`console.log('KIND', o.kind, o.summary?.result);`
			].join('\n'),
			{
				env: {
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					MORPHIT_INSTALL_DIR: release,
					MORPHIT_HELPER_DIR: join(d, 'helpers'),
					MORPHIT_SYSTEMD_DIR: join(d, 'systemd'),
					MORPHIT_HEAL_NO_SYSTEMD: '1',
					IPFS_PATH: repo
				}
			}
		);
		expect(r.out).toMatch(/KIND ran nothing-to-do/);
		expect(
			spinnerFrames(r.out, 'Letting go of superseded releases and snapshots on this node’s IPFS…')
		).toBeGreaterThanOrEqual(5);
	}, 60_000);
});

describe('the pauses after the services restart show what is happening (A-F6)', () => {
	it('the MCP health check after its restart (up to ~20 s of retries)', () => {
		const r = runInTerminal(
			'src/commands/upgrade.ts',
			"await $.checkMcpAnswers('127.0.0.1', 9, { attempts: 4, delayMs: 400, timeoutMs: 300 });"
		);
		expect(
			spinnerFrames(r.out, 'Checking the MCP server answers on its new version…')
		).toBeGreaterThanOrEqual(5);
		expect(r.out).toMatch(/\[WARN\] MCP did not answer at 127\.0\.0\.1:9/);
	}, 60_000);

	// v1.21.4 review (A7): an MCP that does not answer is not "checked".
	it('the MCP health check tells the upgrade whether it answered', async () => {
		let answered: unknown;
		await captured(async () => {
			answered = await checkMcpAnswers('127.0.0.1', 9, {
				attempts: 1,
				delayMs: 10,
				timeoutMs: 200
			});
		});
		expect(answered).toBe(false);
	});

	it('an MCP or Matrix bot that did not come back, or no service restarted at all, is not "every service restarted (checked)"', async () => {
		const { readFileSync: rf } = await import('node:fs');
		const ts = (await import('typescript')).default;
		const file = join(__dirname, '..', 'src', 'commands', 'upgrade.ts');
		const sf = ts.createSourceFile(file, rf(file, 'utf8'), ts.ScriptTarget.Latest, true);
		// Each call's result must reach `servicesVerified = false` when it fails.
		const clears = (callee: string): boolean => {
			let found = false;
			const visit = (n: import('typescript').Node): void => {
				if (ts.isIfStatement(n)) {
					const cond = n.expression.getText(sf);
					const body = n.thenStatement.getText(sf);
					if (
						new RegExp(`!\\s*\\(?\\s*await\\s+${callee}\\(`).test(cond) &&
						/servicesVerified\s*=\s*false/.test(body)
					)
						found = true;
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
			return found;
		};
		expect(clears('checkMcpAnswers'), 'the MCP check').toBe(true);
		expect(clears('syncMatrixBotOnUpgrade'), 'the Matrix bot').toBe(true);
		const src = rf(file, 'utf8');
		expect(src, 'a failed MCP restart or redeploy').toMatch(
			/if \(dep\.status !== 0\) \{[\s\S]{0,200}servicesVerified = false;/
		);
		expect(src, 'a failed MCP restart').toMatch(
			/if \(rs\.status !== 0\) \{[\s\S]{0,200}servicesVerified = false;/
		);
		// The restart step's own verdict (test/upgradeServicesVerified.test.ts)
		// is where the last lines start from.
		expect(src, 'the restart step').toMatch(/let servicesVerified = restartsDone\.verified;/);
	});

	it('the snapshot mirror run by hand says it is reading the chain while it does (piped into the upgrade: not)', async () => {
		const d = tmp();
		const bin = join(d, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'ipfs'),
			'#!/bin/sh\ncase "$*" in *id*) echo 12D3KooWTest ;; esac\nexit 0\n',
			{ mode: 0o755 }
		);
		writeFileSync(
			join(bin, 'runuser'),
			'#!/bin/sh\nshift 2; [ "$1" = "--" ] && shift; exec "$@"\n',
			{
				mode: 0o755
			}
		);
		// An RPC node that accepts and never answers: the read hangs.
		const { createServer } = await import('node:net');
		const held: import('node:net').Socket[] = [];
		const srv = createServer((s) => void held.push(s));
		await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
		const port = (srv.address() as { port: number }).port;
		const pub = JSON.parse(
			spawnSync('node', ['ops/test/lib/signed-snapshot-op.mjs', '{"x":1}'], {
				cwd: REPO,
				encoding: 'utf8'
			}).stdout
		).pubkey as string;
		const env = {
			PATH: `${bin}:${process.env.PATH ?? ''}`,
			MORPHIT_SNAPSHOT_MIRROR_STATE: join(d, 'state.json'),
			MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused',
			MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
			MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://harness.invalid',
			MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: pub,
			MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: `http://127.0.0.1:${port},http://localhost:${port}`,
			MORPHIT_INDEXER_RPC_ENDPOINTS: '',
			MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: '',
			MORPHIT_INDEXER_LOCAL_RPC_AUTODETECT: '0'
		};
		const cmd = `${join(REPO, 'node_modules/.bin/tsx')} --tsconfig ${join(REPO, 'tsconfig.smoke.json')} ${join(REPO, 'apps/indexer/scripts/snapshot-mirror.ts')} --signer morphit`;
		try {
			const tty = commandInTerminal(cmd, { env, timeoutMs: 15_000, cwd: REPO });
			expect(tty).toMatch(
				/[⠀-⣿] snapshot-mirror: reading @morphit's chain history for the newest indexer_snapshot_v1…/
			);
			const piped = spawnSync('sh', ['-c', cmd], {
				encoding: 'utf8',
				timeout: 15_000,
				cwd: REPO,
				env: { ...process.env, ...env }
			});
			expect(`${piped.stdout}${piped.stderr}`).not.toMatch(/chain history/);
		} finally {
			for (const s of held) s.destroy();
			srv.close();
		}
	}, 60_000);
});

describe('the served frontend is "checked" only when it was seen (step 9d)', () => {
	it('a bare-metal web root still serving the old build: not verified, and a warning says what to do', async () => {
		const d = tmp();
		const build = join(d, 'build');
		const webRoot = join(d, 'www');
		mkdirSync(build);
		mkdirSync(webRoot);
		writeFileSync(join(build, 'verify.json'), JSON.stringify({ morphit_version: '1.21.2' }));
		writeFileSync(join(webRoot, 'verify.json'), JSON.stringify({ morphit_version: '1.21.1' }));
		let verified: boolean | null = null;
		const out = await captured(async () => {
			verified = await verifyServedFrontend(
				{ copyToWebRoot: true, restartContainer: null },
				build,
				webRoot
			);
		});
		expect(verified).toBe(false);
		expect(out).toMatch(
			/\[WARN\] The frontend being SERVED is still the old build \(version 1\.21\.1\)/
		);
		writeFileSync(join(webRoot, 'verify.json'), JSON.stringify({ morphit_version: '1.21.2' }));
		const ok = await captured(async () => {
			verified = await verifyServedFrontend(
				{ copyToWebRoot: true, restartContainer: null },
				build,
				webRoot
			);
		});
		expect(verified).toBe(true);
		expect(ok).toMatch(/✓ Verified the live frontend is serving this build/);
	});
});

describe('the WAF body-limit check asks THIS server even with a proxy in the environment (A-F10)', () => {
	it('curl is told to skip https_proxy / ALL_PROXY, so --resolve reaches 127.0.0.1', async () => {
		const d = tmp();
		spawnSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=morphit.test',
				'-keyout',
				join(d, 'k.pem'),
				'-out',
				join(d, 'c.pem')
			],
			{ stdio: 'ignore' }
		);
		// BunkerWeb on this server, in its own process (the probe's curl runs
		// synchronously): it answers every POST with 413.
		writeFileSync(
			join(d, 'srv.mjs'),
			[
				"import https from 'node:https'; import fs from 'node:fs';",
				`const s = https.createServer({ key: fs.readFileSync(${JSON.stringify(join(d, 'k.pem'))}), cert: fs.readFileSync(${JSON.stringify(join(d, 'c.pem'))}) },`,
				'  (q, r) => { q.resume(); q.on("end", () => { r.statusCode = 413; r.end(); }); });',
				"s.listen(0, '127.0.0.1', () => console.log('port', s.address().port));"
			].join('\n')
		);
		const srv = spawn(process.execPath, [join(d, 'srv.mjs')], {
			stdio: ['ignore', 'pipe', 'ignore']
		});
		const port = await new Promise<number>((res) => {
			let buf = '';
			srv.stdout.on('data', (b: Buffer) => {
				buf += b;
				const m = /port (\d+)/.exec(buf);
				if (m) res(Number(m[1]));
			});
		});
		const keys = ['https_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'no_proxy', 'NO_PROXY'];
		const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		// A proxy nobody answers on: a request that goes through it gets nothing.
		for (const k of ['https_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'])
			process.env[k] = 'http://127.0.0.1:9';
		process.env.no_proxy = '';
		process.env.NO_PROXY = '';
		try {
			const candidates = bodyProbeCandidates(`https://morphit.test:${port}`, true)!;
			expect(candidates[0]).toEqual({
				url: `https://morphit.test:${port}/v1/broadcast`,
				resolve: `morphit.test:${port}:127.0.0.1`
			});
			expect(probeBroadcastBody(candidates)).toBe('413');
		} finally {
			for (const k of keys) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
			srv.kill();
		}
	}, 30_000);

	it('on a hidden-only node it never asks the address through public DNS', () => {
		for (const origin of ['https://morphit.io', 'https://example.org:8443']) {
			const c = bodyProbeCandidates(origin, true)!;
			expect(c.length).toBeGreaterThan(0);
			expect(c.every((x) => x.resolve !== null && x.resolve.endsWith(':127.0.0.1'))).toBe(true);
		}
		expect(bodyProbeCandidates('http://203.0.113.5', true)).toEqual([]);
	});
});

describe('release notes are shown as plain text (A-F10)', () => {
	it('a "conceal" style (or any colour) in the notes cannot hide the lines after it', async () => {
		const logged: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
			logged.push(`${a.map(String).join(' ')}\n`);
		});
		await captured(() =>
			showReleaseNotes(
				'# v9\n\nOne fix.\x1b[8m\nHidden line\x1b]0;title\x07x\n\x1b[30;40mblack on black\x1b[0m\n## Other\nmore\n',
				() => 'https://git.example/rel/v9\x1b[8m'
			)
		);
		vi.restoreAllMocks();
		const out = logged.join('');
		expect(out).not.toMatch(/\x1b/);
		expect(out).toMatch(/One fix\.\n {2}Hidden line/);
		expect(out).toMatch(/black on black/);
		expect(out).toMatch(/… the full notes: https:\/\/git\.example\/rel\/v9\n/);
	});
	it('sanitizeForTerm drops conceal everywhere, and keeps the colours morphit-ops prints', () => {
		expect(sanitizeForTerm('a\x1b[8mb')).toBe('ab');
		expect(sanitizeForTerm('a\x1b[1;8;31mb')).toBe('ab');
		expect(sanitizeForTerm('\x1b[33m⚠\x1b[0m x')).toBe('\x1b[33m⚠\x1b[0m x');
		// 256-colour 8 (grey) is a colour, not conceal.
		expect(sanitizeForTerm('\x1b[38;5;8mgrey\x1b[0m')).toBe('\x1b[38;5;8mgrey\x1b[0m');
		expect(plainText('\x1b[33m⚠\x1b[0m x')).toBe('⚠ x');
	});
});

describe('the IPFS gateway check run by the upgrade (output piped)', () => {
	it('when it cannot confirm the frontend reaches the gateway, it says so (with what to do)', async () => {
		const d = tmp();
		const bin = join(d, 'bin');
		mkdirSync(bin);
		const s = (name: string, body: string): void =>
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		s(
			'docker',
			[
				'case "$1" in',
				'  ps) echo abc ;;',
				'  inspect) case "$*" in *Mounts*) echo /opt/morphit/apps/web/build ;; *".Name"*) echo /fe-1 ;; esac ;;',
				'  exec) echo "wget: download timed out"; exit 1 ;;',
				'esac',
				'exit 0'
			].join('\n')
		);
		s('ipfs', 'echo /ip4/0.0.0.0/tcp/8082');
		s('ss', 'echo "LISTEN 0 4096 0.0.0.0:8082 0.0.0.0:*"');
		s('ufw', 'echo "Status: inactive"');
		s('iptables', 'exit 1');
		s('sleep', 'exit 0');
		const saved = process.env.PATH;
		process.env.PATH = `${bin}:${saved ?? ''}`;
		process.env.MORPHIT_STEP_LOG_DIR = join(d, 'log');
		try {
			const out = await captured(() =>
				runStepWithSpinner(
					'Checking the frontend can reach this box’s IPFS gateway…',
					'sh',
					[join(REPO, 'ops', 'ipfs', 'morphit-gateway-firewall-heal.sh')],
					{ timeoutMs: 60_000 }
				)
			);
			expect(out).toMatch(/• Could not confirm the frontend can reach the gateway on 8082\./);
			expect(out).toMatch(/sudo ufw allow from 172\.20\.0\.0\/16 to any port 8082 proto tcp/);
		} finally {
			process.env.PATH = saved;
			delete process.env.MORPHIT_STEP_LOG_DIR;
		}
	}, 60_000);
});

describe('morphit-ops status: the web heal row', () => {
	it('"already in place" with warnings is never called "applied" (A-F8)', async () => {
		const { renderWebHealSection } = await import('../src/commands/status.ts');
		const t = '2026-10-06T12:00:00.000Z';
		const show = (result: string): Promise<string> =>
			captured(() =>
				renderWebHealSection(
					{ state: 'done', startedAt: t, finishedAt: t, result, warnings: 2 },
					Date.parse(t)
				)
			);
		const already = await show('already');
		expect(already).toMatch(/Privacy settings:\s+in place, with warnings\s+\[WARN\]/);
		expect(already).not.toMatch(/applied/);
		expect(already).toMatch(/already in place .*2 warnings, see on this server: sudo cat/);
		expect(await show('applied')).toMatch(/Privacy settings:\s+applied, with warnings\s+\[WARN\]/);
		expect(await captured(() => renderWebHealSection(null))).toBe('');
	});
});

describe('a heal result with no producer is not folded away', () => {
	it('"deferred-quietly" is not a routine strategy (nothing produces it)', () => {
		expect(isRoutineHeal({ strategy: 'deferred-quietly', verified: true, detail: '' })).toBe(false);
		expect(isRoutineHeal({ strategy: 'already', verified: true, detail: '' })).toBe(true);
	});
});
