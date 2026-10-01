#!/usr/bin/env tsx
/**
 * bunkerweb-real-ip-heal-smoke.ts — (v1.18.0 deep-deep, H1)
 *
 * BunkerWeb shipped USE_REAL_IP=yes with REAL_IP_FROM=0.0.0.0/0: the public
 * edge believed every visitor's X-Forwarded-For, so anyone could pick their
 * own address per request (past BunkerWeb's bans and the relay's per-IP
 * signup limits). `morphit-ops upgrade` doesn't re-render templates, so the
 * WAF self-heal must turn it off on existing boxes AND prove the running
 * container took it.
 *
 * This EXECUTES the real healBunkerWebWaf against a temp bunkerweb.env with
 * `docker`, `sleep` and `curl` stubbed on PATH. The docker stub models the part
 * that matters: `docker restart` keeps a container's old environment, and only
 * recreating it from compose makes nginx render the new setting.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healBunkerWebWaf } from '../src/commands/upgrade.ts';

let pass = 0;
const fails: string[] = [];
const check = (d: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log('  ✓ ' + d);
	} else {
		fails.push(d);
		console.log('  ✗ ' + d);
	}
};

/** Lines Fixes A–C already want, so a case only exercises Fix D. */
const STEADY_ABC = [
	'MAX_CLIENT_SIZE=1m',
	'BAD_BEHAVIOR_STATUS_CODES=401 403 404 405 429 444',
	'CUSTOM_CONF_MODSEC_morphit_json_api_off=x'
].join('\n');

const LIVE_WIDE =
	'http {\n  server {\n    set_real_ip_from 0.0.0.0/0;\n    real_ip_header X-Forwarded-For;\n  }\n}\n';
const LIVE_CDN =
	'http {\n  server {\n    set_real_ip_from 173.245.48.0/20;\n    real_ip_header X-Forwarded-For;\n  }\n}\n';
const LIVE_OFF = 'http {\n  server {\n    listen 8443 ssl;\n  }\n}\n';

// `docker` stub. State lives in $STUB_STATE: live.conf is what `nginx -T`
// shows; calls.log records every invocation. The containers carry the image
// and Compose labels the heal identifies BunkerWeb by (wave 5: by image, never
// by name); `compose … config` reports the env file BunkerWeb reads.
const DOCKER_STUB = `#!/bin/sh
S="$STUB_STATE"
echo "docker $*" >> "$S/calls.log"
case "$1" in
  ps) printf 'bunkerweb\\nbunkerweb-scheduler\\n'; exit 0 ;;
  inspect) cat "$S/inspect.json"; exit 0 ;;
  restart) exit 0 ;;
  logs) printf 'Successfully sent API request to http://bunkerweb:5000/reload\\n'; exit 0 ;;
  exec)
    cmd="$5"
    case "$cmd" in
      *"nginx -T"*) cat "$S/live.conf"; exit 0 ;;
      *"for d in"*) echo /data/configs; exit 0 ;;
      *"test -s"*) echo yes; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  compose)
    case " $* " in
      *" config "*) cat "$S/model.json"; exit 0 ;;
    esac
    [ -f "$S/compose-broken" ] && exit 1
    if grep -q '^USE_REAL_IP=no' "$(cat "$S/envpath")"; then printf 'http {\\n  server {\\n    listen 8443 ssl;\\n  }\\n}\\n' > "$S/live.conf"; fi
    exit 0 ;;
esac
exit 0
`;

/** `docker inspect` JSON for the shipped stack, labelled from `etc`. */
function inspectJson(etc: string): string {
	const labels = (service: string) => ({
		'com.docker.compose.project': 'bunkerweb',
		'com.docker.compose.service': service,
		'com.docker.compose.project.config_files': join(etc, 'docker-compose.yml'),
		'com.docker.compose.project.working_dir': etc
	});
	const c = (
		name: string,
		image: string,
		service: string,
		ports: Record<string, unknown> = {}
	) => ({
		Name: `/${name}`,
		Config: { Image: image, Labels: labels(service), Env: [] },
		State: { Running: true },
		NetworkSettings: { Ports: ports, Networks: {} },
		Mounts: []
	});
	return JSON.stringify([
		c('bunkerweb', 'bunkerity/bunkerweb:1.5.10', 'bunkerweb', {
			'8443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }]
		}),
		c('bunkerweb-scheduler', 'bunkerity/bunkerweb-scheduler:1.5.10', 'bunkerweb-scheduler')
	]);
}

function scenario(env: string, live: string, opts: { composeBroken?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bw-realip-'));
	const bin = join(dir, 'bin');
	const state = join(dir, 'state');
	const etc = join(dir, 'etc');
	mkdirSync(bin);
	mkdirSync(state);
	mkdirSync(etc);
	writeFileSync(join(bin, 'docker'), DOCKER_STUB);
	writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
	writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf 200\n');
	for (const f of ['docker', 'sleep', 'curl']) chmodSync(join(bin, f), 0o755);
	writeFileSync(join(state, 'live.conf'), live);
	writeFileSync(join(state, 'calls.log'), '');
	if (opts.composeBroken) writeFileSync(join(state, 'compose-broken'), '');
	const envPath = join(etc, 'bunkerweb.env');
	writeFileSync(envPath, env);
	writeFileSync(join(etc, 'docker-compose.yml'), 'services: {}\n');
	writeFileSync(join(state, 'inspect.json'), inspectJson(etc));
	writeFileSync(join(state, 'envpath'), envPath);
	writeFileSync(
		join(state, 'model.json'),
		JSON.stringify({
			services: {
				bunkerweb: { env_file: [{ path: envPath }] },
				'bunkerweb-scheduler': { env_file: [{ path: envPath }] }
			}
		})
	);

	const oldPath = process.env.PATH;
	const oldState = process.env.STUB_STATE;
	process.env.PATH = `${bin}:${oldPath ?? ''}`;
	process.env.STUB_STATE = state;
	let threw = false;
	try {
		healBunkerWebWaf(envPath);
	} catch {
		threw = true;
	} finally {
		process.env.PATH = oldPath;
		if (oldState === undefined) delete process.env.STUB_STATE;
		else process.env.STUB_STATE = oldState;
	}
	const result = {
		threw,
		env: readFileSync(envPath, 'utf8'),
		live: readFileSync(join(state, 'live.conf'), 'utf8'),
		calls: readFileSync(join(state, 'calls.log'), 'utf8')
	};
	rmSync(dir, { recursive: true, force: true });
	return result;
}

// Only BunkerWeb's own services, from its own project, never a whole-stack up.
const recreated = (calls: string): boolean =>
	/compose -p bunkerweb .*-f \S+ up -d --no-deps --force-recreate bunkerweb bunkerweb-scheduler/.test(
		calls
	);
const wholeStackUp = (calls: string): boolean =>
	calls.split('\n').some((l) => / up -d/.test(l) && !/--no-deps/.test(l));

console.log('\n── BunkerWeb real-IP self-heal (H1) ─────────────────\n');

{
	const r = scenario(
		`SERVER_NAME=x.example\n${STEADY_ABC}\nUSE_REAL_IP=yes\nREAL_IP_FROM=0.0.0.0/0\nREAL_IP_HEADER=X-Forwarded-For\n`,
		LIVE_WIDE
	);
	check(
		'trusting X-Forwarded-For from 0.0.0.0/0 → the env is switched to USE_REAL_IP=no',
		/^USE_REAL_IP=no$/m.test(r.env)
	);
	check(
		'…other settings are kept',
		r.env.includes('SERVER_NAME=x.example') && r.env.includes('MAX_CLIENT_SIZE=1m')
	);
	check(
		'…the containers are recreated from compose (a restart keeps the old env)',
		recreated(r.calls)
	);
	check('…and the RUNNING nginx no longer trusts the header', !/set_real_ip_from/.test(r.live));
	check(
		'…never with a whole-stack `compose up` (it can recreate the database)',
		!wholeStackUp(r.calls)
	);
	check('…without throwing', !r.threw);
}
{
	const r = scenario(
		`${STEADY_ABC}\nUSE_REAL_IP="yes"\nREAL_IP_FROM="0.0.0.0/0 ::/0"\n`,
		LIVE_WIDE
	);
	check(
		'a quoted value with a v6 /0 is caught too',
		/^USE_REAL_IP=no$/m.test(r.env) && !/set_real_ip_from/.test(r.live)
	);
}
{
	const r = scenario(`${STEADY_ABC}\nUSE_REAL_IP=yes\n`, LIVE_WIDE);
	check(
		'USE_REAL_IP=yes with REAL_IP_FROM unset (BunkerWeb default private ranges) → turned off',
		/^USE_REAL_IP=no$/m.test(r.env)
	);
}
{
	const env = `${STEADY_ABC}\nUSE_REAL_IP=yes\nREAL_IP_FROM=173.245.48.0/20 103.21.244.0/22\n`;
	const r = scenario(env, LIVE_CDN);
	check(
		'a deliberate CDN list is left alone',
		r.env === env && !recreated(r.calls) && r.live === LIVE_CDN
	);
}
{
	const env = `${STEADY_ABC}\nUSE_REAL_IP=no\n`;
	const r = scenario(env, LIVE_OFF);
	check(
		'steady state (already off, live clean) → nothing written, nothing recreated',
		r.env === env && !recreated(r.calls)
	);
}
{
	const r = scenario(`${STEADY_ABC}\nUSE_REAL_IP=no\n`, LIVE_WIDE);
	check(
		'env already says no but the running nginx still trusts XFF → recreated and verified',
		recreated(r.calls) && !/set_real_ip_from/.test(r.live)
	);
}
{
	const r = scenario(`${STEADY_ABC}\nUSE_REAL_IP=yes\nREAL_IP_FROM=0.0.0.0/0\n`, LIVE_WIDE, {
		composeBroken: true
	});
	check(
		'compose cannot recreate → env still fixed on disk, and the heal does not throw',
		/^USE_REAL_IP=no$/m.test(r.env) && !r.threw
	);
}

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} BunkerWeb real-IP heal checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} BunkerWeb real-IP heal checks passed`);
