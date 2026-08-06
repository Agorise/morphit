/**
 * Morphit — YubiKey WebHID transport mock round-trip smoke (cp594).
 *
 * The WebHID transport (`lib/crypto/yubikey/transport.ts`) speaks the
 * Yubico OTP-applet HID feature-report protocol to perform an
 * HMAC-SHA1 challenge-response.  It cannot run in CI against a real
 * key — WebHID has no sandbox — but the SEND framing (70-byte
 * YK_FRAME + CRC-16 + 0x80|seq flags) and the READ assembly
 * (RESP_PENDING seq chunks, de-dup, dummy-report reset) are pure byte
 * logic that a faithful device SIMULATOR can exercise end to end.
 *
 * This smoke stands up a `MockYubikey` that implements the exact HID
 * surface the transport drives (open / sendFeatureReport /
 * receiveFeatureReport / close), decodes the frame the transport
 * writes the way a real applet would (validating the slot byte and
 * the frame CRC), computes a genuine HMAC-SHA1(secret, challenge)
 * with node:crypto, and streams it back in 7-byte RESP_PENDING
 * chunks.  It then drives the REAL `requestYubikey` transport (via a
 * mocked `navigator.hid`) and the REAL enroll gate + unlock path.
 *
 * What this PROVES (coding correctness, catches regressions):
 *   - the 70-byte frame is built with a correct Yubico CRC-16 the
 *     applet accepts (a wrong CRC ⇒ the mock rejects ⇒ timeout);
 *   - the slot selector reaches the wire as the right command byte
 *     (0x30 slot 1 / 0x38 slot 2);
 *   - the 20-byte HMAC is reassembled correctly from 7-byte chunks;
 *   - duplicate/stale response reports are de-duplicated (defect #4);
 *   - buildVerifiedYubikeyWrap's two-challenge gate PASSES for a real
 *     challenge-DEPENDENT device and the wrap round-trips through
 *     recoverCekFromYubikey (full enroll -> unlock).
 *
 * What this does NOT prove: real USB timing, and the frame byte-order
 * / status-flag semantics against physical firmware.  That is the
 * hardware bench test (see the transport.ts header).  This smoke and
 * the real key share the transport's protocol assumptions, so it is a
 * consistency + regression check, not a substitute for on-device
 * validation.
 */
import sodium from 'libsodium-wrappers-sumo';
import { createHmac } from 'node:crypto';
import { requestYubikey, isWebHidSupported } from '../src/lib/crypto/yubikey/transport';
import { buildVerifiedYubikeyWrap, recoverCekFromYubikey } from '../src/lib/crypto/yubikey/wrap';
import { CEK_BYTES, type YubikeySlot } from '../src/lib/crypto/yubikey/protocol';

let passes = 0;
let failures = 0;
function ok(cond: boolean, label: string): void {
	if (cond) {
		passes++;
	} else {
		failures++;
		console.error(`  ✗ ${label}`);
	}
}

// ── Protocol constants (must mirror transport.ts / ykdef.h) ──────────
const SLOT_WRITE_FLAG = 0x80;
const RESP_PENDING_FLAG = 0x40;
const DUMMY_REPORT_WRITE = 0x8f;
const SEQ_MASK = 0x1f;
const CMD_HMAC_SLOT_1 = 0x30;
const CMD_HMAC_SLOT_2 = 0x38;
const FRAME_SIZE = 70;
const REPORT_SIZE = 8;
const PAYLOAD_SIZE = 7;
const HMAC_OUT = 20;

/** Same reflected CRC-16 the applet uses to validate the frame. */
function crc16(data: Uint8Array): number {
	let crc = 0xffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i]! & 0xff;
		for (let b = 0; b < 8; b++) {
			const lsb = crc & 1;
			crc >>= 1;
			if (lsb) crc ^= 0x8408;
		}
	}
	return crc & 0xffff;
}

function hmacSha1(secret: Uint8Array, challenge: Uint8Array): Uint8Array {
	return new Uint8Array(createHmac('sha1', Buffer.from(secret)).update(Buffer.from(challenge)).digest());
}

interface MockOpts {
	/** Slot the mock is "programmed" for.  A frame carrying the other
	 *  slot's command byte is rejected (no response). */
	readonly slot: YubikeySlot;
	/** Emit each response chunk twice (stutter) to exercise the
	 *  transport's sequence de-duplication. */
	readonly stutter?: boolean;
}

/** A faithful-enough OTP-applet simulator over the HID feature-report
 *  surface the transport drives. */
class MockYubikey {
	readonly productName = 'Mock YubiKey 5';
	private readonly secret: Uint8Array;
	private readonly cmd: number;
	private readonly stutter: boolean;
	private readonly frame = new Uint8Array(FRAME_SIZE);
	private response: Uint8Array | null = null;
	private respSeq = 0;
	private servedTwice = false;
	/** Last frame's slot byte, for assertions. */
	lastSlotByte = -1;
	/** Whether the last frame's CRC validated. */
	lastCrcOk = false;
	opened = false;

	constructor(secret: Uint8Array, opts: MockOpts) {
		this.secret = secret;
		this.cmd = opts.slot === 1 ? CMD_HMAC_SLOT_1 : CMD_HMAC_SLOT_2;
		this.stutter = opts.stutter ?? false;
	}

	async open(): Promise<void> {
		this.opened = true;
	}
	async close(): Promise<void> {
		this.opened = false;
	}

	async sendFeatureReport(reportId: number, data: Uint8Array): Promise<void> {
		void reportId;
		if (data.byteLength !== REPORT_SIZE) throw new Error(`mock: send size ${data.byteLength}`);
		const flag = data[PAYLOAD_SIZE]!;
		if (flag === DUMMY_REPORT_WRITE) {
			// Reset/abort to idle.
			this.response = null;
			this.respSeq = 0;
			this.servedTwice = false;
			return;
		}
		if ((flag & SLOT_WRITE_FLAG) === 0) throw new Error('mock: write without SLOT_WRITE_FLAG');
		const seq = flag & SEQ_MASK;
		if (seq > 9) throw new Error(`mock: write seq ${seq} out of range`);
		this.frame.set(data.subarray(0, PAYLOAD_SIZE), seq * PAYLOAD_SIZE);
		if (seq === 9) {
			// Final chunk — validate and compute like the applet would.
			this.lastSlotByte = this.frame[64]!;
			const want = crc16(this.frame.subarray(0, 64));
			const got = this.frame[65]! | (this.frame[66]! << 8); // little-endian
			this.lastCrcOk = got === want;
			if (this.lastSlotByte === this.cmd && this.lastCrcOk) {
				this.response = hmacSha1(this.secret, this.frame.subarray(0, 64));
				this.respSeq = 0;
				this.servedTwice = false;
			} else {
				this.response = null; // reject → no response → transport times out
			}
		}
	}

	async receiveFeatureReport(reportId: number): Promise<DataView> {
		void reportId;
		const buf = new Uint8Array(REPORT_SIZE);
		if (this.response && this.respSeq * PAYLOAD_SIZE < HMAC_OUT) {
			// Serve the current response chunk.
			const off = this.respSeq * PAYLOAD_SIZE;
			for (let i = 0; i < PAYLOAD_SIZE; i++) buf[i] = this.response[off + i] ?? 0;
			buf[PAYLOAD_SIZE] = RESP_PENDING_FLAG | this.respSeq;
			if (this.stutter && !this.servedTwice) {
				// Emit the same seq once more before advancing.
				this.servedTwice = true;
			} else {
				this.respSeq++;
				this.servedTwice = false;
			}
		} else {
			// Idle: write flag clear, no response pending.
			buf[PAYLOAD_SIZE] = 0x00;
		}
		return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
}

/** Install a navigator.hid that hands the transport our mock.  Node 22
 *  exposes `navigator` as a getter-only global, so define over it. */
function installHid(mock: MockYubikey): void {
	Object.defineProperty(globalThis, 'navigator', {
		value: { hid: { requestDevice: async () => [mock] } },
		configurable: true,
		writable: true
	});
}

async function main(): Promise<void> {
	await sodium.ready;

	// A 20-byte slot secret, like a YubiKey HMAC-SHA1 slot holds.
	const secret = sodium.randombytes_buf(20);

	// 1) feature detection sees navigator.hid.
	installHid(new MockYubikey(secret, { slot: 2 }));
	ok(isWebHidSupported() === true, 'isWebHidSupported() true when navigator.hid present');

	// 2) single challenge-response returns the exact HMAC-SHA1.
	{
		const mock = new MockYubikey(secret, { slot: 2 });
		installHid(mock);
		const dev = await requestYubikey(2);
		const challenge = sodium.randombytes_buf(64);
		const got = await dev.hmac(challenge);
		const want = hmacSha1(secret, challenge);
		ok(got.length === HMAC_OUT, 'response is 20 bytes');
		ok(sodium.memcmp(got, want), 'transport reassembles the exact HMAC-SHA1(secret, challenge)');
		ok(mock.lastCrcOk, 'applet accepted the frame CRC (transport built a valid Yubico CRC-16)');
		ok(mock.lastSlotByte === CMD_HMAC_SLOT_2, 'slot 2 reaches the wire as command byte 0x38');
		await dev.close();
	}

	// 3) slot 1 reaches the wire as 0x30 and still round-trips.
	{
		const mock = new MockYubikey(secret, { slot: 1 });
		installHid(mock);
		const dev = await requestYubikey(1);
		const challenge = sodium.randombytes_buf(64);
		const got = await dev.hmac(challenge);
		ok(sodium.memcmp(got, hmacSha1(secret, challenge)), 'slot 1 round-trips to the exact HMAC');
		ok(mock.lastSlotByte === CMD_HMAC_SLOT_1, 'slot 1 reaches the wire as command byte 0x30');
		await dev.close();
	}

	// 4) challenge-DEPENDENCE: two different challenges → two different
	//    HMACs (this is exactly what the enroll gate relies on).
	{
		const mock = new MockYubikey(secret, { slot: 2 });
		installHid(mock);
		const dev = await requestYubikey(2);
		const c1 = sodium.randombytes_buf(64);
		const c2 = sodium.randombytes_buf(64);
		const r1 = await dev.hmac(c1);
		const r2 = await dev.hmac(c2);
		ok(!sodium.memcmp(r1, r2), 'distinct challenges yield distinct responses (challenge-dependent)');
		await dev.close();
	}

	// 5) sequence de-duplication: a stuttering applet (each chunk twice)
	//    still yields the correct 20-byte HMAC.
	{
		const mock = new MockYubikey(secret, { slot: 2, stutter: true });
		installHid(mock);
		const dev = await requestYubikey(2);
		const challenge = sodium.randombytes_buf(64);
		const got = await dev.hmac(challenge);
		ok(sodium.memcmp(got, hmacSha1(secret, challenge)), 'duplicate response reports are de-duplicated');
		await dev.close();
	}

	// 6) FULL enroll → unlock through the real gate + wrap:
	//    buildVerifiedYubikeyWrap (two-tap fail-closed verify) must
	//    PASS for a genuine device, and recoverCekFromYubikey must
	//    recover the exact CEK.
	{
		const mock = new MockYubikey(secret, { slot: 2 });
		installHid(mock);
		const dev = await requestYubikey(2);
		const cek = sodium.randombytes_buf(CEK_BYTES);
		const wrap = await buildVerifiedYubikeyWrap(cek, dev.hmac, 2, 'bench key');
		ok(wrap.kind === 'yubikey' && wrap.slot === 2, 'enroll gate passed; wrap built for slot 2');
		const recovered = await recoverCekFromYubikey(wrap, dev.hmac);
		ok(sodium.memcmp(recovered, cek), 'unlock recovers the exact CEK (full enroll → unlock round-trip)');
		sodium.memzero(recovered);
		sodium.memzero(cek);
		await dev.close();
	}

	if (failures === 0) {
		console.log(`✓ all ${passes} yubikey-transport-mock scenarios passed`);
	} else {
		console.error(`✗ ${failures} of ${passes + failures} yubikey-transport-mock scenarios FAILED`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
