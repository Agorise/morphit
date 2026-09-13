/**
 * Matrix client wrapper — thin facade over matrix-bot-sdk.
 *
 * Exposes one job: send a private DM to an MXID with both plain
 * and HTML bodies.  Hides the matrix-bot-sdk specifics so the
 * core logic (classifier + state + rate limit) stays mockable
 * for unit testing.
 *
 * Memory's @user:server vs #room:server rule enforced at the
 * type level: this module ONLY accepts MatrixMxid (branded
 * type from @morphit/operator-config).  A code path holding a
 * MatrixRoomAlias can't accidentally pass it here.
 */

import {
	MatrixClient,
	SimpleFsStorageProvider,
	RustSdkCryptoStorageProvider
} from 'matrix-bot-sdk';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MatrixMxid } from '@morphit/operator-config';

export interface MatrixSender {
	/** Send a DM to the given MXID.  Returns when the message
	 *  has been accepted by the homeserver (NOT when delivered
	 *  to the recipient's device). */
	sendDm(to: MatrixMxid, body: { plain: string; html: string }): Promise<void>;

	/** Clean shutdown. */
	stop(): Promise<void>;
}

/** A drop-in replacement used in dry-run mode + tests.  Logs
 *  what it would have sent instead of actually sending. */
export function createDryRunSender(
	log: (msg: string) => void = console.log
): MatrixSender {
	return {
		async sendDm(to, body) {
			log(`[dry-run] would DM ${to}:\n${body.plain}\n`);
		},
		async stop() {
			/* nothing to do */
		}
	};
}

/** Real Matrix sender using matrix-bot-sdk. */
export async function createMatrixSender(
	homeserver: string,
	accessToken: string,
	storageDir: string
): Promise<MatrixSender> {
	mkdirSync(storageDir, { recursive: true });
	const storage = new SimpleFsStorageProvider(join(storageDir, 'state.json'));

	/**
	 * End-to-end encryption is OFF by default, deliberately.
	 *
	 * These are operator alerts — "your disk is full", "a unit failed" — sent to
	 * the operator's own account. They are not secrets. With encryption on, every
	 * alert had to be decryptable by a device the bot had never verified, and in
	 * practice most arrived as "Unable to decrypt message". An alert you cannot
	 * read is worth nothing, so the default trades a confidentiality property
	 * nobody needed for one that always works.
	 *
	 * Set MORPHIT_MATRIX_ENCRYPT=1 to restore E2EE. Do that only if you have
	 * verified the bot's device from your client, otherwise you get unreadable
	 * alerts again. Note the alert TEXT still travels over TLS to the homeserver
	 * either way; what changes is whether the homeserver operator could read it.
	 */
	const wantEncryption = (process.env.MORPHIT_MATRIX_ENCRYPT ?? '').trim() === '1';
	let client: MatrixClient;
	if (wantEncryption) {
		mkdirSync(dirname(join(storageDir, 'crypto')), { recursive: true });
		// RustSdkCryptoStoreType is a const enum re-exported from
		// @matrix-org/matrix-sdk-crypto-nodejs.  Accessing const-enum
		// members under TS isolatedModules is forbidden; the second
		// arg is optional (the SDK default is fine for our use), so
		// we just omit it.
		const crypto = new RustSdkCryptoStorageProvider(join(storageDir, 'crypto'));
		client = new MatrixClient(homeserver, accessToken, storage, crypto);
		await client.crypto.prepare([]);
	} else {
		client = new MatrixClient(homeserver, accessToken, storage);
	}

	/**
	 * DM rooms, remembered ACROSS RESTARTS.
	 *
	 * This used to be an in-memory Map only. The bot restarts on every upgrade,
	 * so the map started empty each time and `dms.getOrCreateDm` — which relies on
	 * `m.direct` account data the SDK does not reliably maintain — created a NEW
	 * room instead of finding the old one. The operator's Matrix inbox filled up
	 * with a separate room per restart, and because each new room needs its own
	 * Megolm session shared to already-verified devices, most of those alerts
	 * arrived as "Unable to decrypt message". One bug, two symptoms.
	 *
	 * The room id is now written next to the bot's other state, so a restart
	 * reuses the same room. getOrCreateDm is only consulted when we have nothing
	 * on file.
	 */
	const roomMapPath = join(storageDir, 'dm-rooms.json');

	function loadRoomMap(): Record<string, string> {
		try {
			if (!existsSync(roomMapPath)) return {};
			const v: unknown = JSON.parse(readFileSync(roomMapPath, 'utf8'));
			if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
			const out: Record<string, string> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				if (typeof val === 'string' && val.startsWith('!')) out[k] = val;
			}
			return out;
		} catch {
			return {};
		}
	}

	function saveRoomMap(map: Record<string, string>): void {
		try {
			writeFileSync(roomMapPath, JSON.stringify(map, null, 2) + '\n');
		} catch {
			/* a bot that cannot persist still works; it just re-resolves next start */
		}
	}

	const dmRoomCache = new Map<MatrixMxid, string>();
	for (const [k, v] of Object.entries(loadRoomMap())) dmRoomCache.set(k as MatrixMxid, v);

	async function getDmRoom(to: MatrixMxid): Promise<string> {
		const cached = dmRoomCache.get(to);
		if (cached !== undefined) {
			// Trust it only if we are still in the room. If the operator left or the
			// room was upgraded, fall through and resolve a fresh one rather than
			// sending alerts into a room nobody reads.
			try {
				await client.getRoomStateEvent(cached, 'm.room.create', '');
				return cached;
			} catch {
				dmRoomCache.delete(to);
			}
		}
		const roomId = await client.dms.getOrCreateDm(to);
		dmRoomCache.set(to, roomId);
		saveRoomMap(Object.fromEntries(dmRoomCache));
		return roomId;
	}

	return {
		async sendDm(to, body) {
			const roomId = await getDmRoom(to);
			await client.sendMessage(roomId, {
				msgtype: 'm.text',
				body: body.plain,
				format: 'org.matrix.custom.html',
				formatted_body: body.html
			});
		},
		async stop() {
			await client.stop();
		}
	};
}
