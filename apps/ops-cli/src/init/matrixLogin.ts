/**
 * Matrix login helper (cp600) — exchange a homeserver + username + password
 * for an access token via the Matrix client-server API, so Morphit can set up
 * Matrix alerts FOR the operator instead of making them hunt for a raw token.
 *
 * WHY: Matrix is an OPTIONAL value-add (operator alerts DM'd to you + a public
 * contact address for your users).  We never require it — if the operator skips
 * it, there's simply no token, so the bot never starts and no alerts are sent.
 * But when they DO want it, "paste your access_token" is not grandma-friendly.
 * A username + password we can turn into a token ourselves is.
 *
 * SECURITY: we store ONLY the resulting access token (never the password), and
 * we mint it under a clearly-named device ("Morphit node alerts") so the
 * operator can see + revoke it from any Matrix client.  We RECOMMEND (but do
 * not force) a dedicated bot account so the token's blast radius is limited —
 * the caller surfaces that advice; this module just performs the exchange.
 *
 * All the request-shaping + response-parsing is pure + unit-tested; only the
 * two network calls (well-known discovery + the login POST) touch the outside
 * world, and both degrade to a friendly, non-fatal error the caller can retry
 * or skip.
 */

export interface MatrixLoginParams {
	/** Homeserver as the operator typed it — bare domain or URL both fine.
	 *  If empty, we derive it from the domain part of `user` (an MXID). */
	readonly homeserver: string;
	/** @localpart:server  OR  a bare localpart. */
	readonly user: string;
	readonly password: string;
	/** Device label shown in the operator's Matrix client (revocable). */
	readonly deviceDisplayName?: string;
}

export type MatrixLoginResult =
	| {
			readonly ok: true;
			readonly accessToken: string;
			readonly deviceId: string;
			readonly userId: string;
			/** The resolved client base URL alerts should be sent through. */
			readonly baseUrl: string;
	  }
	| { readonly ok: false; readonly error: string };

const DEFAULT_DEVICE_NAME = 'Morphit node alerts';

/** Normalize a homeserver the operator typed into an https base URL with no
 *  trailing slash.  Bare domains get https://; an explicit http:// is left as
 *  typed (someone testing against a local homeserver).  PURE. */
export function normalizeHomeserver(input: string): string {
	let s = input.trim();
	if (s === '') return s;
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
	// Strip a trailing slash (and any accidental /_matrix... path the operator
	// may have pasted — we only want the origin as the base URL).
	try {
		const u = new URL(s);
		return `${u.protocol}//${u.host}`;
	} catch {
		return s.replace(/\/+$/, '');
	}
}

/** Split an MXID (@local:server) into its parts.  Returns null for a bare
 *  localpart (no @ / no :).  PURE. */
export function parseUserId(user: string): { localpart: string; domain: string } | null {
	const m = /^@([^:]+):(.+)$/.exec(user.trim());
	if (m === null) return null;
	const localpart = m[1];
	const domain = m[2];
	if (localpart === undefined || domain === undefined) return null;
	return { localpart, domain };
}

/** Pull a client base URL out of a /.well-known/matrix/client document.
 *  Returns null when the doc is missing the field or malformed.  PURE. */
export function parseWellKnownBaseUrl(json: unknown): string | null {
	if (json === null || typeof json !== 'object') return null;
	const hs = (json as Record<string, unknown>)['m.homeserver'];
	if (hs === null || typeof hs !== 'object') return null;
	const base = (hs as Record<string, unknown>)['base_url'];
	if (typeof base !== 'string' || base.trim() === '') return null;
	return normalizeHomeserver(base);
}

/** Build the client-server login request (URL + JSON body).  PURE.
 *  Uses m.login.password with an m.id.user identifier; Synapse + Dendrite
 *  both accept either a bare localpart or a full MXID as `user`, so we pass
 *  the localpart when the operator gave a full MXID (most portable). */
export function buildLoginRequest(
	baseUrl: string,
	user: string,
	password: string,
	deviceDisplayName: string = DEFAULT_DEVICE_NAME
): { url: string; body: string } {
	const parsed = parseUserId(user);
	const identifierUser = parsed !== null ? parsed.localpart : user.trim();
	const body = JSON.stringify({
		type: 'm.login.password',
		identifier: { type: 'm.id.user', user: identifierUser },
		password,
		initial_device_display_name: deviceDisplayName
	});
	return { url: `${baseUrl}/_matrix/client/v3/login`, body };
}

/** Map an HTTP status + parsed Matrix error body to a friendly, actionable
 *  sentence.  PURE — the network layer hands us (status, json). */
export function mapLoginError(status: number, json: unknown): string {
	const errcode =
		json !== null && typeof json === 'object'
			? String((json as Record<string, unknown>).errcode ?? '')
			: '';
	switch (errcode) {
		case 'M_FORBIDDEN':
			return 'Matrix rejected that username or password. Double-check both (the username is the part after @, and passwords are case-sensitive).';
		case 'M_USER_DEACTIVATED':
			return 'That Matrix account has been deactivated. Use a different account.';
		case 'M_LIMIT_EXCEEDED':
			return 'Too many login attempts — wait a minute and try again.';
		case 'M_UNKNOWN':
			break;
		default:
			break;
	}
	if (errcode.startsWith('M_')) {
		// Some servers gate password login behind interactive/SSO flows.
		if (status === 400 || status === 403) {
			return 'This homeserver did not accept a username+password login (it may require single-sign-on). You can still set up alerts by pasting an access token instead.';
		}
	}
	if (status >= 500) return 'The Matrix server had an error. Try again shortly.';
	return `Matrix login failed (HTTP ${status}). Check the homeserver address and your credentials.`;
}

/** Best-effort: resolve the real client base URL for a homeserver via
 *  /.well-known/matrix/client (matrix.org, for one, serves its client API on
 *  a different host).  Falls back to the origin itself.  NETWORK. */
export async function discoverBaseUrl(homeserverOrigin: string): Promise<string> {
	const origin = normalizeHomeserver(homeserverOrigin);
	try {
		const res = await fetch(`${origin}/.well-known/matrix/client`, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000)
		});
		if (res.ok) {
			const json: unknown = await res.json().catch(() => null);
			const discovered = parseWellKnownBaseUrl(json);
			if (discovered !== null) return discovered;
		}
	} catch {
		// No well-known / unreachable / malformed — fall back to the origin,
		// which is correct for the majority of self-hosted homeservers.
	}
	return origin;
}

/** Perform the login.  The homeserver may be blank, in which case we derive it
 *  from the MXID's domain.  NETWORK; always resolves (never throws) to a
 *  friendly result the caller can act on. */
export async function matrixLogin(params: MatrixLoginParams): Promise<MatrixLoginResult> {
	const { user, password } = params;
	let homeserverInput = params.homeserver.trim();
	if (homeserverInput === '') {
		const parsed = parseUserId(user);
		if (parsed === null) {
			return {
				ok: false,
				error: 'Enter your Matrix homeserver (e.g. https://matrix.org), or type your full @user:server address.'
			};
		}
		homeserverInput = parsed.domain;
	}

	const baseUrl = await discoverBaseUrl(homeserverInput);
	const { url, body } = buildLoginRequest(
		baseUrl,
		user,
		password,
		params.deviceDisplayName ?? DEFAULT_DEVICE_NAME
	);

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: AbortSignal.timeout(20_000)
		});
	} catch {
		return {
			ok: false,
			error: `Could not reach the Matrix server at ${baseUrl}. Check the homeserver address and your internet connection.`
		};
	}

	const json: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		return { ok: false, error: mapLoginError(res.status, json) };
	}
	const obj = (json ?? {}) as Record<string, unknown>;
	if (typeof obj.access_token !== 'string' || obj.access_token === '') {
		return {
			ok: false,
			error: 'The Matrix server accepted the login but returned no access token. Try pasting a token manually instead.'
		};
	}
	return {
		ok: true,
		accessToken: obj.access_token,
		deviceId: typeof obj.device_id === 'string' ? obj.device_id : '',
		userId: typeof obj.user_id === 'string' ? obj.user_id : user.trim(),
		baseUrl
	};
}
