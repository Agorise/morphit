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
import { mkdirSync } from 'node:fs';
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
	mkdirSync(dirname(join(storageDir, 'crypto')), { recursive: true });
	// RustSdkCryptoStoreType is a const enum re-exported from
	// @matrix-org/matrix-sdk-crypto-nodejs.  Accessing const-enum
	// members under TS isolatedModules is forbidden; the second
	// arg is optional (the SDK default is fine for our use), so
	// we just omit it.
	const crypto = new RustSdkCryptoStorageProvider(join(storageDir, 'crypto'));
	const client = new MatrixClient(homeserver, accessToken, storage, crypto);
	// crypto.prepare() takes the list of rooms to bootstrap for
	// E2E session-state.  We start with an empty list — DM rooms
	// for each operator MXID are created lazily on first send via
	// client.dms.getOrCreateDm() which handles its own crypto
	// setup for the new room.
	await client.crypto.prepare([]);

	/** DM rooms are looked up on first DM to each recipient and
	 *  cached for the bot's lifetime.  Matrix protocol: a DM is
	 *  just a private 2-person room marked as such; finding-or-
	 *  creating one is matrix-bot-sdk's `dms.getOrCreateDm`. */
	const dmRoomCache = new Map<MatrixMxid, string>();

	async function getDmRoom(to: MatrixMxid): Promise<string> {
		const cached = dmRoomCache.get(to);
		if (cached !== undefined) return cached;
		const roomId = await client.dms.getOrCreateDm(to);
		dmRoomCache.set(to, roomId);
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
