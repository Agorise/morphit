/**
 * Offline notices — email, through the operator's own mail account (SMTP
 * submission). A minimal client: EHLO, STARTTLS (port 587) or TLS from the
 * first byte (port 465), AUTH PLAIN (or LOGIN), one message, QUIT. The
 * password is only ever sent over TLS.
 *
 * The message is plain text, UTF-8 (quoted-printable body, RFC 2047 subject),
 * with no tracking, no images, no HTML. The recipient's address goes only into
 * the envelope and the To: header; it is never logged, and a server's error
 * text (which may repeat it) is never passed on — only its three-digit code.
 */

import { randomBytes } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { isOnionHost, openSocket, startTls, type NetPolicy } from '../net.ts';

export interface SmtpConfig {
	readonly host: string;
	readonly port: number;
	/** 'starttls' (587) or 'tls' (465). */
	readonly security: 'starttls' | 'tls';
	readonly user: string;
	readonly password: string;
	/** The From address (the operator's). */
	readonly from: string;
	/** Trust exactly this certificate instead of the system's (a self-hosted
	 *  mail server with its own certificate). */
	readonly ca?: string;
}

export class SmtpError extends Error {
	constructor(
		readonly stage: string,
		readonly code: number
	) {
		super(`mail server refused at ${stage} (${code})`);
		this.name = 'SmtpError';
	}
}

/**
 * The From line's name: encoded words when it is not plain ASCII, else always
 * a quoted string — a site name with a dot, a comma or a quote in it ("Trading
 * Co.") is otherwise not a valid name and breaks the header.
 */
export function displayName(name: string): string {
	const clean = name.replace(/[\r\n]+/g, ' ');
	if (!/^[\x20-\x7e]*$/.test(clean)) return encodeHeader(clean);
	return `"${clean.replace(/[\\"]/g, '\\$&')}"`;
}

/** RFC 2047 encoded-word for a header value that is not plain ASCII. PURE. */
export function encodeHeader(v: string): string {
	const clean = v.replace(/[\r\n]+/g, ' ');
	if (/^[\x20-\x7e]*$/.test(clean)) return clean;
	// Split into encoded words of at most ~45 bytes so lines stay short.
	const words: string[] = [];
	let cur = '';
	for (const ch of clean) {
		if (Buffer.byteLength(cur + ch, 'utf8') > 45) {
			words.push(cur);
			cur = '';
		}
		cur += ch;
	}
	if (cur !== '') words.push(cur);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Quoted-printable body (RFC 2045), CRLF line ends, dot-stuffing left to
 *  the caller. PURE. */
export function quotedPrintable(text: string): string {
	const out: string[] = [];
	for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
		let enc = '';
		for (const b of Buffer.from(line, 'utf8')) {
			enc +=
				(b >= 33 && b <= 126 && b !== 61) || b === 32
					? String.fromCharCode(b)
					: `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
		}
		// A trailing space must be encoded.
		enc = enc.replace(/ $/, '=20');
		// Soft line breaks at 75 characters, never inside an =XX.
		while (enc.length > 75) {
			let cut = 75;
			if (enc[cut - 1] === '=') cut -= 1;
			else if (enc[cut - 2] === '=') cut -= 2;
			out.push(`${enc.slice(0, cut)}=`);
			enc = enc.slice(cut);
		}
		out.push(enc);
	}
	return out.join('\r\n');
}

/** The whole message, ready for DATA (dot-stuffed, CRLF). PURE apart from the
 *  Message-ID and Date. */
export function buildMessage(
	cfg: { from: string; fromName: string },
	to: string,
	subject: string,
	body: string,
	now = new Date()
): string {
	const domain = cfg.from.slice(cfg.from.lastIndexOf('@') + 1);
	const headers = [
		`From: ${displayName(cfg.fromName)} <${cfg.from}>`,
		`To: <${to}>`,
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${now.toUTCString().replace('GMT', '+0000')}`,
		`Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: quoted-printable',
		'Auto-Submitted: auto-generated'
	];
	const text = `${headers.join('\r\n')}\r\n\r\n${quotedPrintable(body)}`;
	return text
		.split('\r\n')
		.map((l) => (l.startsWith('.') ? `.${l}` : l))
		.join('\r\n');
}

/** The most a mail server's reply may hold before it is refused. */
export const MAX_REPLY_CHARS = 64 * 1024;

/** Reads SMTP replies (multi-line aware) from a socket. */
class ReplyReader {
	private buf = '';
	private waiters: Array<(r: { code: number; lines: string[] }) => void> = [];
	private failers: Array<(e: Error) => void> = [];
	private failed: Error | null = null;
	constructor(private sock: net.Socket | tls.TLSSocket) {
		this.attach(sock);
	}
	attach(sock: net.Socket | tls.TLSSocket): void {
		this.sock = sock;
		// Bytes, not setEncoding: the same socket is handed to TLS after
		// STARTTLS, and an encoding set on it would corrupt the handshake.
		sock.on('data', (d: Buffer) => {
			this.buf += d.toString('utf8');
			// No real reply is near this size; an endless one is a server (or
			// someone in front of it before TLS) trying to eat memory and CPU.
			if (this.buf.length > MAX_REPLY_CHARS) {
				this.buf = '';
				this.fail(new SmtpError('reply too long', 0));
				sock.destroy();
				return;
			}
			this.pump();
		});
		sock.on('error', (e) => this.fail(e));
		sock.on('close', () => this.fail(new Error('mail server closed the connection')));
	}
	/** Whether bytes arrived that no reply was waiting for. */
	get leftover(): boolean {
		return this.buf.length > 0;
	}
	detach(): void {
		this.sock.removeAllListeners('data');
		this.sock.removeAllListeners('error');
		this.sock.removeAllListeners('close');
	}
	private fail(e: Error): void {
		this.failed = e;
		for (const f of this.failers.splice(0)) f(e);
		this.waiters = [];
	}
	private pump(): void {
		for (;;) {
			const lines: string[] = [];
			let rest = this.buf;
			let complete = false;
			for (;;) {
				const i = rest.indexOf('\n');
				if (i < 0) break;
				const line = rest.slice(0, i).replace(/\r$/, '');
				rest = rest.slice(i + 1);
				lines.push(line);
				if (/^\d{3}(?: |$)/.test(line)) {
					complete = true;
					break;
				}
			}
			if (!complete || this.waiters.length === 0) return;
			this.buf = rest;
			const w = this.waiters.shift()!;
			this.failers.shift();
			w({ code: Number(lines[lines.length - 1]!.slice(0, 3)), lines });
		}
	}
	next(timeoutMs: number): Promise<{ code: number; lines: string[] }> {
		if (this.failed) return Promise.reject(this.failed);
		return new Promise((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error('mail server did not answer in time')),
				timeoutMs
			);
			this.waiters.push((r) => {
				clearTimeout(t);
				resolve(r);
			});
			this.failers.push((e) => {
				clearTimeout(t);
				reject(e);
			});
			this.pump();
		});
	}
}

export async function sendMail(
	cfg: SmtpConfig,
	fromName: string,
	to: string,
	subject: string,
	body: string,
	policy: NetPolicy,
	timeoutMs = 60_000
): Promise<void> {
	const raw = await openSocket(cfg.host, cfg.port, policy, { timeoutMs });
	const onion = isOnionHost(cfg.host);
	// An .onion address IS the server's key: Tor proves who answers and
	// encrypts the connection end to end, and no public authority issues
	// certificates for .onion names. So there the certificate is not checked
	// (unless one is pinned), and a server without STARTTLS is accepted.
	const tlsOpts =
		cfg.ca !== undefined ? { ca: cfg.ca } : onion ? { rejectUnauthorized: false } : {};
	let sock: net.Socket | tls.TLSSocket =
		cfg.security === 'tls' ? await startTls(raw, cfg.host, tlsOpts) : raw;
	const reader = new ReplyReader(sock);
	const expect = async (stage: string, ok: (c: number) => boolean): Promise<string[]> => {
		const r = await reader.next(timeoutMs);
		if (!ok(r.code)) throw new SmtpError(stage, r.code);
		return r.lines;
	};
	const send = (line: string): void => {
		sock.write(`${line}\r\n`);
	};
	try {
		await expect('greeting', (c) => c === 220);
		const helo = 'localhost';
		send(`EHLO ${helo}`);
		let caps = await expect('EHLO', (c) => c === 250);
		const offersStartTls = caps.some((l) => /^250[ -]STARTTLS\b/i.test(l));
		if (cfg.security === 'starttls' && !offersStartTls && !onion)
			throw new SmtpError('STARTTLS (not offered)', 0);
		if (cfg.security === 'starttls' && offersStartTls) {
			send('STARTTLS');
			await expect('STARTTLS', (c) => c === 220);
			// Anything the server "said" after its go-ahead was sent before TLS:
			// someone in the middle may have put it there (STARTTLS injection).
			if (reader.leftover) throw new SmtpError('STARTTLS (data before the TLS handshake)', 0);
			reader.detach();
			sock = await startTls(sock as net.Socket, cfg.host, tlsOpts);
			reader.attach(sock);
			send(`EHLO ${helo}`);
			caps = await expect('EHLO', (c) => c === 250);
		}
		const auth = caps.find((l) => /^250[ -]AUTH\b/i.test(l)) ?? '';
		if (/\bPLAIN\b/i.test(auth)) {
			send(
				`AUTH PLAIN ${Buffer.from(`\u0000${cfg.user}\u0000${cfg.password}`, 'utf8').toString('base64')}`
			);
			await expect('AUTH', (c) => c === 235);
		} else if (/\bLOGIN\b/i.test(auth)) {
			send('AUTH LOGIN');
			await expect('AUTH', (c) => c === 334);
			send(Buffer.from(cfg.user, 'utf8').toString('base64'));
			await expect('AUTH', (c) => c === 334);
			send(Buffer.from(cfg.password, 'utf8').toString('base64'));
			await expect('AUTH', (c) => c === 235);
		} else {
			throw new SmtpError('AUTH (no PLAIN or LOGIN offered)', 0);
		}
		send(`MAIL FROM:<${cfg.from}>`);
		await expect('MAIL FROM', (c) => c === 250);
		send(`RCPT TO:<${to}>`);
		await expect('RCPT TO', (c) => c === 250 || c === 251);
		send('DATA');
		await expect('DATA', (c) => c === 354);
		sock.write(`${buildMessage({ from: cfg.from, fromName }, to, subject, body)}\r\n.\r\n`);
		await expect('message', (c) => c === 250);
		send('QUIT');
		await reader.next(5_000).catch(() => undefined);
	} finally {
		reader.detach();
		sock.destroy();
	}
}
