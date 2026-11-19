/**
 * Let's Encrypt's check through BunkerWeb's own folder (v1.24.6).
 *
 * WHY. BunkerWeb answers every request for /.well-known/acme-challenge/
 * itself. Its letsencrypt plugin puts
 *     location ~ ^/.well-known/acme-challenge/ {
 *         root /var/tmp/bunkerweb/lets-encrypt;
 *     }
 * into every server it serves (confs/server-http and confs/default-server-http,
 * with no condition, in BunkerWeb 1.5.10), and nginx picks a regex location
 * over the reverse proxy's `location /`. So a file certbot writes into the web
 * build never reaches Let's Encrypt: the request stops at BunkerWeb and gets
 * its 404. On morphit.io (v1.24.4) that kept www.<domain> off the certificate
 * and left renewals pausing BunkerWeb.
 *
 * HOW. certbot's manual authenticator with two hooks. The auth hook writes
 * Let's Encrypt's file into that folder inside BunkerWeb's container (`docker
 * exec`, as the container's own user, nginx, which owns the folder); the
 * cleanup hook removes it. Nothing is stopped: not for the first certificate,
 * not for www, not for any renewal. Proven on morphit.io: a test file came back
 * for the domain and for www, Let's Encrypt issued the certificate with www,
 * and a test renewal against its staging server passed.
 *
 * The hooks are the same files the Ansible `tls` role installs
 * (ops/ansible/roles/tls/files/), byte for byte (test/acmeBunkerweb.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const HOOK_DIR = '/usr/local/lib/morphit';
export const AUTH_HOOK = `${HOOK_DIR}/certbot-bunkerweb-auth.sh`;
export const CLEANUP_HOOK = `${HOOK_DIR}/certbot-bunkerweb-cleanup.sh`;
/** Where BunkerWeb serves /.well-known/acme-challenge/ from, in its container. */
export const EDGE_ACME_DIR = '/var/tmp/bunkerweb/lets-encrypt/.well-known/acme-challenge';

export const AUTH_HOOK_TEXT = `#!/bin/sh
# certbot manual-auth-hook (written by Morphit): BunkerWeb answers
# /.well-known/acme-challenge/ itself, from its own folder inside its
# container, so Let's Encrypt's check file is put there.
set -eu
case "\${CERTBOT_TOKEN:-}" in '' | *[!A-Za-z0-9_-]*) echo "unexpected token" >&2; exit 1 ;; esac
edge=$(docker ps --filter label=bunkerweb.type=bunkerweb --format '{{.Names}}' | head -1)
[ -n "$edge" ] || edge=bunkerweb
printf '%s' "$CERTBOT_VALIDATION" | docker exec -i "$edge" sh -c 'mkdir -p "$1" && cat > "$1/$2"' _ ${EDGE_ACME_DIR} "$CERTBOT_TOKEN"
`;

export const CLEANUP_HOOK_TEXT = `#!/bin/sh
# certbot manual-cleanup-hook (written by Morphit): removes the check file
# from BunkerWeb's Let's Encrypt folder again.
set -u
case "\${CERTBOT_TOKEN:-}" in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
edge=$(docker ps --filter label=bunkerweb.type=bunkerweb --format '{{.Names}}' | head -1)
[ -n "$edge" ] || edge=bunkerweb
docker exec "$edge" rm -f "${EDGE_ACME_DIR}/$CERTBOT_TOKEN" || true
`;

/** certbot's options for the check through BunkerWeb's folder. PURE. */
export function manualAuthArgs(): string[] {
	return [
		'--manual',
		'--preferred-challenges',
		'http',
		'--manual-auth-hook',
		AUTH_HOOK,
		'--manual-cleanup-hook',
		CLEANUP_HOOK
	];
}

/** The renewal settings those options save (certbot's own key names, as
 *  certbot 2.9.0 wrote them on morphit.io). */
export const MANUAL_RENEWAL_PARAMS: Readonly<Record<string, string>> = {
	authenticator: 'manual',
	manual_auth_hook: AUTH_HOOK,
	manual_cleanup_hook: CLEANUP_HOOK,
	pref_challs: 'http-01,'
};

/** A name certbot may hand the hooks (Let's Encrypt's tokens are base64url). PURE. */
export function safeToken(token: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Does BunkerWeb serve its own folder to Let's Encrypt for this request? A
 * test file is put there (`put` with a body), asked for (`get`, which must
 * return exactly it), and taken out again (`put` with null), whatever the
 * answer.
 */
export function edgeServes(
	put: (token: string, body: string | null) => boolean,
	get: (token: string) => string | null
): boolean {
	const token = `morphit-probe-${randomBytes(8).toString('hex')}`;
	const body = randomBytes(16).toString('hex');
	if (!put(token, body)) return false;
	try {
		return (get(token) ?? '').trim() === body;
	} finally {
		put(token, null);
	}
}

/** Put (body) or remove (null) a file in BunkerWeb's folder, in container `edge`. */
export function edgeChallenge(edge: string, token: string, body: string | null): boolean {
	if (!edge || !safeToken(token)) return false;
	try {
		const r =
			body === null
				? spawnSync('docker', ['exec', edge, 'rm', '-f', `${EDGE_ACME_DIR}/${token}`], {
						encoding: 'utf8',
						timeout: 30_000
					})
				: spawnSync(
						'docker',
						[
							'exec',
							'-i',
							edge,
							'sh',
							'-c',
							'mkdir -p "$1" && cat > "$1/$2"',
							'_',
							EDGE_ACME_DIR,
							token
						],
						{ encoding: 'utf8', timeout: 30_000, input: body }
					);
		return r.status === 0;
	} catch {
		return false;
	}
}

/** Is container `name` BunkerWeb's edge (its image's label)? */
export function isBunkerWebEdge(name: string): boolean {
	try {
		const r = spawnSync(
			'docker',
			['inspect', name, '--format', '{{index .Config.Labels "bunkerweb.type"}}'],
			{ encoding: 'utf8', timeout: 30_000 }
		);
		return r.status === 0 && (r.stdout ?? '').trim() === 'bunkerweb';
	} catch {
		return false;
	}
}

export interface HookFs {
	read(path: string): string | null;
	/** Written whole (a temporary file renamed into place), mode 0755. */
	write(path: string, text: string): boolean;
	/** Can its owner run it? */
	executable(path: string): boolean;
}

export const realHookFs: HookFs = {
	read: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	write: (p, text) => {
		try {
			mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
			const tmp = `${p}.tmp-${process.pid}`;
			writeFileSync(tmp, text, { mode: 0o755 });
			chmodSync(tmp, 0o755);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	executable: (p) => {
		try {
			return (statSync(p).mode & 0o100) !== 0;
		} catch {
			return false;
		}
	}
};

/**
 * Both hooks on disk as Morphit writes them. Written only where one is
 * missing, differs or cannot be run; then read back. 'unchanged': both were
 * already right; 'written': one or both were (re)written and read back;
 * 'failed': they are not right now.
 */
export function ensureAcmeHooks(fs: HookFs = realHookFs): 'unchanged' | 'written' | 'failed' {
	let wrote = false;
	for (const [path, text] of [
		[AUTH_HOOK, AUTH_HOOK_TEXT],
		[CLEANUP_HOOK, CLEANUP_HOOK_TEXT]
	] as const) {
		if (fs.read(path) === text && fs.executable(path)) continue;
		if (!fs.write(path, text)) return 'failed';
		wrote = true;
		if (fs.read(path) !== text || !fs.executable(path)) return 'failed';
	}
	return wrote ? 'written' : 'unchanged';
}
