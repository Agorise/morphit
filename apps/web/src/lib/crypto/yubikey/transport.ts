/**
 * Morphit — YubiKey WebHID transport (Batch I, ADR-0017).
 *
 * Browser-only.  Speaks the Yubico OTP-applet HID feature-report
 * protocol to perform an HMAC-SHA1 challenge-response operation
 * against slot 1 or slot 2.
 *
 * --- Why WebHID and not WebAuthn ---
 *
 * WebAuthn / U2F use ECDSA over P-256.  Blurt uses secp256k1.  The
 * curves are different sizes and parameters; signatures from the
 * key cannot replace signatures from a Blurt posting key.  WebAuthn
 * is therefore wrong protocol for our threat model — see ADR-0017
 * threat model section.
 *
 * WebHID, on the other hand, gives us a raw byte channel to the
 * YubiKey's OTP applet.  We use the HMAC-SHA1 challenge-response
 * mode (factory-programmable into slot 2 via YubiKey Manager /
 * ykman; KeePassXC and age-yubikey use the same pattern).
 *
 * --- Browser support ---
 *
 * navigator.hid is Chromium-only as of writing.  Firefox and Safari
 * users can't use this feature; we surface a clear "not supported"
 * UI and let them keep using the passphrase wrap.
 *
 * --- STATUS: implemented per the Yubico OTP HID protocol; validate on hardware ---
 *
 * The HID frame protocol for HMAC-SHA1 challenge-response is
 * documented in Yubico's yubikey-personalization library (C):
 * ykcore/ykcore.c (`yk_write_to_key`, `yk_read_response_from_key`,
 * `yk_wait_for_key_status`) and ykcore/ykdef.h (flag bytes).  This
 * transport implements that protocol faithfully:
 *
 *   SEND — the 64-byte challenge is wrapped in a 70-byte YK_FRAME:
 *     [0..63] challenge, [64] slot command (0x30 slot 1 / 0x38 slot
 *     2), [65..66] CRC-16 of [0..63] little-endian, [67..69] filler.
 *     The frame is sent as ten 8-byte feature reports, each
 *     [7 frame bytes][SLOT_WRITE_FLAG(0x80) | seq(0..9)]; all-zero
 *     intermediate chunks are skipped (the applet zero-fills and the
 *     seq identifies the slot), and between non-final chunks we wait
 *     for the applet to clear SLOT_WRITE_FLAG in its status byte.
 *
 *   READ — the applet SETS RESP_PENDING (0x40) once a response chunk
 *     is ready, the low bits carrying that chunk's sequence number.
 *     We accept a chunk only when its seq equals the one we expect
 *     next (dropping duplicate/stale reads), assembling the 20-byte
 *     HMAC-SHA1 across three chunks (7+7+6).  RESP_TIMEOUT_WAIT (0x20)
 *     means the applet is waiting for a touch.  Before the frame and
 *     after the read we write a dummy report (0x8f) to return the
 *     applet to a clean idle state.
 *
 * The wrap/unwrap math (wrap.ts) is independently smoke-tested with a
 * deterministic stub HMAC.  This byte channel, however, cannot run in
 * CI — WebHID has no sandbox — so it is a hardware-INFORMED
 * implementation that has NOT yet been proven end-to-end against a
 * physical YubiKey in this tree.  Before relying on it, prove a full
 * enroll -> reload -> unlock round-trip in a real Chromium browser
 * with a real key.  The dev probe page (/dev/yubikey-probe) wires a
 * byte-level TransportLogger for exactly this: it records every
 * send/recv/status-poll so a failing transaction can be diagnosed
 * without a USB analyzer.
 *
 * --- Safety: fail-closed enrollment gate ---
 *
 * Even with the protocol implemented, enrollment does NOT trust a
 * single tap.  A subtly-wrong transport could yield challenge-
 * INDEPENDENT output; committing a wrap around a CONSTANT (e.g.
 * all-zero) response would be a "2FA factor" unlockable by a known
 * constant — security theatre.  So enrollment goes through
 * `buildVerifiedYubikeyWrap` (wrap.ts), which sends two DISTINCT
 * challenges and refuses to enroll unless the responses DIFFER
 * (`verifyYubikeyChallengeResponse`).  That rejects constant /
 * zero-entropy / dead transports up front, fail-closed.  The
 * passphrase wrap remains as an escape hatch, so a bad or
 * misconfigured YubiKey can never lock a user out.
 *
 * --- Touch UX ---
 *
 * YubiKey HMAC-SHA1 mode can be configured to require a touch
 * before the response is computed (YubiKey Manager's "require
 * touch" toggle).  We don't enforce or detect this — the YubiKey
 * itself will simply hold the response until the user taps; our
 * read loop blocks until the response is delivered.  The UI shows
 * a "tap your YubiKey" prompt during this wait.
 */

import { YUBIKEY_CHALLENGE_BYTES, YUBIKEY_HMAC_OUTPUT_BYTES, type YubikeySlot } from './protocol';
import type { YubikeyHmacFn } from './wrap';

/** Yubico USB vendor ID. */
const YUBICO_VENDOR_ID = 0x1050;

/** OTP-applet HID command bytes for slot 1 / slot 2 HMAC-SHA1
 *  (ykdef.h SLOT_CHAL_HMAC1 / SLOT_CHAL_HMAC2). */
const CMD_HMAC_SLOT_1 = 0x30;
const CMD_HMAC_SLOT_2 = 0x38;

/** Flag/status bits in the feature-report status byte (ykdef.h).
 *   - SLOT_WRITE_FLAG: host sets on each write chunk; the applet
 *     clears it in its status once it has consumed the chunk.
 *   - RESP_PENDING_FLAG: the applet sets it when a response chunk is
 *     ready to read; the low bits (SEQ_MASK) carry that chunk's seq.
 *   - RESP_TIMEOUT_WAIT_FLAG: the applet is waiting for a user touch
 *     (low 5 bits = seconds remaining).
 *   - DUMMY_REPORT_WRITE: a write with this flag resets/aborts the
 *     applet to a clean idle state. */
const SLOT_WRITE_FLAG = 0x80;
const RESP_PENDING_FLAG = 0x40;
const RESP_TIMEOUT_WAIT_FLAG = 0x20;
const DUMMY_REPORT_WRITE = 0x8f;
const SEQ_MASK = 0x1f;

/** The 70-byte challenge frame: 64 payload + 1 slot + 2 CRC (LE) + 3 filler. */
const YK_FRAME_SIZE = 70;

/** Each HID feature report is 8 bytes.  Report ID 0 is numberless, so
 *  all 8 bytes are data: [0..6] frame/response bytes, [7] flag/status. */
const FEATURE_REPORT_SIZE = 8;
const FEATURE_PAYLOAD_SIZE = 7;

/** Feature report ID 0 is the OTP applet's report. */
const REPORT_ID = 0;

/** Yubico CRC-16 (reflected CCITT: poly 0x8408, init 0xffff, no final
 *  xor).  ykcore stores crc16(payload[0..63]) little-endian in the
 *  frame; the applet recomputes over payload+crc and checks the
 *  0xf0b8 residual, silently rejecting the frame (→ no response → our
 *  read times out) if the CRC is wrong.  Byte-for-byte port of
 *  `yubikey_crc16` from Yubico's yubikey-c / ykcore. */
function yubicoCrc16(data: Uint8Array): number {
	let crc = 0xffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i]! & 0xff;
		for (let bit = 0; bit < 8; bit++) {
			const lsb = crc & 1;
			crc >>= 1;
			if (lsb) crc ^= 0x8408;
		}
	}
	return crc & 0xffff;
}

/**
 * Returns true if this browser supports WebHID at all.  Used by
 * /settings/hardware-key to gate the YubiKey UI behind a feature
 * detection.  Firefox/Safari fall through to a "not supported"
 * card.
 */
export function isWebHidSupported(): boolean {
	if (typeof navigator === 'undefined') return false;
	return 'hid' in navigator;
}

/** A YubiKey HID device that the user has selected via the
 *  navigator.hid permission prompt.  Wraps the raw HIDDevice with
 *  the HMAC-SHA1 protocol logic. */
export interface YubikeyDevice {
	/** Friendly product name from the descriptor.  Used as a default
	 *  for the user-supplied label at enrollment time. */
	readonly productName: string;
	/** Perform an HMAC-SHA1 challenge-response against the configured
	 *  slot.  Resolves with the 20-byte HMAC output, or rejects on
	 *  USB error / timeout / device removed. */
	readonly hmac: YubikeyHmacFn;
	/** Release the device handle.  Callers must invoke when done. */
	readonly close: () => Promise<void>;
}

/**
 * Optional logger callback the transport invokes for every USB
 * transaction.  Production code passes nothing; the dev probe page
 * passes a function that records each entry into a UI-visible log.
 * Format mirrors what a USB analyzer would show:
 *
 *   - direction: 'send' or 'recv' or 'note'
 *   - bytes:     the raw 7-byte payload (excluding report ID)
 *   - note:      free-form annotation, e.g. "frame 0 of 8"
 */
export type TransportLogger = (entry: TransportLogEntry) => void;
export interface TransportLogEntry {
	readonly direction: 'send' | 'recv' | 'note';
	readonly bytes?: Uint8Array;
	readonly note?: string;
	readonly status?: number;
	readonly timestamp: number;
}

/**
 * Prompt the user to pick a YubiKey via the WebHID permission UI.
 * Returns a device handle bound to the chosen slot.
 *
 * @param slot Which YubiKey slot to use (1 or 2).  Slot 2 is the
 *             conventional default for HMAC-SHA1; slot 1 is usually
 *             reserved for the keyboard-emulating Yubico OTP.
 * @param logger Optional callback for byte-level transport visibility.
 *               Production callers omit; the dev probe page wires a
 *               UI-visible recorder.
 *
 * Throws:
 *   - 'webhid-unsupported' on Firefox / Safari
 *   - 'no-device-selected' if the user dismissed the picker
 *   - 'open-failed' if the device couldn't be opened
 */
export async function requestYubikey(
	slot: YubikeySlot,
	logger?: TransportLogger
): Promise<YubikeyDevice> {
	if (!isWebHidSupported()) {
		throw new Error('webhid-unsupported');
	}
	// Cast through unknown — the WebHID typings aren't in TS lib.dom
	// for all targets.  We type the surface manually below.
	const hid = (navigator as unknown as { hid: WebHidApi }).hid;
	const devices = await hid.requestDevice({
		filters: [{ vendorId: YUBICO_VENDOR_ID }]
	});
	if (devices.length === 0) {
		throw new Error('no-device-selected');
	}
	const device = devices[0]!;
	try {
		await device.open();
	} catch {
		throw new Error('open-failed');
	}
	logger?.({
		direction: 'note',
		note: `device opened: ${device.productName ?? 'YubiKey'}`,
		timestamp: Date.now()
	});
	return {
		productName: device.productName ?? 'YubiKey',
		hmac: makeHmacFn(device, slot, logger),
		close: () => device.close()
	};
}

/** Poll the applet's status byte until SLOT_WRITE_FLAG has cleared —
 *  i.e. the applet has consumed the chunk we just wrote and is ready
 *  for the next.  Only ever called during the write phase (before any
 *  response exists), so these reads never consume response chunks.
 *  Throws the classifiable short-report / timeout errors on failure. */
async function waitForWriteFlagClear(device: HIDDevice, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const dv = await device.receiveFeatureReport(REPORT_ID);
		const view = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
		if (view.byteLength < FEATURE_REPORT_SIZE) {
			throw new Error(
				`yubikey: short feature report (got ${view.byteLength} bytes, expected ${FEATURE_REPORT_SIZE})`
			);
		}
		if ((view[FEATURE_PAYLOAD_SIZE]! & SLOT_WRITE_FLAG) === 0) return;
		await sleep(2);
	}
	throw new Error('YubiKey HMAC timed out — write handshake did not settle');
}

/** Best-effort reset of the applet to a clean idle state: write a
 *  dummy report (flag 0x8f).  Sent before a transaction (to flush any
 *  leftover response from an aborted op) and after reading the
 *  response (ykcore's post-read reset).  Non-fatal on error — a reset
 *  failure doesn't corrupt the transaction itself. */
async function resetApplet(device: HIDDevice, logger?: TransportLogger): Promise<void> {
	const report = new Uint8Array(FEATURE_REPORT_SIZE);
	report[FEATURE_PAYLOAD_SIZE] = DUMMY_REPORT_WRITE;
	try {
		await device.sendFeatureReport(REPORT_ID, report);
		logger?.({ direction: 'note', note: 'reset applet (dummy 0x8f)', timestamp: Date.now() });
	} catch {
		/* non-fatal */
	}
}

/** Bind an HID device + slot to a single-shot HMAC function.
 *
 *  The returned function performs one challenge-response transaction
 *  on each invocation.  Calling it multiple times sequentially is
 *  fine; concurrent calls are NOT safe (the OTP applet is single-
 *  threaded) and the transport doesn't serialize.  Callers should
 *  await between invocations.
 *
 *  When a logger is supplied, every send / receive / status-poll is
 *  reported.  This is the dev-probe path; production omits. */
function makeHmacFn(device: HIDDevice, slot: YubikeySlot, logger?: TransportLogger): YubikeyHmacFn {
	// L3 fix: defensive runtime check.  TypeScript types prevent
	// callers from passing arbitrary slot values, but values reaching
	// here from JSON-parsed envelopes aren't type-checked.  Without
	// this, a tampered envelope with slot=99 would silently fall
	// through to slot 2.
	if (slot !== 1 && slot !== 2) {
		throw new Error(`makeHmacFn: invalid slot ${slot} — must be 1 or 2`);
	}
	const cmd = slot === 1 ? CMD_HMAC_SLOT_1 : CMD_HMAC_SLOT_2;
	return async (challenge: Uint8Array): Promise<Uint8Array> => {
		if (challenge.length !== YUBIKEY_CHALLENGE_BYTES) {
			throw new Error(
				`hmac: challenge must be ${YUBIKEY_CHALLENGE_BYTES} bytes, got ${challenge.length}`
			);
		}

		// ── Build the 70-byte YK_FRAME ────────────────────────────────
		//   [0..63]  challenge (YUBIKEY_CHALLENGE_BYTES === 64)
		//   [64]     slot command (0x30 / 0x38)
		//   [65..66] CRC-16 of [0..63], little-endian
		//   [67..69] filler (zero)
		const frame = new Uint8Array(YK_FRAME_SIZE);
		frame.set(challenge, 0);
		frame[YUBIKEY_CHALLENGE_BYTES] = cmd;
		const crc = yubicoCrc16(frame.subarray(0, YUBIKEY_CHALLENGE_BYTES));
		frame[YUBIKEY_CHALLENGE_BYTES + 1] = crc & 0xff;
		frame[YUBIKEY_CHALLENGE_BYTES + 2] = (crc >> 8) & 0xff;

		const WRITE_SETTLE_MS = 1_000;
		const RESPONSE_TIMEOUT_MS = 30_000; // generous — lets users find + tap their key
		const POLL_INTERVAL_MS = 20;

		// Flush any leftover applet state from a prior (aborted) op, then
		// wait for the applet to be idle before we start writing.
		await resetApplet(device, logger);
		await waitForWriteFlagClear(device, WRITE_SETTLE_MS);

		// ── Send the frame as ten 7-byte reports ──────────────────────
		//   report = [7 frame bytes][SLOT_WRITE_FLAG | seq(0..9)].
		//   All-zero intermediate chunks are skipped (the applet
		//   zero-fills the frame and the seq identifies each chunk's
		//   slot), but seq 0 and the final seq are always sent.  Between
		//   non-final chunks we wait for SLOT_WRITE_FLAG to clear so the
		//   applet has consumed the previous chunk.  We do NOT wait after
		//   the final chunk — the read loop below picks up the transition
		//   to the response, so no read is wasted before response seq 0.
		const FRAMES = YK_FRAME_SIZE / FEATURE_PAYLOAD_SIZE; // 70 / 7 = 10
		for (let seq = 0; seq < FRAMES; seq++) {
			const offset = seq * FEATURE_PAYLOAD_SIZE;
			const chunk = frame.subarray(offset, offset + FEATURE_PAYLOAD_SIZE);
			const isLast = seq === FRAMES - 1;
			let allZero = true;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] !== 0) {
					allZero = false;
					break;
				}
			}
			if (seq !== 0 && !isLast && allZero) continue;

			const report = new Uint8Array(FEATURE_REPORT_SIZE);
			report.set(chunk, 0);
			report[FEATURE_PAYLOAD_SIZE] = SLOT_WRITE_FLAG | seq;

			await device.sendFeatureReport(REPORT_ID, report);
			logger?.({
				direction: 'send',
				bytes: chunk.slice(),
				status: SLOT_WRITE_FLAG | seq,
				note: `frame seq ${seq}/${FRAMES - 1}${isLast ? ' (final, slot cmd)' : ''}`,
				timestamp: Date.now()
			});

			if (!isLast) await waitForWriteFlagClear(device, WRITE_SETTLE_MS);
		}

		// ── Read the 20-byte HMAC-SHA1 response ───────────────────────
		//   The applet SETS RESP_PENDING (0x40) when a response chunk is
		//   ready; the low bits carry its sequence number.  We accept a
		//   chunk only when its seq equals the one we expect next
		//   (dropping duplicate/stale reads), assembling 20 bytes across
		//   three chunks (7+7+6).  RESP_TIMEOUT_WAIT (0x20) means the
		//   applet is waiting for a touch; SLOT_WRITE_FLAG still set
		//   means the last write is still settling; idle (0x00) after we
		//   already have bytes means the response is complete.
		const out = new Uint8Array(YUBIKEY_HMAC_OUTPUT_BYTES);
		let outLen = 0;
		let expectedSeq = 0;
		const start = Date.now();
		while (Date.now() - start < RESPONSE_TIMEOUT_MS) {
			const dv = await device.receiveFeatureReport(REPORT_ID);
			const view = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
			if (view.byteLength < FEATURE_REPORT_SIZE) {
				throw new Error(
					`yubikey: short feature report (got ${view.byteLength} bytes, expected ${FEATURE_REPORT_SIZE})`
				);
			}
			const status = view[FEATURE_PAYLOAD_SIZE]!;

			if (status & RESP_PENDING_FLAG) {
				const seq = status & SEQ_MASK;
				const isNext = seq === expectedSeq;
				logger?.({
					direction: 'recv',
					bytes: view.slice(0, FEATURE_PAYLOAD_SIZE),
					status,
					note: `RESP_PENDING seq ${seq}${isNext ? '' : ' (duplicate/stale, ignored)'}`,
					timestamp: Date.now()
				});
				if (isNext) {
					const take = Math.min(FEATURE_PAYLOAD_SIZE, YUBIKEY_HMAC_OUTPUT_BYTES - outLen);
					for (let i = 0; i < take; i++) out[outLen + i] = view[i]!;
					outLen += take;
					expectedSeq++;
					if (outLen >= YUBIKEY_HMAC_OUTPUT_BYTES) break;
				}
				continue; // read the next chunk immediately
			}

			if (status & RESP_TIMEOUT_WAIT_FLAG) {
				logger?.({
					direction: 'recv',
					status,
					note: 'RESP_TIMEOUT_WAIT (tap your YubiKey)',
					timestamp: Date.now()
				});
				await sleep(POLL_INTERVAL_MS);
				continue;
			}

			if (status & SLOT_WRITE_FLAG) {
				// The final write is still being consumed; keep polling.
				await sleep(POLL_INTERVAL_MS);
				continue;
			}

			// Idle status (0x00).  If we've already drained chunks the
			// response is complete; otherwise the applet is still
			// computing the HMAC — keep polling.
			logger?.({
				direction: 'recv',
				status,
				note: outLen > 0 ? 'idle (response complete)' : 'idle (computing HMAC)',
				timestamp: Date.now()
			});
			if (outLen > 0) break;
			await sleep(POLL_INTERVAL_MS);
		}

		// Return the applet to a clean idle state for the next op.
		await resetApplet(device, logger);

		if (outLen < YUBIKEY_HMAC_OUTPUT_BYTES) {
			throw new Error('YubiKey HMAC timed out — touch your key or check the connection');
		}
		return out;
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────────────────────────
// WebHID typing surface
//
// TypeScript's lib.dom.d.ts has WebHID types in newer versions but
// our tsconfig targets ES2022 where they may not all be present.
// We declare the minimal surface we need so the file typechecks
// without depending on the lib version.
// ──────────────────────────────────────────────────────────────────

interface HIDDevice {
	readonly productName?: string;
	open(): Promise<void>;
	close(): Promise<void>;
	sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
	receiveFeatureReport(reportId: number): Promise<DataView>;
}

interface WebHidApi {
	requestDevice(opts: {
		filters: Array<{ vendorId?: number; productId?: number }>;
	}): Promise<HIDDevice[]>;
}
