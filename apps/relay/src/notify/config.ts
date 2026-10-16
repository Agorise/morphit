/**
 * Offline notices — which channels this instance offers, from the operator's
 * settings (/etc/morphit/relay-notify.env, written by
 * `sudo morphit-ops offline-notify`; root:morphit-relay 0640). PURE.
 *
 * A channel is offered only when it is fully set up. On a zero-clearnet
 * instance a channel is offered only when its server is an .onion address
 * (Telegram and Session never are), and the link in a notice is the
 * instance's .onion address.
 */

import type { Channel } from './addresses.ts';
import type { MatrixConfig } from './channels/matrix.ts';
import type { SmtpConfig } from './channels/smtp.ts';
import type { TelegramConfig } from './channels/telegram.ts';
import type { XmppConfig } from './channels/xmpp.ts';
import { isOnionHost, type NetPolicy } from './net.ts';
import { sessionIdOf } from './channels/session.ts';
import { sanitizeBrandName } from '@morphit/operator-config';

/** Which of the site's addresses a user's links open (store.ts LinkNet). */
export type NotifyLinkNet = 'clearnet' | 'tor' | 'i2p' | 'loki';

export interface NotifyConfig {
	/** The site's name as visitors see it ("Vigilante Trading"). */
	readonly siteName: string;
	/** Who signed requests are for (sig.ts): this instance's relay account,
	 *  unique in the federation. Told to the browser by /v1/notify/channels. */
	readonly audience: string;
	/** Origin the links in notices open by default (https://site, or the
	 *  .onion on a zero-clearnet site); null when there is none. */
	readonly linkOrigin: string | null;
	/** The site's address on each network, where it has one. A user who set
	 *  her notices up over Tor gets links to the .onion (and so on). */
	readonly linkOrigins: Readonly<Record<NotifyLinkNet, string | null>>;
	readonly policy: NetPolicy;
	readonly email: SmtpConfig | null;
	readonly matrix: MatrixConfig | null;
	readonly xmpp: XmppConfig | null;
	readonly telegram: TelegramConfig | null;
	readonly session: { readonly mnemonic: string; readonly sessionId: string } | null;
	/** Why a channel with settings is still off: its server is not an .onion on
	 *  a zero-clearnet site, its settings are incomplete, or (Session) this server
	 *  runs no Tor. */
	readonly off: Partial<Record<Channel, 'zero_clearnet' | 'incomplete' | 'no_tor'>>;
}

type Env = Record<string, string | undefined>;

const v = (env: Env, k: string): string => (env[k] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** The site's name: its brand name, else its instance name, else its host. */
export function siteNameFromEnv(env: Env): string {
	return (
		// The same rule as the site's own pages: a brand name they would not
		// show is not put in a note either.
		(sanitizeBrandName(v(env, 'MORPHIT_INSTANCE_BRAND_NAME')) ?? '') ||
		v(env, 'MORPHIT_INSTANCE_NAME') ||
		hostOf(v(env, 'MORPHIT_INSTANCE_ORIGIN')) ||
		'Morphit'
	);
}

/** The site's address on every network it has one on. */
export function linkOriginsFromEnv(
	env: Env,
	hiddenOnly: boolean
): Record<NotifyLinkNet, string | null> {
	const host = (k: string): string =>
		v(env, k)
			.replace(/^https?:\/\//, '')
			.replace(/\/.*$/, '')
			.toLowerCase();
	const tor = host('MORPHIT_INSTANCE_TOR_ADDRESS');
	const i2p = host('MORPHIT_INSTANCE_I2P_B32_ADDRESS');
	const loki = host('MORPHIT_INSTANCE_LOKINET_ADDRESS');
	// Never a clearnet link on a zero-clearnet site.
	const clear = linkOriginFromEnv(env, false);
	return {
		clearnet: hiddenOnly ? null : clear?.startsWith('https://') ? clear : null,
		tor: /^[a-z2-7]{56}\.onion$/.test(tor) ? `http://${tor}` : null,
		i2p: /^[a-z2-7]{52,}\.b32\.i2p$/.test(i2p) ? `http://${i2p}` : null,
		loki: /^[a-z0-9][a-z0-9-]{1,62}\.loki$/.test(loki) ? `http://${loki}` : null
	};
}

/** The link origin for a user who set her notices up over `net`: that
 *  network's address when the site has one, else the default. PURE. */
export function linkOriginFor(
	cfg: Pick<NotifyConfig, 'linkOrigin' | 'linkOrigins'>,
	net: NotifyLinkNet
): string | null {
	return cfg.linkOrigins[net] ?? cfg.linkOrigin;
}

/** Where a notice's link points. */
export function linkOriginFromEnv(env: Env, hiddenOnly: boolean): string | null {
	const onionRaw = v(env, 'MORPHIT_INSTANCE_TOR_ADDRESS')
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '');
	const onion = /^[a-z2-7]{56}\.onion$/i.test(onionRaw) ? `http://${onionRaw.toLowerCase()}` : null;
	if (hiddenOnly) return onion;
	const origin = v(env, 'MORPHIT_INSTANCE_ORIGIN');
	try {
		const u = new URL(origin);
		if (u.protocol === 'https:' && !u.hostname.endsWith('.invalid')) return `https://${u.host}`;
	} catch {
		/* fall through */
	}
	return onion;
}

function port(raw: string, dflt: number): number {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : dflt;
}

export async function notifyConfigFromEnv(env: Env, net: NetPolicy): Promise<NotifyConfig> {
	const off: NotifyConfig['off'] = {};
	const reachable = (host: string): boolean => !net.hiddenOnly || isOnionHost(host);

	let email: SmtpConfig | null = null;
	if (v(env, 'MORPHIT_NOTIFY_EMAIL_HOST') !== '') {
		const host = v(env, 'MORPHIT_NOTIFY_EMAIL_HOST');
		const security = v(env, 'MORPHIT_NOTIFY_EMAIL_SECURITY') === 'tls' ? 'tls' : 'starttls';
		const cfg: SmtpConfig = {
			host,
			port: port(v(env, 'MORPHIT_NOTIFY_EMAIL_PORT'), security === 'tls' ? 465 : 587),
			security,
			user: v(env, 'MORPHIT_NOTIFY_EMAIL_USER'),
			password: v(env, 'MORPHIT_NOTIFY_EMAIL_PASSWORD'),
			from: v(env, 'MORPHIT_NOTIFY_EMAIL_FROM')
		};
		if (cfg.user === '' || cfg.password === '' || !/^[^\s@<>]+@[^\s@<>]+$/.test(cfg.from))
			off.email = 'incomplete';
		else if (!reachable(host)) off.email = 'zero_clearnet';
		else email = cfg;
	}

	let matrix: MatrixConfig | null = null;
	if (v(env, 'MORPHIT_NOTIFY_MATRIX_HOMESERVER') !== '') {
		const homeserver = v(env, 'MORPHIT_NOTIFY_MATRIX_HOMESERVER').replace(/\/+$/, '');
		const host = hostOf(homeserver);
		const cfg: MatrixConfig = {
			homeserver,
			accessToken: v(env, 'MORPHIT_NOTIFY_MATRIX_TOKEN'),
			userId: v(env, 'MORPHIT_NOTIFY_MATRIX_USER_ID')
		};
		if (host === null || cfg.accessToken === '' || !/^@[^:\s]+:\S+$/.test(cfg.userId))
			off.matrix = 'incomplete';
		else if (!reachable(host)) off.matrix = 'zero_clearnet';
		else matrix = cfg;
	}

	let xmpp: XmppConfig | null = null;
	if (v(env, 'MORPHIT_NOTIFY_XMPP_JID') !== '') {
		const jid = v(env, 'MORPHIT_NOTIFY_XMPP_JID').toLowerCase();
		const domain = jid.slice(jid.indexOf('@') + 1);
		const security = v(env, 'MORPHIT_NOTIFY_XMPP_SECURITY') === 'tls' ? 'tls' : 'starttls';
		const cfg: XmppConfig = {
			jid,
			password: v(env, 'MORPHIT_NOTIFY_XMPP_PASSWORD'),
			host: v(env, 'MORPHIT_NOTIFY_XMPP_HOST') || domain,
			port: port(v(env, 'MORPHIT_NOTIFY_XMPP_PORT'), security === 'tls' ? 5223 : 5222),
			security
		};
		if (!/^[^@\s]+@[^@\s]+$/.test(jid) || cfg.password === '') off.xmpp = 'incomplete';
		else if (!reachable(cfg.host)) off.xmpp = 'zero_clearnet';
		else xmpp = cfg;
	}

	let telegram: TelegramConfig | null = null;
	if (v(env, 'MORPHIT_NOTIFY_TELEGRAM_TOKEN') !== '') {
		const cfg: TelegramConfig = {
			token: v(env, 'MORPHIT_NOTIFY_TELEGRAM_TOKEN'),
			username: v(env, 'MORPHIT_NOTIFY_TELEGRAM_USERNAME').replace(/^@/, '')
		};
		if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(cfg.token) || !/^[A-Za-z0-9_]{5,32}$/.test(cfg.username))
			off.telegram = 'incomplete';
		else if (net.hiddenOnly) off.telegram = 'zero_clearnet';
		else telegram = cfg;
	}

	let session: NotifyConfig['session'] = null;
	if (v(env, 'MORPHIT_NOTIFY_SESSION_MNEMONIC') !== '') {
		const mnemonic = v(env, 'MORPHIT_NOTIFY_SESSION_MNEMONIC').replace(/\s+/g, ' ');
		const sessionId = await sessionIdOf(mnemonic);
		if (sessionId === null) off.session = 'incomplete';
		else if (net.hiddenOnly) off.session = 'zero_clearnet';
		else if (net.torSocks === '') off.session = 'no_tor';
		else session = { mnemonic, sessionId };
	}

	return {
		siteName: siteNameFromEnv(env),
		audience: v(env, 'MORPHIT_RELAY_ACCOUNT') || siteNameFromEnv(env),
		linkOrigin: linkOriginFromEnv(env, net.hiddenOnly),
		linkOrigins: linkOriginsFromEnv(env, net.hiddenOnly),
		policy: net,
		email,
		matrix,
		xmpp,
		telegram,
		session,
		off
	};
}

/** The channels this instance offers right now. */
export function offeredChannels(cfg: NotifyConfig): Channel[] {
	if (cfg.linkOrigin === null) return [];
	const out: Channel[] = [];
	// In the order the Settings card shows them.
	if (cfg.matrix) out.push('matrix');
	if (cfg.session) out.push('session');
	if (cfg.xmpp) out.push('xmpp');
	if (cfg.telegram) out.push('telegram');
	if (cfg.email) out.push('email');
	return out;
}
