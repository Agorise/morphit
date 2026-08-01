/**
 * morphit-ops harden (cp187) — a focused, re-runnable hardening
 * wizard.
 *
 * Hardening was previously reachable ONLY as the tail of the
 * `init` setup wizard (stepBunkerWeb + stepHardening), so an
 * operator who wanted to revisit "how do I set up BunkerWeb / the
 * firewall / backups / TLS" later had nowhere to go.  This command
 * surfaces all of it on demand, as its own menu, and is the menu
 * entry behind "Harden this server" in bare `morphit-ops`.
 *
 * Design (no duplication, no drift):
 *   - The actual hardening WORK lives in the shipped Ansible role
 *     (ops/ansible/roles/hardening + tls), the nginx/bunkerweb
 *     configs (ops/nginx, ops/bunkerweb), the backup units
 *     (ops/backup, ops/systemd), and the reference docs
 *     (OPERATIONS.md §32/§34/§35/§37).  This command does NOT
 *     re-implement any of it.
 *   - It REUSES the same explanatory step functions the init
 *     wizard uses (stepBunkerWeb, stepHardening, stepBackup) so the
 *     guidance an operator sees here is byte-identical to setup.
 *   - It REUSES the exported renderHardeningChecklist to (re)write
 *     a personalized morphit-hardening-checklist.md — the "do it
 *     FOR the admin" artifact — pre-filled from the existing config
 *     (instance name + origin + current BunkerWeb choice) when one
 *     is present.
 *
 * It never edits morphit.config.env itself (that is `edit`'s job
 * and `init`'s job); the one config knob hardening drives —
 * MORPHIT_RELAY_TRUSTED_PROXY_IPS for BunkerWeb — is surfaced as an
 * instruction, because flipping it standalone without re-running the
 * BunkerWeb decision in context would be a footgun.
 */

import { writeFileSync, existsSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { readDeployedDatabaseUrl } from '../lib/dbContainer.ts';
import { resolve, join, dirname } from 'node:path';

import { askChoice } from '../init/prompt.ts';
import { stepBunkerWeb, stepHardening, stepBackup } from '../init/steps.ts';
import { renderHardeningChecklist, renderBackupEnv } from '../init/render.ts';
import { sanitizeForTerm } from '../render/term.ts';

export interface HardenCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

interface ExistingInstance {
	readonly instanceName: string;
	readonly origin: string | null;
	readonly bunkerWebEnabled: boolean;
}

/** Best-effort read of the few config values the checklist needs.
 *  Absent file or keys → sensible placeholders, so `harden` works
 *  even before `init` has run (the operator just gets a generic
 *  checklist they can regenerate later). */
function loadExistingInstance(configPath: string): ExistingInstance {
	if (!existsSync(configPath)) {
		return { instanceName: 'my Morphit instance', origin: null, bunkerWebEnabled: false };
	}
	const text = readFileSync(configPath, 'utf-8');
	const kv = new Map<string, string>();
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (t.length === 0 || t.startsWith('#')) continue;
		const eq = t.indexOf('=');
		if (eq === -1) continue;
		const k = t.slice(0, eq).trim();
		let v = t.slice(eq + 1).trim();
		// strip one layer of surrounding quotes if present
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		kv.set(k, v);
	}
	// A non-commented MORPHIT_RELAY_TRUSTED_PROXY_IPS set to the
	// pinned BunkerWeb network is our signal that BunkerWeb was
	// chosen at setup.  (When BunkerWeb is off, init writes that
	// line commented out.)
	const trusted = kv.get('MORPHIT_RELAY_TRUSTED_PROXY_IPS') ?? '';
	return {
		instanceName: kv.get('MORPHIT_INSTANCE_NAME') ?? 'my Morphit instance',
		origin: kv.get('MORPHIT_INSTANCE_ORIGIN') ?? null,
		bunkerWebEnabled: trusted.includes('172.20.0.0/16')
	};
}

export async function runHarden(ctx: HardenCtx): Promise<number> {
	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const configPath = join(repoRoot, 'morphit.config.env');
	const existing = loadExistingInstance(configPath);

	console.log('');
	console.log('━'.repeat(58));
	console.log('  Harden this server');
	console.log('━'.repeat(58));
	console.log('');
	console.log('  Locking down the host is the most important thing you do');
	console.log('  before going public — and none of it is Morphit-specific:');
	console.log('  SSH, firewall, automatic security updates, TLS, and a WAF');
	console.log('  are the baseline every internet-facing Ubuntu box needs.');
	console.log('');
	console.log('  Everything below is already shipped in this repo (the');
	console.log('  Ansible role in ops/ansible/, the nginx + BunkerWeb configs,');
	console.log('  the backup units).  Pick what you want to walk through; the');
	console.log('  full reference is OPERATIONS.md §34 (UFW + fail2ban), §35');
	console.log('  (TLS), §37 (the complete hardening role).');
	console.log('');

	for (;;) {
		const choice = await askChoice('What would you like to do?', [
			'Generate / refresh my personalized hardening checklist (recommended first step)',
			'Walk through the full host checklist on screen (Ubuntu, SSH, UFW, fail2ban, updates, TLS)',
			'Set up BunkerWeb (reverse-proxy WAF in front of the stack)',
			'Set up automatic daily database backups',
			'Set up IPFS release hosting (help keep Morphit releases alive)',
			'Seed this release to IPFS now (make this box an origin host after an upgrade)',
			'Show the fully-automated path (Ansible playbook)',
			'Done'
		]);

		if (choice === 0) {
			await regenerateChecklist(repoRoot, existing);
		} else if (choice === 1) {
			// Reuse the exact init guidance (no drift).  stepHardening
			// prints the on-screen host walkthrough; we ignore its
			// return (the file-write is handled by option 0).
			await stepHardening(existing.bunkerWebEnabled);
		} else if (choice === 2) {
			await stepBunkerWeb();
			console.log(
				'  Note: enabling BunkerWeb also means the relay should trust its\n' +
					'  Docker network so it sees real client IPs.  On a fresh setup the\n' +
					'  wizard wires MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.20.0.0/16 for you;\n' +
					'  if you are adding BunkerWeb to an existing instance, set that key\n' +
					'  in morphit.config.env by hand (or re-run `morphit-ops init`) and\n' +
					'  restart the relay.  See OPERATIONS.md §32.\n'
			);
		} else if (choice === 3) {
			// Pass the deployed connection URL so the backup targets the real DB
			// (non-standard boxes on morphit_user/morphit_db work without editing).
			const backup = await stepBackup(readDeployedDatabaseUrl(repoRoot) ?? '');
			if (backup.enabled) {
				// cp514 — this whole block used to print THREE steps that could not
				// work: it never installed the script (the unit's ExecStart is a
				// hardcoded /usr/local/lib/morphit path) nor the .service/.timer unit
				// files, so `systemctl enable --now morphit-backup.timer` failed with
				// "Unit morphit-backup.service not found"; it pointed at the GENERIC
				// backup.env.example, discarding the container + DB identity detected
				// moments earlier; and its paths were relative, so they only worked
				// from the repo root. Print the same complete, absolute sequence
				// `init` does, and write a populated env file to install FROM.
				const backupEnvPath = join(repoRoot, 'ops', 'backup', 'backup.env');
				mkdirSync(dirname(backupEnvPath), { recursive: true });
				writeFileSync(backupEnvPath, renderBackupEnv(backup), { mode: 0o600 });
				chmodSync(backupEnvPath, 0o600);
				const backupDir = backup.backupDir ?? '/home/morphit/backups';
				console.log(`  ✓ wrote ${sanitizeForTerm(backupEnvPath)}`);
				console.log('');
				console.log('  To activate the shipped backup timer, run these in order:');
				console.log('');
				console.log(
					`    sudo install -m 640 -o root -g morphit ${sanitizeForTerm(backupEnvPath)} /etc/morphit/backup.env`
				);
				console.log('    sudo install -d -m 755 /usr/local/lib/morphit');
				console.log(
					`    sudo install -m 755 ${sanitizeForTerm(join(repoRoot, 'ops', 'backup', 'morphit-backup.sh'))} /usr/local/lib/morphit/`
				);
				console.log(
					`    sudo install -m 644 ${sanitizeForTerm(join(repoRoot, 'ops', 'systemd', 'morphit-backup.service'))} /etc/systemd/system/`
				);
				console.log(
					`    sudo install -m 644 ${sanitizeForTerm(join(repoRoot, 'ops', 'systemd', 'morphit-backup.timer'))} /etc/systemd/system/`
				);
				console.log('    sudo systemctl daemon-reload');
				console.log('    sudo systemctl enable --now morphit-backup.timer');
				console.log('');
				console.log('  Then PROVE it dumps — a working run prints a byte count:');
				console.log('');
				console.log('    sudo systemctl start morphit-backup.service');
				console.log('    sudo journalctl -u morphit-backup.service -e --no-pager');
				console.log(`    sudo ls -lh ${sanitizeForTerm(backupDir)}`);
				console.log('');
				if (backup.dbContainer !== null) {
					console.log('  Your Postgres runs in a container, so the dump goes through');
					console.log('  `docker exec`. The unit runs as the morphit user, which must be');
					console.log('  able to reach docker — note this is root-equivalent access:');
					console.log('');
					console.log('    sudo usermod -aG docker morphit');
					console.log('');
				}
				console.log(`  If ${sanitizeForTerm(backupDir)} already exists owned by root (an`);
				console.log('  earlier root-run backup script, say), hand it over or the');
				console.log('  morphit-user service cannot write into it:');
				console.log('');
				console.log(`    sudo chown -R morphit:morphit ${sanitizeForTerm(backupDir)}`);
				console.log('');
				console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md §9, OPERATIONS.md.');
				console.log('');
			}
		} else if (choice === 4) {
			// IPFS release hosting — every instance pins the signed release so
			// availability doesn't depend on any single pinning service. ON by
			// default on Ansible installs (the `ipfs` role); this sets it up on a
			// hand-managed box by running the shipped setup script.
			const setup = join(repoRoot, 'ops', 'ipfs', 'morphit-ipfs-setup.sh');
			console.log('');
			console.log('  Every Morphit instance runs a small IPFS (Kubo) node that pins THIS');
			console.log('  instance\'s current signed release, so Morphit\'s releases survive even');
			console.log('  if every commercial pinning service drops them. The release CID comes');
			console.log('  from your own /v1/release (learned from the chain) — no middleman.');
			console.log('  Low-footprint: the lowpower Kubo profile, capped connections, ~12 MB.');
			console.log('');
			console.log('  Ansible installs already get this (the `ipfs` role, on by default).');
			console.log('  On this hand-managed box, run the shipped setup (installs Kubo + the');
			console.log('  pinning service + timer, idempotent):');
			console.log('');
			console.log(`    sudo sh ${sanitizeForTerm(setup)}`);
			console.log('');
			console.log('  Then confirm + pin immediately:');
			console.log('');
			console.log('    systemctl status ipfs morphit-ipfs-pin.timer');
			console.log('    sudo systemctl start morphit-ipfs-pin.service');
			console.log('    journalctl -u morphit-ipfs-pin -e --no-pager');
			console.log('');
			console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
			console.log('');
		} else if (choice === 5) {
			// Seed THIS release to IPFS from this box — makes this node an ORIGIN
			// host of the current signed release (others pin from it). Run after an
			// upgrade, once /v1/release shows the new version, and after Kubo is set
			// up (the option above). The script re-stages the canonical directory,
			// `ipfs add`s it, and ASSERTS the CID equals the one /v1/release anchors
			// (fail-loud on a divergent CID), then announces it.
			const seed = join(repoRoot, 'ops', 'ipfs', 'morphit-ipfs-seed.sh');
			console.log('');
			console.log('  Seed THIS release from this box so it becomes an ORIGIN host — other');
			console.log('  instances then pin the release from you. Run this AFTER an upgrade,');
			console.log('  once /v1/release shows the new version, and after Kubo is set up (the');
			console.log('  option above). Pass the release tag:');
			console.log('');
			console.log(
				`    sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs sh ${sanitizeForTerm(seed)} vX.Y.Z`
			);
			console.log('');
			console.log('  It re-stages the exact release directory, adds it to IPFS, and ASSERTS');
			console.log('  the resulting CID matches the one your /v1/release anchors — refusing to');
			console.log('  seed a divergent CID — then announces it to the network.');
			console.log('');
			console.log('  Confirm it is publicly reachable (from anywhere, using the anchored CID):');
			console.log('');
			console.log('    curl -fsSL https://ipfs.io/ipfs/<cid>/metadata.json');
			console.log('');
			console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
			console.log('');
		} else if (choice === 6) {
			printAnsiblePath();
		} else {
			// Done
			console.log('');
			console.log('  Harden away.  Re-run `morphit-ops harden` (or just');
			console.log('  `morphit-ops` and pick "Harden this server") any time.');
			console.log('');
			return 0;
		}
	}
}

async function regenerateChecklist(repoRoot: string, existing: ExistingInstance): Promise<void> {
	// Let the operator confirm/override the BunkerWeb framing, since
	// the checklist's TLS + web-edge section differs for BunkerWeb vs
	// direct-nginx and we want the file to match their real topology.
	const idx = await askChoice(
		`Will BunkerWeb sit in front of this instance?  (detected from your config: ${
			existing.bunkerWebEnabled ? 'yes' : 'no'
		})`,
		[
			`Yes — BunkerWeb terminates TLS and fronts the stack`,
			`No — serving directly behind nginx/Caddy`
		],
		existing.bunkerWebEnabled ? 0 : 1
	);
	const bunkerWebEnabled = idx === 0;

	const content = renderHardeningChecklist({
		instanceName: existing.instanceName,
		origin: existing.origin,
		bunkerWebEnabled
	});
	const outPath = join(repoRoot, 'morphit-hardening-checklist.md');
	try {
		writeFileSync(outPath, content, { mode: 0o644 });
		chmodSync(outPath, 0o644);
	} catch (err) {
		console.log(
			`\n✗ Could not write the checklist: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}\n`
		);
		return;
	}
	console.log('');
	console.log(`  ✓ Wrote ${outPath} (0644 — a readable runbook, no secrets).`);
	console.log('  Open it in any editor and work through it before you expose');
	console.log('  the instance publicly.  It leads with the SSH-lockout safety');
	console.log('  rule and sequences every step with copy-paste commands.');
	console.log('');
}

function printAnsiblePath(): void {
	console.log('');
	console.log('  Fully-automated hardening (lowest-error path):');
	console.log('');
	console.log('    The playbook at ops/ansible/ applies SSH hardening,');
	console.log('    unattended-upgrades, sysctl, UFW + fail2ban, and TLS');
	console.log('    idempotently.  To use it:');
	console.log('      1. Edit ops/ansible/group_vars/all.yml — set the');
	console.log('         enable_* flags for the pieces you want.');
	console.log('      2. Run the playbook against this host.');
	console.log('');
	console.log('    This applies sections 1–3 of the checklist for you.');
	console.log('    Full reference: OPERATIONS.md §37.');
	console.log('');
}
