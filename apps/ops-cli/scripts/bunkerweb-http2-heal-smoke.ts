#!/usr/bin/env tsx
/**
 * bunkerweb-http2-heal-smoke.ts — v1.24.6, Fix G.
 *
 * CVE-2026-123633 and CVE-2026-123007 let a stranger run code on a server
 * through nginx's HTTP/2 code, in every nginx before 1.30.7. BunkerWeb 1.5.10
 * runs nginx 1.26.2 and turns HTTP/2 on by default (HTTP2=yes), and no
 * BunkerWeb with a fixed nginx exists yet. `morphit-ops upgrade` doesn't
 * re-render templates, so the WAF self-heal must set HTTP2=no on existing
 * boxes (and give HTTP/1.1 visitors more connections), AND prove the running
 * nginx took it.
 *
 * This EXECUTES the real healBunkerWebWaf against a temp bunkerweb.env with
 * `docker`, `sleep` and `curl` stubbed on PATH. The docker stub models the part
 * that matters: `docker restart` keeps a container's old environment, and only
 * recreating it from compose makes nginx render the new setting (BunkerWeb
 * 1.5.10 writes `http2 on;` when HTTP2=yes: confs/server-http/
 * ssl-certificate-lua.conf and confs/default-server-http.conf).
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

/** Lines Fixes A–F already want, so a case only exercises Fix G. */
const STEADY = [
	'USE_REAL_IP=no',
	'MAX_CLIENT_SIZE=1m',
	'BAD_BEHAVIOR_STATUS_CODES=401 405 444',
	'BAD_BEHAVIOR_THRESHOLD=50',
	'BAD_BEHAVIOR_COUNT_TIME=60',
	'BAD_BEHAVIOR_BAN_TIME=3600',
	'CUSTOM_CONF_MODSEC_morphit_json_api_off=x',
	'LIMIT_REQ_URL=^/(?:ipfs|ipns|rss)/|^/mcp',
	'LIMIT_REQ_RATE=2r/s',
	'LIMIT_CONN_MAX_HTTP2=256',
	'REVERSE_PROXY_INTERCEPT_ERRORS=no'
].join('\n');

const LIVE_H2 = 'http {\n  server {\n    listen 8443 ssl;\n    http2 on;\n  }\n}\n';
const LIVE_H2_LISTEN = 'http {\n  server {\n    listen 8443 ssl http2;\n  }\n}\n';
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
    # BunkerWeb renders \`http2 on;\` unless every HTTP2 line says no (unset = yes).
    E="$(cat "$S/envpath")"
    if grep -q '^HTTP2=no$' "$E" && ! grep -E '^([a-z0-9.-]+_)?HTTP2=' "$E" | grep -qv '=no$'; then
      printf 'http {\\n  server {\\n    listen 8443 ssl;\\n  }\\n}\\n' > "$S/live.conf"
    else
      printf 'http {\\n  server {\\n    listen 8443 ssl;\\n    http2 on;\\n  }\\n}\\n' > "$S/live.conf"
    fi
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

async function scenario(env: string, live: string, opts: { composeBroken?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bw-http2-'));
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
		await healBunkerWebWaf(envPath);
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

console.log('\n── BunkerWeb HTTP/2 self-heal (v1.24.6, Fix G) ─────\n');

const h2Rendered = (live: string): boolean =>
	/^\s*http2\s+on\s*;|^\s*listen\s[^;#]*\bhttp2\b/m.test(live);

{
	const r = await scenario(`SERVER_NAME=x.example\n${STEADY}\n`, LIVE_H2);
	check('HTTP2 unset (BunkerWeb turns it on) → HTTP2=no written', /^HTTP2=no$/m.test(r.env));
	check(
		'…and HTTP/1.1 visitors may hold 64 connections (BunkerWeb default 10)',
		/^LIMIT_CONN_MAX_HTTP1=64$/m.test(r.env)
	);
	check(
		'…other settings are kept, LIMIT_CONN_MAX_HTTP2 untouched',
		r.env.includes('SERVER_NAME=x.example') && /^LIMIT_CONN_MAX_HTTP2=256$/m.test(r.env)
	);
	check(
		'…the containers are recreated from compose (a restart keeps the old env)',
		recreated(r.calls)
	);
	check('…and the RUNNING nginx no longer has HTTP/2', !h2Rendered(r.live));
	check(
		'…never with a whole-stack `compose up` (it can recreate the database)',
		!wholeStackUp(r.calls)
	);
	check('…without throwing', !r.threw);
}
{
	const r = await scenario(`${STEADY}\nHTTP2="yes"\nLIMIT_CONN_MAX_HTTP1=10\n`, LIVE_H2);
	check(
		'HTTP2="yes" (quoted) and BunkerWeb\'s own 10 → HTTP2=no and 64',
		/^HTTP2=no$/m.test(r.env) &&
			!/^HTTP2="yes"/m.test(r.env) &&
			/^LIMIT_CONN_MAX_HTTP1=64$/m.test(r.env) &&
			!h2Rendered(r.live)
	);
}
{
	const r = await scenario(
		`${STEADY}\nHTTP2=no\nLIMIT_CONN_MAX_HTTP1=64\nx.example_HTTP2=yes\n`,
		LIVE_H2
	);
	check(
		'a per-site x.example_HTTP2=yes (multisite) is turned off too',
		/^x\.example_HTTP2=no$/m.test(r.env) && recreated(r.calls) && !h2Rendered(r.live)
	);
}
{
	const env = `${STEADY}\nHTTP2=no\nLIMIT_CONN_MAX_HTTP1=20\n`;
	const r = await scenario(env, LIVE_OFF);
	check(
		"an operator's own LIMIT_CONN_MAX_HTTP1=20 is kept (nothing written, nothing recreated)",
		r.env === env && !recreated(r.calls)
	);
}
{
	const env = `${STEADY}\nHTTP2=no\nUSE_LIMIT_CONN=no\n`;
	const r = await scenario(env, LIVE_OFF);
	check(
		'USE_LIMIT_CONN=no → no connection limit is added',
		r.env === env && !/LIMIT_CONN_MAX_HTTP1/.test(r.env)
	);
}
{
	const env = `${STEADY}\nHTTP2=no\nLIMIT_CONN_MAX_HTTP1=64\n`;
	const r = await scenario(env, LIVE_OFF);
	check(
		'steady state (already off, live clean) → nothing written, nothing recreated',
		r.env === env && !recreated(r.calls)
	);
}
{
	const r = await scenario(`${STEADY}\nHTTP2=no\nLIMIT_CONN_MAX_HTTP1=64\n`, LIVE_H2);
	check(
		'env already says no but the running nginx still has `http2 on;` → recreated and verified',
		recreated(r.calls) && !h2Rendered(r.live)
	);
}
{
	const r = await scenario(`${STEADY}\nHTTP2=no\nLIMIT_CONN_MAX_HTTP1=64\n`, LIVE_H2_LISTEN);
	check('…the same when it has `listen … http2`', recreated(r.calls) && !h2Rendered(r.live));
}
{
	const r = await scenario(`${STEADY}\nHTTP2=yes\n`, LIVE_H2, { composeBroken: true });
	check(
		'compose cannot recreate → env still fixed on disk, and the heal does not throw',
		/^HTTP2=no$/m.test(r.env) && !r.threw
	);
}

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} BunkerWeb HTTP/2 heal checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} BunkerWeb HTTP/2 heal checks passed`);
