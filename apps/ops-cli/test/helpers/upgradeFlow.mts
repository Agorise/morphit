/**
 * Drive the real runUpgrade through a whole flow, in its own process, with
 * stand-in system programs on PATH (no systemd, docker, npm or network), a
 * scratch install of v1.21.16 and a v1.21.17 tarball signed by a test key the
 * run pins. Usage: tsx upgradeFlow.mts <mode> <scratch dir>
 *   slow-tar  — the unpack takes 20 s (a signal can arrive meanwhile); --yes
 *   rollback  — npm fails, so the upgrade rolls back; --yes
 *   network   — no --from-file; every release source refuses the connection
 *   download  — no --from-file; the release host (DL_HOST) lists the release
 *               but its download fails
 *   prompt    — no --yes: the confirmation question (stdin as given)
 *   happy     — --yes; a self-contained release (prebuilt frontend and
 *               dependencies, a heal phase that does nothing) installs to the end
 * The modes below install the same self-contained release (--yes), with the
 * indexer and relay running (a stand-in systemctl), each with one slow step a
 * signal can arrive in; the step writes <scratch>/<marker> when it starts:
 *   slow-heal     — the new release's heal phase (20 s; its pid in
 *                   the marker; FLOW_HEAL_TRAPS=1: it exits 130
 *                   on Ctrl+C itself)                             heal-started
 *   slow-restart  — the watch after the indexer's restart        restart-started
 *   slow-frontend — the frontend container's rebuild (20 s; a
 *                   container that bind-mounts the build runs)   compose-started
 *   slow-mcp      — the MCP server's update, after every service
 *                   runs the new release (20 s)                   mcp-started
 *   late-signal   — the unpack fails, and a SIGHUP arrives 0.1 s
 *                   after it ended (a signal its exit beat)       —
 *   step-log      — a non-fatal build step fails, then the
 *                   indexer does not stay up (a rollback)         —
 *   canary-prompt — no --yes (at a terminal: the canary question
 *                   comes after the install)                      —
 * Prints "=== exit code N" and "=== release-info: …" at the end.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';

const mode = process.argv[2] ?? 'rollback';
const S = process.argv[3]!;
const gpg = (home: string, args: string[]) =>
	spawnSync(
		'gpg',
		['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
		{ encoding: 'utf8' }
	);
const gnupg = join(S, 'gnupg');
mkdirSync(gnupg, { recursive: true, mode: 0o700 });
gpg(gnupg, ['--quick-gen-key', 'Test <t@example.invalid>', 'ed25519', 'sign', 'never']);
const pub = gpg(gnupg, ['--armor', '--export', 'Test <t@example.invalid>']).stdout;
const fpr =
	/^fpr:+([0-9A-F]{40}):/m.exec(gpg(gnupg, ['--with-colons', '--list-keys']).stdout)?.[1] ?? '';

const installDir = join(S, 'morphit');
mkdirSync(join(installDir, '.forgejo', 'release-signers'), { recursive: true });
writeFileSync(join(installDir, '.forgejo', 'release-signers', 'test.asc'), pub);
writeFileSync(
	join(installDir, 'release-info.json'),
	JSON.stringify({ tag: 'v1.21.16', commit: 'x', build_time: 'x', builder: 'x' })
);
writeFileSync(
	join(installDir, 'morphit.config.env'),
	'MORPHIT_INSTANCE_ORIGIN=https://example.invalid\n'
);

const tree = mkdtempSync(join(S, 'tree-'));
writeFileSync(
	join(tree, 'release-info.json'),
	JSON.stringify({ tag: 'v1.21.17', commit: 'c', build_time: 't', builder: 'b' })
);
writeFileSync(join(tree, 'package.json'), '{}');
const SELF_CONTAINED = [
	'happy',
	'slow-heal',
	'slow-restart',
	'slow-frontend',
	'slow-mcp',
	'step-log',
	'canary-prompt'
];
/** The indexer and relay run here (a stand-in systemctl). */
const SERVICES = ['slow-restart', 'slow-frontend', 'slow-mcp', 'step-log', 'slow-heal'];
if (SELF_CONTAINED.includes(mode)) {
	mkdirSync(join(tree, 'node_modules'), { recursive: true });
	writeFileSync(join(tree, 'node_modules', '.morphit-bundle-complete'), '');
	mkdirSync(join(tree, 'apps', 'web', 'build'), { recursive: true });
	writeFileSync(join(tree, 'apps', 'web', 'build', 'index.html'), '<html></html>');
	writeFileSync(
		join(tree, 'apps', 'web', 'build', 'verify.json'),
		JSON.stringify({ morphit_version: '1.21.17', operator_tag: null })
	);
	// The new release's heal phase: present, and does nothing here.
	mkdirSync(join(tree, 'apps', 'ops-cli', 'dist'), { recursive: true });
	writeFileSync(
		join(tree, 'apps', 'ops-cli', 'dist', 'main.js'),
		mode === 'slow-heal'
			? // Writes its pid; FLOW_HEAL_TRAPS=1: it ends itself on Ctrl+C (exit
				// 130) instead of being ended by the signal.
				`${process.env.FLOW_HEAL_TRAPS === '1' ? "process.on('SIGINT', () => process.exit(130)); " : ''}require('fs').writeFileSync(${JSON.stringify(join(S, 'heal-started'))}, String(process.pid)); setTimeout(() => process.exit(0), 20000);\n`
			: 'process.exit(0);\n'
	);
	mkdirSync(join(tree, 'apps', 'mcp-server'), { recursive: true });
	// The MCP server's update (its unit is installed below).
	mkdirSync(join(tree, 'ops', 'scripts'), { recursive: true });
	writeFileSync(
		join(tree, 'ops', 'scripts', 'deploy-mcp.sh'),
		mode === 'slow-mcp' ? `: > '${join(S, 'mcp-started')}'\nsleep 20\n` : 'exit 0\n'
	);
}
const tb = join(S, 'morphit-v1.21.17-offline.tar.gz');
spawnSync('tar', ['-czf', tb, '-C', tree, '.']);
gpg(gnupg, ['--armor', '--detach-sign', '--output', `${tb}.asc`, tb]);

const bin = join(S, 'bin');
mkdirSync(bin, { recursive: true });
const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
const stub = (n: string, body: string) => {
	writeFileSync(join(bin, n), `#!/bin/sh\necho "$0 $*" >> '${join(S, 'calls.log')}'\n${body}\n`);
	chmodSync(join(bin, n), 0o755);
};
stub(
	'npm',
	mode === 'step-log'
		? 'case "$*" in *build*) echo "the build broke"; exit 1 ;; esac\nexit 0'
		: SELF_CONTAINED.includes(mode)
			? 'exit 0'
			: 'exit 1'
);
// The indexer and relay: running and enabled; a restart works, and they stay
// up ("active"), except in step-log ("failed"). slow-restart: the first restart
// marks itself (the upgrade then watches the indexer stay up).
const unitActive = mode === 'step-log' ? 'failed' : 'active';
stub(
	'systemctl',
	SERVICES.includes(mode)
		? [
				'svc=no',
				'case "$*" in *morphit-indexer.service*|*morphit-relay.service*) svc=yes ;; esac',
				'case "$1" in',
				'  is-active) [ $svc = yes ] && exit 0; exit 3 ;;',
				'  is-enabled) [ $svc = yes ] && { echo enabled; exit 0; }; exit 1 ;;',
				`  show) case "$*" in *ActiveState*) echo ${unitActive} ;; *NRestarts*) echo 0 ;; esac; exit 0 ;;`,
				`  restart) [ $svc = yes ] || exit 3; [ -e '${join(S, 'restart-started')}' ] || : > '${join(S, 'restart-started')}'; exit 0 ;;`,
				'esac',
				'exit 3'
			].join('\n')
		: 'exit 3'
);
stub('systemd-run', 'exit 1');
// slow-frontend: a frontend container from a Compose project bind-mounts the
// install's web build; its first rebuild (`docker compose … up --build`)
// takes 20 s. Every later docker command works at once.
const composeDir = join(S, 'compose');
mkdirSync(join(composeDir, 'frontend'), { recursive: true });
writeFileSync(join(composeDir, 'docker-compose.yml'), 'services: {}\n');
const frontendInspect = JSON.stringify([
	{
		Name: '/frontend',
		Config: {
			Image: 'frontend',
			Labels: {
				'com.docker.compose.project': 'web',
				'com.docker.compose.service': 'frontend',
				'com.docker.compose.project.config_files': join(composeDir, 'docker-compose.yml'),
				'com.docker.compose.project.working_dir': composeDir
			}
		},
		State: { Running: true }
	}
]);
// FLOW_BUNKERWEB=1: BunkerWeb's edge runs here (for what the question says).
stub(
	'docker',
	mode === 'slow-frontend'
		? [
				'case "$1" in',
				'  --version) echo "Docker version 27" ;;',
				'  ps) echo frontend ;;',
				`  inspect) case "$*" in *Mounts*) echo '${join(installDir, 'apps', 'web', 'build')}' ;; *IPAddress*) exit 1 ;; *) cat <<'J'\n${frontendInspect}\nJ\n;; esac ;;`,
				`  compose) [ -e '${join(S, 'compose-started')}' ] || { : > '${join(S, 'compose-started')}'; sleep 20; exit 1; } ;;`,
				'  restart) ;;',
				'  *) exit 1 ;;',
				'esac',
				'exit 0'
			].join('\n')
		: process.env.FLOW_BUNKERWEB === '1'
			? `case "$1" in ps) echo bunkerweb ;; inspect) echo '[{"Name":"/bunkerweb","Config":{"Image":"bunkerity/bunkerweb:1.5.10","Labels":{}},"State":{"Running":true},"NetworkSettings":{"Ports":{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}}}]' ;; *) exit 1 ;; esac`
			: 'exit 1'
);
stub('docker-compose', 'exit 0');
stub('sudo', 'exit 1');
stub(
	'tar',
	mode === 'slow-tar'
		? `case "$1" in -xzf) echo started > '${join(S, 'tar-started')}'; sleep 20;; esac\nexec ${realTar} "$@"`
		: mode === 'late-signal'
			? `case "$1" in -xzf) (sleep 0.1; kill -HUP $PPID) & exit 1 ;; esac\nexec ${realTar} "$@"`
			: `exec ${realTar} "$@"`
);
process.env.PATH = `${bin}:${process.env.PATH}`;
// The MCP server's unit is installed (its update then runs).
mkdirSync(join(S, 'systemd'), { recursive: true });
if (SERVICES.includes(mode)) writeFileSync(join(S, 'systemd', 'morphit-mcp.service'), '[Unit]\n');
const env: Record<string, string> = {
	MORPHIT_INSTALL_DIR: installDir,
	MORPHIT_ETC_DIR: join(S, 'etc'),
	MORPHIT_ENV_ROOT: join(S, 'envroot'),
	MORPHIT_OFFLINE_RELEASE_DIR: join(S, 'no-drops'),
	MORPHIT_WEB_ROOT: join(S, 'www'),
	MORPHIT_SYSTEMD_DIR: join(S, 'systemd'),
	MORPHIT_HELPER_DIR: join(S, 'helpers'),
	MORPHIT_UPGRADE_WARNINGS_FILE: join(S, 'w'),
	MORPHIT_UPGRADE_QUESTIONS_FILE: join(S, 'q'),
	MORPHIT_WEB_HEAL_STATE: join(S, 'whs'),
	MORPHIT_WEB_HEAL_LOG: join(S, 'whl'),
	MORPHIT_AFTER_RESTART_LOG: join(S, 'arl'),
	MORPHIT_STEP_LOG_DIR: join(S, 'steplogs'),
	NO_COLOR: '1'
};
Object.assign(process.env, env);
if (mode === 'network' || mode === 'download') {
	process.env.MORPHIT_RELEASE_HOST = mode === 'network' ? '127.0.0.1:39123' : process.env.DL_HOST!;
	process.env.MORPHIT_RELEASE_MIRRORS = '';
}

const { runUpgrade } = await import(
	resolve(import.meta.dirname, '..', '..', 'src', 'commands', 'upgrade.ts')
);
const flags: Record<string, string> = {};
if (mode !== 'network' && mode !== 'download') flags['from-file'] = tb;
if (mode !== 'prompt' && mode !== 'canary-prompt') flags.yes = 'true';
const rc = await runUpgrade({
	flags,
	positional: [],
	healsWhenUpToDate: async () => 0,
	localIndexerBases: ['http://127.0.0.1:9'],
	trust: {
		signerFingerprints: [fpr],
		chainRead: async () => {
			throw new Error('no chain in this test');
		}
	}
});
console.log(`=== exit code ${rc}`);
const ri = join(installDir, 'release-info.json');
console.log(`=== release-info: ${existsSync(ri) ? readFileSync(ri, 'utf8') : 'MISSING'}`);
process.exit(0);
