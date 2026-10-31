/**
 * A file path the operator typed, as they meant it.
 *
 * The installed `morphit-ops` launcher `cd`s into the install and runs this CLI
 * from apps/ops-cli, so a plain `my-logo.svg` or `Downloads/x.tar.gz` used to be
 * looked up there. The shell also leaves a `~` right after `=` as it is
 * (`--from-file=~/Downloads/…` reached the CLI with the `~` in it on
 * morphitlat, 2026-10-30), so "~/" is expanded here, to the home of the person
 * who ran sudo.
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

/** The home directory of the person who ran sudo (for "~/logo.svg"). */
export function callerHome(env: NodeJS.ProcessEnv): string {
	const user = env.SUDO_USER;
	if (user && /^[a-z_][a-z0-9_.-]*\$?$/i.test(user)) {
		const r = spawnSync('getent', ['passwd', user], { encoding: 'utf8', timeout: 5000 });
		const home = r.status === 0 ? r.stdout.split(':')[5] : undefined;
		if (home) return home.trim();
	}
	return env.HOME ?? '/root';
}

/**
 * Resolve a file path the operator typed against THEIR working directory.
 * The Ansible-installed `morphit-ops` launcher `cd`s into the install and
 * `npm exec --workspace` then runs this CLI from apps/ops-cli, so a plain
 * `--logo my-logo.svg` used to be looked up there. The launcher now passes the
 * caller's directory (MORPHIT_OPS_CALLER_CWD); an older launcher is detected by
 * npm's INIT_CWD being the install while we run from apps/ops-cli, where the
 * shell's `cd` left the caller's directory in OLDPWD. Also expands "~/".
 */
export function resolveCallerPath(
	typed: string,
	installDir: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): string {
	let p = typed.trim().replace(/^['"]|['"]$/g, '');
	if (p === '~' || p.startsWith('~/')) p = join(callerHome(env), p.slice(1));
	if (isAbsolute(p)) return p;
	let base = cwd;
	if (env.MORPHIT_OPS_CALLER_CWD && isAbsolute(env.MORPHIT_OPS_CALLER_CWD)) {
		base = env.MORPHIT_OPS_CALLER_CWD;
	} else if (
		env.INIT_CWD !== undefined &&
		resolve(env.INIT_CWD) === resolve(installDir) &&
		resolve(cwd) === resolve(installDir, 'apps', 'ops-cli') &&
		env.OLDPWD !== undefined &&
		isAbsolute(env.OLDPWD)
	) {
		base = env.OLDPWD;
	}
	return resolve(base, p);
}
