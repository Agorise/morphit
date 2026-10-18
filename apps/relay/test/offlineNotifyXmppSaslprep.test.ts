/**
 * The relay logs in with the password as the server keeps it: SASLprep
 * (RFC 4013) — a no-break space becomes a space, a soft hyphen or a
 * zero-width space disappears, a ligature or an accent typed as a separate
 * mark is normalized (NFKC). Servers store a password that way (checked on
 * real Prosody 0.12: an account registered with "ﬁle-Pass-2026X" refused
 * every SCRAM login from the relay before this), so an existing account with
 * such a password could never send a note (v1.21.10 review).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { saslPrep, sendXmpp } from '../src/notify/channels/xmpp.ts';
import { TEST_CERT, fakeXmpp, type Listening } from './notifyFakes.ts';

const open: Listening[] = [];
afterEach(async () => {
	for (const l of open.splice(0)) await l.close();
});
const keep = <T extends Listening>(l: T): T => (open.push(l), l);
const direct = { torSocks: '', hiddenOnly: false };
const cfg = (port: number, password: string) => ({
	jid: 'bot@localhost',
	password,
	host: '127.0.0.1',
	port,
	security: 'starttls' as const,
	ca: TEST_CERT
});

describe('the password as the server keeps it (SASLprep)', () => {
	for (const [typed, kept] of [
		['ﬁle-Pass-2026X', 'file-Pass-2026X'],
		['Pass Word-2026', 'Pass Word-2026'],
		['Soft­Hyphen-2026x', 'SoftHyphen-2026x'],
		['Zero​Width-2026x', 'ZeroWidth-2026x'],
		['Café-Pass-2026', 'Café-Pass-2026']
	] as const) {
		it(`${JSON.stringify(typed)}: logs in with SCRAM and with PLAIN`, async () => {
			expect(saslPrep(typed)).toBe(kept);
			for (const mechs of [['SCRAM-SHA-256'], ['PLAIN']]) {
				const x = keep(await fakeXmpp({ mechs, password: kept }));
				await sendXmpp(cfg(x.port, typed), direct, 'grandma@example.org', 'hi', 10_000);
				expect(x.messages, mechs[0]).toHaveLength(1);
			}
		});
	}

	it('an ordinary password is sent as it is', async () => {
		expect(saslPrep('Tr4in-Lamp-Stone ü')).toBe('Tr4in-Lamp-Stone ü');
		const x = keep(await fakeXmpp({ mechs: ['SCRAM-SHA-256'], password: 'Tr4in-Lamp-Stone' }));
		await sendXmpp(cfg(x.port, 'Tr4in-Lamp-Stone'), direct, 'grandma@example.org', 'hi', 10_000);
		expect(x.messages).toHaveLength(1);
	});
});
