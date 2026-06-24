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
 * mode (factory-programmable into slot 2 via Yubico Authenticator;
 * KeePassXC and age-yubikey use the same pattern).
 *
 * --- Browser support ---
 *
 * navigator.hid is Chromium-only as of writing.  Firefox and Safari
 * users can't use this feature; we surface a clear "not supported"
 * UI and let them keep using the passphrase wrap.
 *
 * --- STATUS: this transport is NOT correct yet (do not trust it) ---
 *
 * The HID frame protocol for HMAC-SHA1 is documented in Yubico's
 * yubikey-personalization library (C): ykcore/ykcore.c
 * (`yk_write_to_key`, `yk_read_response_from_key`,
 * `yk_wait_for_key_status`) and ykcore/ykdef.h (flag bytes).  A
 * close read against that source shows this TypeScript port has
 * SEVERAL defects, not the single "frame layout" nit an earlier
 * comment here claimed.  None can be fixed blind — they need a
 * physical YubiKey on the bench — so they are documented here in
 * full to set up that session, and a fail-closed enrollment gate
 * (below) prevents the dangerous outcomes in the meantime.
 *
 * SEND-path defects:
 *   1. No 70-byte YK_FRAME.  Yubico wraps the (≤64-byte) challenge
 *      in a 70-byte frame: payload[0..63] zero-padded challenge,
 *      payload[64] = slot command (0x30/0x38), payload[65..66] =
 *      CRC16 of payload[0..63] (little-endian), payload[67..69] =
 *      filler.  This code sends raw challenge chunks with the
 *      command byte misplaced and NO CRC16, so the key's frame-CRC
 *      check rejects the write.
 *   2. Wrong per-report sequence/flag byte.  Every 8-byte report is
 *      [7 frame bytes][SLOT_WRITE_FLAG(0x80) | seq(0..9)].  This
 *      code writes the frame index on non-final reports and
 *      (command | 0x80) on the last — neither matches Yubico's
 *      framing.
 *
 * READ-path defects:
 *   3. RESP_PENDING_FLAG (0x40) polarity is INVERTED.  Per
 *      `yk_read_response_from_key` → `yk_wait_for_key_status(...,
 *      mask=RESP_PENDING_FLAG, logic=0/AND-zero)`, the key SETS 0x40
 *      when response bytes are ready to read and the host CLEARS it
 *      as it drains them.  This code waits WHILE 0x40 is set and
 *      reads once it CLEARS — exactly backwards — so it reads device
 *      status instead of the HMAC.  (This is the defect most likely
 *      to yield challenge-INDEPENDENT output, which is precisely what
 *      the enrollment gate below is designed to catch.)
 *   4. No sequence de-duplication.  Response reports carry a seq in
 *      the low bits; a repeated/duplicate report must be skipped or
 *      the assembled 20-byte HMAC is corrupted.
 *   5. No device reset after read.  Yubico writes a dummy report
 *      (flag byte 0x8f) to return the key to a clean state; omitting
 *      it can leave the applet mid-transaction for the next op.
 *
 * Wrap/unwrap math (wrap.ts) is independently smoke-tested with a
 * deterministic stub HMAC and is sound; the failures above live
 * ENTIRELY in this byte channel and only manifest against real
 * hardware.
 *
 * --- Interim safety: fail-closed enrollment gate ---
 *
 * Because defect #3 most likely produces challenge-INDEPENDENT
 * output, a naive single-tap enroll could silently commit a wrap
 * around a CONSTANT (e.g. all-zero) response — a "2FA factor"
 * unlockable by a known constant, i.e. security theatre.  To prevent
 * that until this transport is fixed on hardware, enrollment goes
 * through `buildVerifiedYubikeyWrap` (wrap.ts), which sends two
 * DISTINCT challenges and refuses to enroll unless the responses
 * DIFFER (`verifyYubikeyChallengeResponse`).  That rejects constant /
 * zero-entropy / dead transports up front, fail-closed.  The
 * passphrase wrap remains as an escape hatch, so a user can never be
 * locked out by a bad YubiKey.
 *
 * Remaining human-gated work (cannot be done in-sandbox): fix the
 * five defects above with a physical key, then prove a full
 * enroll → reload → unlock round-trip in a real Chromium browser.
 * Until then, treat HardwareKeyCard enrollment as unverified.
 *
 * --- Touch UX ---
 *
 * YubiKey HMAC-SHA1 mode can be configured to require a touch
 * before the response is computed (Yubico Authenticator's "require
 * touch" toggle).  We don't enforce or detect this — the YubiKey
 * itself will simply hold the response until the user taps; our
 * read loop blocks until the response is delivered.  The UI shows
 * a "tap your YubiKey" prompt during this wait.
 */

import { YUBIKEY_CHALLENGE_BYTES, YUBIKEY_HMAC_OUTPUT_BYTES, type YubikeySlot } from './protocol';
import type { YubikeyHmacFn } from './wrap';

/** Yubico USB vendor ID. */
const YUBICO_VENDOR_ID = 0x1050;

/** OTP-applet HID command bytes for slot 1 / slot 2 HMAC-SHA1. */
const CMD_HMAC_SLOT_1 = 0x30;
const CMD_HMAC_SLOT_2 = 0x38;

/** Status bits in the feature-report byte. */
const RESP_PENDING_FLAG = 0x40;
const RESP_TIMEOUT_WAIT_FLAG = 0x20;

/** Each HID feature report is 8 bytes total (1 report ID + 7 payload). */
const FEATURE_REPORT_SIZE = 8;
const FEATURE_PAYLOAD_SIZE = 7;

/** Feature report ID 0 is the OTP applet's report. */
const REPORT_ID = 0;

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
		// Pad/copy challenge to a multiple of FEATURE_PAYLOAD_SIZE
		// (64 / 7 → ceil 10 payload-bytes-aligned blocks of 7 bytes
		// each, with the last block carrying a frame-end bit).
		const FRAMES_NEEDED = Math.ceil(YUBIKEY_CHALLENGE_BYTES / FEATURE_PAYLOAD_SIZE);
		// Send each frame as a feature report.  Frame index goes in
		// the first byte's low 4 bits; the high nibble signals the
		// command on the LAST frame.
		for (let frame = 0; frame < FRAMES_NEEDED; frame++) {
			const payload = new Uint8Array(FEATURE_REPORT_SIZE);
			payload[0] = REPORT_ID;
			const offset = frame * FEATURE_PAYLOAD_SIZE;
			const remaining = Math.min(FEATURE_PAYLOAD_SIZE, YUBIKEY_CHALLENGE_BYTES - offset);
			for (let i = 0; i < remaining; i++) {
				payload[1 + i] = challenge[offset + i] ?? 0;
			}
			// Frame index in the trailing byte (Yubico's framing
			// convention).  Last frame carries the command; intermediate
			// frames just carry the index.
			const isLast = frame === FRAMES_NEEDED - 1;
			payload[FEATURE_REPORT_SIZE - 1] = isLast ? cmd | 0x80 : frame;
			logger?.({
				direction: 'send',
				bytes: payload.subarray(1).slice(),
				note: `frame ${frame + 1}/${FRAMES_NEEDED}${isLast ? ' (final, slot cmd)' : ''}`,
				timestamp: Date.now()
			});
			await device.sendFeatureReport(REPORT_ID, payload.subarray(1));
		}

		// Poll for the response.  The OTP applet sets RESP_PENDING_FLAG
		// while computing; once cleared, the 20-byte HMAC output is
		// available across consecutive feature reports.  If the slot
		// requires touch, this loop also waits for the user to tap.
		const POLL_INTERVAL_MS = 100;
		const TIMEOUT_MS = 30_000; // 30s — generous, lets users find their key
		const start = Date.now();
		const collected = new Uint8Array(YUBIKEY_HMAC_OUTPUT_BYTES);
		let collectedLen = 0;
		while (Date.now() - start < TIMEOUT_MS) {
			const data = await device.receiveFeatureReport(REPORT_ID);
			const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			// Audit 2026-05 finding 6-7 hardening: a malformed device
			// (or a hostile USB device with Yubico vendor ID, which is
			// the threat class here) could deliver a short feature
			// report. Without this check, view[FEATURE_PAYLOAD_SIZE]
			// reads `undefined` and the `?? 0` fallback would
			// interpret as "response ready, all zeros" — yielding a
			// partial-zero HMAC output that would silently fail
			// closed but could confuse a caller.
			//
			// The Yubico OTP feature report is exactly 8 bytes
			// (FEATURE_REPORT_SIZE): 7 payload + 1 status. A short
			// frame is a protocol violation and we refuse to interpret.
			if (view.byteLength < FEATURE_REPORT_SIZE) {
				throw new Error(
					`yubikey: short feature report (got ${view.byteLength} bytes, expected ${FEATURE_REPORT_SIZE})`
				);
			}
			const status = view[FEATURE_PAYLOAD_SIZE]!;
			logger?.({
				direction: 'recv',
				bytes: view.slice(0, FEATURE_PAYLOAD_SIZE),
				status,
				note:
					status & RESP_PENDING_FLAG
						? 'RESP_PENDING (computing)'
						: status & RESP_TIMEOUT_WAIT_FLAG
							? 'RESP_TIMEOUT_WAIT (touch needed)'
							: 'response data',
				timestamp: Date.now()
			});
			if (status & RESP_PENDING_FLAG) {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			if (status & RESP_TIMEOUT_WAIT_FLAG) {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			// Response ready: read the 7-byte payload from this frame.
			// Multiple frames may be needed to cover the 20-byte HMAC.
			const remaining = YUBIKEY_HMAC_OUTPUT_BYTES - collectedLen;
			const take = Math.min(FEATURE_PAYLOAD_SIZE, remaining);
			for (let i = 0; i < take; i++) {
				collected[collectedLen + i] = view[i] ?? 0;
			}
			collectedLen += take;
			if (collectedLen >= YUBIKEY_HMAC_OUTPUT_BYTES) {
				return collected;
			}
		}
		throw new Error('YubiKey HMAC timed out — touch your key or check the connection');
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
