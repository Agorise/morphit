/**
 * assembleInstall.ts (cp600) — the ORCHESTRATION backbone of the grandma
 * install runner.  The interactive front-end (compose the wizard's account /
 * active-key / fees steps + collectInstallInputs) hands this a finished plan;
 * this drives the irreversible, order-sensitive part and is dependency-injected
 * so its safety invariants are unit-tested even though the real spawn + apt
 * can't run in CI.
 *
 * Invariants this guarantees (and the smoke pins):
 *   - the vars file (which contains the generated DB secrets) is written 0600;
 *   - the operator is made to SAVE those secrets BEFORE the playbook runs;
 *   - Ansible is confirmed present before we try to run it;
 *   - the playbook runs LOCALLY via the shared argv builder;
 *   - the secret-bearing vars file is ALWAYS removed afterwards — success OR
 *     failure (finally), so DB passwords never linger in a temp file;
 *   - a non-zero exit turns into a plain, reassuring message (a re-run is safe).
 */
import { writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync, readFileSync} from 'node:fs';
import { SUPPORT_EMAIL, SUPPORT_MATRIX } from './remediation.ts';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { buildAnsiblePlaybookArgv, renderVarsFile } from './ansibleVars.ts';
import { promptSaveSecrets, type SecretToSave } from './saveSecrets.ts';

/**
 * The one-command (Ansible) installer only provisions the Ubuntu 24.04 "noble"
 * base — the playbook keys its codename-pinned apt repos (Docker, Trivy) and its
 * package/config paths off `noble`, and asserts `morphit_ubuntu_codename ==
 * "noble"` up front (ops/ansible/playbook.yml).  Earlier Ubuntu (22.04 "jammy"),
 * Debian, LMDE, and non-Ubuntu bases fail that assertion.
 *
 * This is the SINGLE source of truth for the "you need a noble base" guidance:
 * it is shown BOTH by the early OS pre-check below (so the install stops before
 * writing secrets or running Ansible) AND by the playbook-failure backstop in
 * FAILURE_HINTS (so an install that somehow reaches the assertion still gets
 * this message instead of the support dead-end).  `os-support-parity-smoke`
 * keeps it in lockstep with the playbook's actual gate.
 *
 * NOTE: this gates the ONE-COMMAND path only.  systemCheck.ts intentionally
 * green-lights any sane Ubuntu/Debian-based OS because Morphit also supports
 * MANUAL installs on them (Kicksecure, Debian, …); those never come through
 * assembleInstall().
 */
export const NOBLE_ONLY_GUIDANCE =
	'The one-command installer provisions only the Ubuntu 24.04 "noble" base, ' +
	'or a noble-based derivative (Linux Mint 22, Pop!_OS 24.04, Zorin OS 17). ' +
	'This box is on a different base, so provisioning cannot continue. ' +
	'Install Morphit on a fresh Ubuntu 24.04 machine and re-run. ' +
	'(Advanced: a by-hand install on other Debian/Ubuntu bases is documented in OPERATIONS.md \u00a749.)';

/** Extract the Ubuntu base codename from /etc/os-release content, mirroring the
 *  playbook's derivation EXACTLY: the value of the `UBUNTU_CODENAME=` line
 *  (present on Ubuntu and its derivatives), lower-cased and unquoted; '' when
 *  absent (Debian/LMDE/non-Ubuntu).  PURE. */
export function ubuntuBaseCodename(osReleaseContent: string): string {
	for (const line of osReleaseContent.split('\n')) {
		const m = line.match(/^UBUNTU_CODENAME=(.*)$/);
		if (m) {
			let v = m[1]!.trim();
			if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
			return v.trim().toLowerCase();
		}
	}
	return '';
}

/** The one-command installer's OS pre-flight verdict.  Supported IFF the Ubuntu
 *  base codename is "noble" — byte-for-byte the same condition the playbook
 *  asserts.  PURE. */
export function checkNobleBase(osReleaseContent: string): { ok: boolean; codename: string } {
	const codename = ubuntuBaseCodename(osReleaseContent);
	return { ok: codename === 'noble', codename };
}

export interface PostInstallStep {
	/** Human-readable name for the "couldn't set this up" fallback message. */
	readonly label: string;
	/** argv to run (best-effort) after the playbook succeeds. */
	readonly argv: readonly string[];
}

export interface InstallPlan {
	/** group_vars/vault overrides from buildAnsibleVars(). */
	readonly vars: Record<string, unknown>;
	/** The generated secrets the operator must save (DB passwords, …). */
	readonly secretsToSave: readonly SecretToSave[];
	/** Absolute path to ops/ansible/playbook.yml on this box. */
	readonly playbookPath: string;
	/** Where to write the transient 0600 vars file. */
	readonly varsFilePath: string;
	/** Best-effort steps run AFTER a successful install (e.g. the desktop
	 *  upgrade notifier on a home box). A failure here never fails the install. */
	readonly postInstall?: readonly PostInstallStep[];
}

export interface AssembleDeps {
	readonly writeVarsFile?: (path: string, content: string) => void;
	readonly removeVarsFile?: (path: string) => void;
	readonly promptSave?: (secrets: readonly SecretToSave[]) => Promise<void>;
	/** Ensure `ansible-playbook` is runnable (apt-install if missing) AND the
	 *  required Galaxy collections are installed. Returns false if it still
	 *  isn't available. Given the ansible dir (to find collections/requirements.yml). */
	readonly ensureAnsible?: (ansibleDir: string) => Promise<boolean>;
	/** Run argv, streaming output; resolve with the process exit code. */
	readonly spawn?: (argv: readonly string[]) => Promise<number>;
	/** Resolve how many hosts the playbook targets (pre-flight guard). */
	readonly probeHosts?: (argv: readonly string[]) => ProbeResult;
	/** Read /etc/os-release (injected for the OS pre-check test). Defaults to the
	 *  real file; returns '' if it can't be read. */
	readonly readOsRelease?: () => string;
	readonly print?: (s: string) => void;
}

export type AssembleResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ─── Real (a mini PC-validated) implementations ────────────────────
function realWrite0600(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o600 });
}
function realRemove(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already gone — fine */
	}
}
async function realEnsureAnsible(ansibleDir: string): Promise<boolean> {
	// Pre-create the shared Ansible temp base (matching ANSIBLE_REMOTE_TEMP in
	// localAnsibleEnv) with sticky, world-writable perms like /tmp itself. If
	// Ansible had to create it, it would make the parent 0700 and warn "created
	// with a mode of 0700, this may cause issues when running as another user".
	// Creating it 1777 up front means every become-user (postgres, morphit, ipfs)
	// can write its own subdir and Ansible stays quiet.
	try {
		for (const d of ['/tmp/.ansible-morphit/tmp', '/tmp/.ansible-morphit/local']) {
			mkdirSync(d, { recursive: true });
			chmodSync(d, 0o1777);
		}
		chmodSync('/tmp/.ansible-morphit', 0o1777);
	} catch {
		// Best-effort — Ansible still falls back to a system temp dir if this
		// can't be created for some reason.
	}
	const have = spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' });
	// cp690 — a self-contained (offline) bundle ships ansible in its apt closure
	// (vendor/apt) and the galaxy collections it needs (vendor/ansible-collections).
	// ansibleDir is <bundleRoot>/ops/ansible, so the bundle's vendor/ dir is two
	// levels up. Install FROM the bundle with no network; reach apt/Galaxy only
	// when there's no bundle (a source-tarball install on an online box).
	const vendorApt = join(ansibleDir, '..', '..', 'vendor', 'apt');
	const vendorCollections = join(ansibleDir, '..', '..', 'vendor', 'ansible-collections');
	if (have.status !== 0) {
		if (existsSync(join(vendorApt, 'Packages'))) {
			// Offline: resolve ansible (+ its deps) from ONLY the bundled repo.
			const bl = '/etc/apt/sources.list.d/morphit-bundle-ansible.list';
			try {
				writeFileSync(bl, `deb [trusted=yes] file://${vendorApt} ./\n`, { mode: 0o644 });
				const aptBundleOpts = [
					'-o',
					`Dir::Etc::SourceList=${bl}`,
					'-o',
					'Dir::Etc::SourceParts=/dev/null',
					// The bundle lives under the operator's home (e.g.
					// /home/<user>/Downloads/morphit/vendor/apt), which the unprivileged
					// `_apt` sandbox user can't traverse — so apt prints a scary
					// "Download is performed unsandboxed as root ... Permission denied".
					// We already trust these local files (this is the operator's own
					// download), so tell apt to run as root from the start: it does the
					// exact same thing, minus the alarming notice.
					'-o',
					'APT::Sandbox::User=root'
				];
				spawnSync('apt-get', [...aptBundleOpts, '-o', 'APT::Get::List-Cleanup=0', 'update'], {
					stdio: 'inherit'
				});
				spawnSync('apt-get', [...aptBundleOpts, 'install', '-y', 'ansible'], { stdio: 'inherit' });
			} finally {
				try {
					unlinkSync(bl);
				} catch {
					/* already gone */
				}
			}
		} else {
			// No bundle — online install (source-tarball path on a connected box).
			spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });
			spawnSync('apt-get', ['install', '-y', 'ansible'], { stdio: 'inherit' });
		}
	}
	if (spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
	// The playbook uses community.general / community.postgresql / community.docker.
	// The apt `ansible` metapackage (9.x) already BUNDLES all three, so on the
	// common path they're present the moment ansible installs. Running
	// `ansible-galaxy collection install` anyway would try to resolve them from
	// the bundle's local tarballs and, when a tarball name/version doesn't line
	// up, print a scary "ERROR! ... Could not find <collection>.tar.gz" — even
	// though the collections are already usable and the play then succeeds
	// (failed=0). So: only install what's actually MISSING, and stay silent when
	// everything the playbook needs is already there.
	const NEEDED = ['community.general', 'community.postgresql', 'community.docker'];
	let installedList = '';
	{
		const r = spawnSync('ansible-galaxy', ['collection', 'list'], {
			stdio: ['ignore', 'pipe', 'ignore']
		});
		installedList = r.status === 0 ? String(r.stdout ?? '') : '';
	}
	const isPresent = (fqcn: string) =>
		new RegExp(`^${fqcn.replace('.', '\\.')}\\s+\\d`, 'm').test(installedList);
	const missing = NEEDED.filter((c) => !isPresent(c));
	if (missing.length > 0) {
		// At least one collection isn't available — resolve from the bundle
		// (local tarballs, no Galaxy/network) if present, else the repo's
		// requirements.yml (online Galaxy). Best-effort: if it still can't
		// resolve them, the playbook fails later with a clear "couldn't resolve
		// module", which is the actionable error — not this noise.
		const bundledReqs = join(vendorCollections, 'requirements.yml');
		const reqs = existsSync(bundledReqs)
			? bundledReqs
			: join(ansibleDir, 'collections', 'requirements.yml');
		if (existsSync(reqs)) {
			spawnSync('ansible-galaxy', ['collection', 'install', '-r', reqs], { stdio: 'inherit' });
		}
	}
	return true;
}
// The LOCAL grandma run inherits the parent env plus one addition: silence
// Ansible's "discovered Python interpreter at /usr/bin/pythonX.Y ... future
// installation could change the meaning" notice.  `auto_silent` still
// auto-discovers the interpreter — it just doesn't print a scary WARNING on a
// home operator's screen (there is exactly one Python here, and it isn't moving).
/** Where the full Ansible run is logged, so a failure can be summarised and the
 *  operator has a single file to send us. */
export const INSTALL_LOG_PATH = '/tmp/morphit-install-ansible.log';

/** Common Ansible-task failure signatures → a plain-English cause + fix. The
 *  point: even a failure we didn't pre-check for still yields something the
 *  admin can act on, instead of a rage-quit at raw output. PURE. */
const FAILURE_HINTS: ReadonlyArray<{ readonly re: RegExp; readonly hint: string }> = [
	{
		// The playbook's OS-gate assertion (ops/ansible/playbook.yml): the box is
		// not on the Ubuntu 24.04 "noble" base.  Match the task name AND the
		// assertion expression so a reworded fail_msg still classifies.  Without
		// this, a jammy/Debian box hit the "not in our known list → email support"
		// dead-end even though the fix (use 24.04) is clear (v1.15.4).
		re: /Verify target is Ubuntu 24\.04|morphit_ubuntu_codename\s*==\s*.?noble/i,
		hint: NOBLE_ONLY_GUIDANCE
	},
	{
		re: /could not connect to server|connection refused[\s\S]*5432|password authentication failed|role ".*" does not exist|database ".*" does not exist|psql:\s*error|the database system is starting up/i,
		hint: "The Postgres database couldn't be reached or authenticated. Make sure Postgres is running and the user + database in your connection string exist (re-run and say yes when the wizard offers to create them), and that the URL uses 127.0.0.1."
	},
	{
		re: /No module named|Could not import python module|libpq|python3?-apt/i,
		hint: 'A required Python module is missing. Install it (sudo apt install -y python3 python3-apt libpq-dev) and re-run.'
	},
	{
		re: /Failed to lock apt|Could not get lock \/var\/lib\/dpkg|dpkg was interrupted|E: Unable to acquire/i,
		hint: 'Another package manager holds the apt lock (often unattended-upgrades). Wait a minute, or run `sudo dpkg --configure -a`, then re-run.'
	},
	{
		re: /permission denied.*docker\.sock|permission denied while trying to connect to the Docker|docker:\s*Got permission denied/i,
		hint: 'This user can\'t talk to Docker. Add it to the docker group (sudo usermod -aG docker "$USER"), log out and back in, then re-run.'
	},
	{
		re: /Missing sudo password|a password is required|Incorrect sudo password|sudo: a terminal is required|Failed to become/i,
		hint: "The install needs sudo. Run it as a user with sudo (you'll be prompted), or set up passwordless sudo, then re-run."
	},
	{ re: /No space left on device/i, hint: 'The disk filled up. Free space (or attach a larger volume) and re-run.' },
	{
		re: /requires ansible[- ]?core|is not compatible with the current ansible|needs ansible.*version/i,
		hint: 'A collection needs a newer ansible-core. Upgrade Ansible (pipx install --include-deps ansible) and re-run.'
	},
	{
		re: /Temporary failure in name resolution|Could not resolve host|Failed to download|Connection timed out|TLS handshake/i,
		hint: "A network fetch failed (DNS or connectivity). Check the box's internet/DNS and re-run; on a censored/limited link, just retry."
	},
	{
		re: /Address already in use|bind.*:80|bind.*:443|port is already allocated/i,
		hint: 'Another service is already using a port Morphit needs (80/443). Stop or move it and re-run.'
	},
	{
		re: /could ?n.?t resolve module\/action|couldn.t resolve module|failed to (load|resolve) collection|collection .* (was )?not found|unable to load collection/i,
		hint: "A required Ansible collection couldn't be loaded. The release bundles them under ops/ansible/collections, so if you're on a censored or limited link that blocks Ansible Galaxy, that's fine — just re-run (the installer falls back to the bundled copies). If it persists, upgrade ansible-core to >= 2.15."
	}
];

/** Turn a failed Ansible run's log into a clear, actionable summary. PURE +
 *  tested. Names the failed task, quotes Ansible's message, maps it to a likely
 *  fix when we recognise it, and — only when we DON'T recognise it (a genuine
 *  dead-end) — points at support. */
export function summarizePlaybookFailure(logText: string, exitCode: number, logPath: string): string {
	const lines = logText.split('\n');
	let failedTask = '';
	let fatalLine = '';
	for (let i = 0; i < lines.length; i++) {
		if (/^fatal:|FAILED!|^failed:/.test(lines[i]!.trim())) {
			fatalLine = lines[i]!.trim();
			for (let j = i; j >= 0 && j > i - 60; j--) {
				const m = lines[j]!.match(/TASK \[([^\]]+)\]/);
				if (m) {
					failedTask = m[1]!.trim();
					break;
				}
			}
		}
	}
	const hint = FAILURE_HINTS.find((h) => h.re.test(logText))?.hint;
	const msg = fatalLine.match(/"msg":\s*"([^"]+)"/)?.[1] ?? fatalLine.match(/=>\s*(\{.*\}|.+)$/)?.[1];
	const out: string[] = [`The install stopped (Ansible exit ${exitCode}).`];
	if (failedTask) out.push(`Failed step: ${failedTask}`);
	if (msg) out.push(`Ansible said: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`);
	if (hint) {
		out.push(`\nLikely fix: ${hint}`);
		out.push(`\nFull log: ${logPath}`);
	} else {
		out.push(`\nFull log: ${logPath}`);
		out.push(
			`This one isn't in our known list — send that log to ${SUPPORT_EMAIL} or on Matrix ${SUPPORT_MATRIX} (preferred) and we'll pinpoint it fast.`
		);
	}
	return out.join('\n');
}

/** Map a Node system-error code to a plain cause + fix. */
function errnoHint(code: string): string | undefined {
	switch (code) {
		case 'ENOENT':
			return 'A required command or file was missing. Make sure git, curl, python3, and the Postgres client are installed, then re-run.';
		case 'EACCES':
		case 'EPERM':
			return 'Permission denied. Run the installer with sudo (or as a user that has it), then re-run.';
		case 'EADDRINUSE':
			return 'A port Morphit needs (80/443/5432) is already in use. Stop or move that service and re-run.';
		case 'ENOSPC':
			return 'The disk is full. Free space (or attach a larger volume) and re-run.';
		case 'ETIMEDOUT':
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
		case 'ECONNREFUSED':
			return "A network connection failed (DNS or connectivity). Check the box's internet/DNS and re-run; on a censored or limited link, just retry.";
		default:
			return undefined;
	}
}

/**
 * Turn ANY caught error into an actionable message — the GLOBAL backstop so no
 * failure anywhere in the wizard (including a bug in our own code) is ever a bare
 * stack trace or cryptic one-liner. Maps Node system errors + known Ansible
 * signatures to a fix, points at the run log when present, and only when nothing
 * matches points at support. PURE + tested.
 */
export function describeInstallError(err: unknown, logExists = false): string {
	const msg = err instanceof Error ? err.message : String(err);
	const code =
		err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
	const hint = errnoHint(code) ?? FAILURE_HINTS.find((h) => h.re.test(msg))?.hint;
	const out: string[] = ['The install hit an unexpected problem and stopped.'];
	out.push(`Details: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`);
	if (hint) out.push(`\nLikely fix: ${hint}`);
	if (logExists) out.push(`\nFull run log: ${INSTALL_LOG_PATH}`);
	if (!hint) {
		out.push(
			`\nSend the above${logExists ? ' and the log' : ''} to ${SUPPORT_EMAIL} or on Matrix ${SUPPORT_MATRIX} (preferred) and we'll get you online.`
		);
	}
	out.push("\nNothing is left half-installed that a re-run can't recover \u2014 you can safely run the installer again.");
	return out.join('\n');
}

function localAnsibleEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		ANSIBLE_PYTHON_INTERPRETER: 'auto_silent',
		// Keep Ansible's temp files OUT of each service user's home dir. By
		// default Ansible uses `~/.ansible/tmp` for the become-user (postgres,
		// morphit, ipfs). Those homes (/var/lib/postgresql, /var/lib/morphit, …)
		// either can't be created or get made 0700, and Ansible prints scary
		// "[Errno 13] Permission denied: '/var/lib/morphit/.ansible'" and
		// "created with a mode of 0700, this may cause issues" warnings — even
		// though the run succeeds. A shared base under /tmp, plus world-readable
		// tmpfiles so a become-user can read what root staged, produces neither
		// warning. The dir is cleaned up per run; nothing sensitive lingers.
		ANSIBLE_REMOTE_TEMP: '/tmp/.ansible-morphit/tmp',
		ANSIBLE_LOCAL_TEMP: '/tmp/.ansible-morphit/local',
		// Capture the whole run to a log so a failure can be summarised into a
		// clear, actionable message (and so the operator has one file to send us)
		// instead of leaving them to scroll a wall of raw Ansible output.
		ANSIBLE_LOG_PATH: INSTALL_LOG_PATH,
		ANSIBLE_ALLOW_WORLD_READABLE_TMPFILES: 'True',
		// A single-admin appliance install shouldn't dump Ansible's deprecation /
		// system-config chatter on the operator's screen — it reads like errors
		// to someone who isn't an Ansible user. Real task failures are unaffected.
		ANSIBLE_DEPRECATION_WARNINGS: 'False',
		ANSIBLE_SYSTEM_WARNINGS: 'False',
		ANSIBLE_LOCALHOST_WARNING: 'False'
	};
}

/** Remind the operator after this many ms of total silence from the run, so a
 *  long download / DB migration / first cert never looks like a dead hang. */
export const QUIET_REMIND_MS = 3 * 60 * 1000;

/** PURE + tested: has the run been silent long enough to reassure the operator? */
export function shouldRemindQuiet(now: number, lastOutput: number, softMs = QUIET_REMIND_MS): boolean {
	return now - lastOutput >= softMs;
}

async function realSpawn(argv: readonly string[]): Promise<number> {
	const [cmd, ...args] = argv;
	if (cmd === undefined) return 1;
	return await new Promise<number>((resolve) => {
		// Pipe stdout/stderr so we can (a) mirror them live to the terminal and
		// (b) know when the run goes quiet — but keep stdin INHERITED so Ansible
		// can still prompt for a sudo password if it ever needs one. Ansible also
		// writes ANSIBLE_LOG_PATH independently, so the failure summary is intact.
		const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], env: localAnsibleEnv() });
		let lastOutput = Date.now();
		const tee = (chunk: Buffer, out: NodeJS.WriteStream): void => {
			out.write(chunk);
			lastOutput = Date.now();
		};
		child.stdout?.on('data', (c: Buffer) => tee(c, process.stdout));
		child.stderr?.on('data', (c: Buffer) => tee(c, process.stderr));
		// No-output watchdog: if the run has been silent for a few minutes, print a
		// calm reassurance (with the recommendation: just wait) so a slow step never
		// looks frozen. It does NOT interrupt or kill — a long migration is normal;
		// killing would be worse — and a re-run is always safe if the operator does
		// choose to stop. This is the "hold her hand through a quiet moment" step.
		const watchdog = setInterval(() => {
			if (shouldRemindQuiet(Date.now(), lastOutput)) {
				process.stdout.write(
					'\n  \u23f3 Still working \u2014 this step has been quiet for a few minutes. That is normal\n' +
						'     for a big download, a first-time database migration, or issuing your HTTPS\n' +
						'     certificate. It will continue on its own \u2014 you do not need to do anything.\n' +
						'     (Recommended: just wait. If you ever do want to stop, press Ctrl-C \u2014 re-running\n' +
						'     the installer later is always safe.)\n\n'
				);
				lastOutput = Date.now(); // re-arm for the next quiet stretch, don't nag every tick
			}
		}, 30 * 1000);
		if (typeof watchdog.unref === 'function') watchdog.unref();
		child.on('error', () => {
			clearInterval(watchdog);
			resolve(1);
		});
		child.on('close', (code) => {
			clearInterval(watchdog);
			resolve(code ?? 1);
		});
	});
}
/** Resolve how many hosts the playbook's pattern matches WITHOUT running it
 *  (`--list-hosts`).  Ansible prints "hosts (N):" per play; take the max.
 *  Returns 0 when the pattern matches nothing — the exact pre-flight that would
 *  have caught the inline-inventory `morphit_servers` mismatch. */
/** Raw result of the --list-hosts pre-flight: the exit code AND the output.
 *  Capturing the exit code is the whole fix — a FAILED list-hosts must not be
 *  misread as "0 hosts matched". */
export interface ProbeResult {
	readonly exitCode: number;
	readonly output: string;
}

/** Pull the most useful error line out of ansible's output. PURE + tested. */
export function extractAnsibleError(output: string): string {
	const lines = output
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const err = lines.find((l) =>
		/^ERROR!|^fatal:|could ?n.?t resolve|could not (?:find|open)|no such file|not find|syntax error|undefined variable|couldn.t parse|is not a valid|failed to load/i.test(
			l
		)
	);
	return err ?? lines[lines.length - 1] ?? '';
}

/** Decide the pre-flight verdict. PURE + tested. Distinguishes THREE cases that
 *  used to collapse into one misleading "0 hosts" message:
 *   1. the list-hosts command FAILED (missing collection, stray ansible.cfg,
 *      undefined var, incompatible Ansible) → surface the REAL error;
 *   2. it ran cleanly but matched 0 hosts → a genuine host-pattern/vars problem;
 *   3. it matched ≥1 host → proceed. */
export function interpretProbeResult(r: ProbeResult): {
	readonly ok: boolean;
	readonly count: number;
	readonly reason?: string;
} {
	let count = 0;
	for (const m of r.output.matchAll(/hosts \((\d+)\):/g)) count = Math.max(count, Number(m[1]));
	if (count >= 1) return { ok: true, count };

	if (r.exitCode !== 0) {
		const err = extractAnsibleError(r.output);
		return {
			ok: false,
			count,
			reason:
				`The installer's pre-flight check could not run (ansible-playbook --list-hosts exited ${r.exitCode}). ` +
				`This is a fixable environment issue on this machine, not something you did.` +
				(err ? `\n  Ansible said: ${err}` : '') +
				`\n  Common causes: a missing Ansible collection, a stray ~/.ansible.cfg or ANSIBLE_* env var, ` +
				`or an incompatible Ansible version. The morphit-node-doctor.sh script pinpoints and fixes most of ` +
				`these — run it, then run the installer again.`
		};
	}
	return {
		ok: false,
		count,
		reason:
			'The installer ran its pre-flight cleanly but Ansible matched 0 hosts — the generated vars file is ' +
			'missing `morphit_target_hosts` (an old or partial build). Please report this with the ' +
			'morphit-node-doctor.sh report.'
	};
}

/** Run `--list-hosts` and capture BOTH the exit code and the output. */
function realProbeHosts(argv: readonly string[]): ProbeResult {
	const [cmd, ...args] = argv;
	if (cmd === undefined) return { exitCode: 1, output: '' };
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: localAnsibleEnv() });
	return { exitCode: r.status ?? 1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** Drive the plan.  Order + cleanup are the whole point — see the header. */
export async function assembleInstall(plan: InstallPlan, deps: AssembleDeps = {}): Promise<AssembleResult> {
	const print = deps.print ?? ((s: string): void => console.log(s));
	const writeVarsFile = deps.writeVarsFile ?? realWrite0600;
	const removeVarsFile = deps.removeVarsFile ?? realRemove;
	const promptSave = deps.promptSave ?? promptSaveSecrets;
	const ensureAnsible = deps.ensureAnsible ?? realEnsureAnsible;
	const spawn = deps.spawn ?? realSpawn;
	const probeHosts = deps.probeHosts ?? realProbeHosts;
	const readOsRelease =
		deps.readOsRelease ??
		((): string => {
			try {
				return readFileSync('/etc/os-release', 'utf8');
			} catch {
				return '';
			}
		});

	// 0. OS PRE-CHECK (honest pre-flight): the playbook only provisions the
	//    Ubuntu 24.04 "noble" base.  Stop HERE — before writing the secret-
	//    bearing vars file or running Ansible — when the base is anything else,
	//    so the admin gets the "use 24.04" guidance up front instead of hitting
	//    the playbook's fatal assertion several steps in (v1.15.4).  Only gate
	//    when os-release is actually readable AND names a non-noble base; an
	//    absent/unreadable file falls through to the playbook's own assertion
	//    rather than blocking a box we couldn't classify.
	const osRelease = readOsRelease();
	if (osRelease.trim().length > 0) {
		const base = checkNobleBase(osRelease);
		if (!base.ok) {
			return {
				ok: false,
				reason:
					`${NOBLE_ONLY_GUIDANCE}` +
					(base.codename ? ` (detected Ubuntu base: "${base.codename}")` : '')
			};
		}
	}

	// 1. Write the vars file FIRST (0600 — it carries the DB secrets).
	writeVarsFile(plan.varsFilePath, renderVarsFile(plan.vars));
	try {
		// 2. Make the operator save the generated secrets BEFORE we install —
		//    if anything later fails, they already have their copy.
		await promptSave(plan.secretsToSave);

		// 3. Ansible must be runnable.
		const haveAnsible = await ensureAnsible(dirname(plan.playbookPath));
		if (!haveAnsible) {
			return {
				ok: false,
				reason: 'Ansible could not be installed automatically. Install it with `sudo apt-get install -y ansible`, then run this again.'
			};
		}

		// 3b. PRE-FLIGHT: confirm the playbook's host pattern actually matches a
		//     machine before we run — and before we ever tell the operator it
		//     "worked". Ansible exits 0 on a 0-host play, so without this a
		//     host-pattern mismatch silently installs NOTHING (the bug this fixes).
		const probeArgv = buildAnsiblePlaybookArgv({
			playbookPath: plan.playbookPath,
			varsFilePath: plan.varsFilePath,
			listHosts: true
		});
		const probeVerdict = interpretProbeResult(probeHosts(probeArgv));
		if (!probeVerdict.ok) {
			return {
				ok: false,
				reason: probeVerdict.reason ?? 'The installer pre-flight did not pass.'
			};
		}

		// 4. Run the playbook against THIS box.
		print('\n  Setting up your node \u2014 this takes several minutes. Ansible\u2019s progress is below.\n');
		// Start the run log fresh so the failure summary reflects THIS run only.
		try {
			writeFileSync(INSTALL_LOG_PATH, '');
		} catch {
			/* non-fatal — summary just falls back to the exit code */
		}
		const argv = buildAnsiblePlaybookArgv({ playbookPath: plan.playbookPath, varsFilePath: plan.varsFilePath });
		const code = await spawn(argv);
		if (code !== 0) {
			let log = '';
			try {
				log = readFileSync(INSTALL_LOG_PATH, 'utf8');
			} catch {
				/* no log — summarizer degrades to just the exit code */
			}
			return {
				ok: false,
				reason: summarizePlaybookFailure(log, code, INSTALL_LOG_PATH)
			};
		}

		// Best-effort post-install steps (e.g. the desktop upgrade notifier on a
		// home box). A failure here does NOT fail the install — the node is up —
		// but we tell the operator how to do it later.
		for (const item of plan.postInstall ?? []) {
			const rc = await spawn(item.argv);
			if (rc !== 0) {
				print(`\n  Note: couldn\u2019t set up ${item.label} automatically (not essential).`);
				print(`  You can do it later with:  ${item.argv.join(' ')}`);
			}
		}
		return { ok: true };
	} finally {
		// 5. NEVER leave the DB secrets sitting in a temp file.
		removeVarsFile(plan.varsFilePath);
	}
}
