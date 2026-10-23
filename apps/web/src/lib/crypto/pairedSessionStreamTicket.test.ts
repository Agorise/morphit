// @vitest-environment jsdom
/**
 * A paired desktop keeps the chat-stream ticket its phone signed
 * (v1.21.14 full chat audit, S-M8; the pairing half is
 * auth/pairingStreamTicket.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { readPairedSession, writePairedSession, clearPairedSession } from './pairedSession';

const NOW = Math.floor(Date.now() / 1000);

describe('the paired-session record', () => {
	it('the paired-session record keeps it, and refuses a malformed one', () => {
		const base = {
			v: 1 as const,
			account: 'grandma',
			chatPubkey: 'chat-pub-0123456789',
			pairingId: 'pairing-0001',
			pairedAt: NOW
		};
		writePairedSession({ ...base, streamTicket: 'payload.sig' });
		expect(readPairedSession()?.streamTicket).toBe('payload.sig');
		writePairedSession({ ...base, streamTicket: 'x'.repeat(601) });
		expect(readPairedSession()).toBeNull();
		writePairedSession(base);
		expect(readPairedSession()?.streamTicket).toBeUndefined();
		clearPairedSession();
	});
});
