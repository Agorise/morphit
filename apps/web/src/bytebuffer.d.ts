/**
 * Minimal ambient declaration for the `bytebuffer` npm package (v5).
 *
 * bytebuffer 5.x ships NO type declarations and `@types/bytebuffer` is
 * not installed. Morphit uses ByteBuffer in exactly ONE place —
 * `withdrawVestingSign.ts` — to hand-serialize a `withdraw_vesting`
 * (power-down) transaction using @beblurt/dblurt's own `Types`
 * primitives, because dblurt's operation serializer has no entry for
 * `withdraw_vesting` (op ID 4). We declare only the API surface we
 * actually call. dblurt's own serializer types also import
 * `* as ByteBuffer from 'bytebuffer'`, so this declaration additionally
 * gives dblurt's `Types.*` a concrete buffer type instead of `any`.
 *
 * If `@types/bytebuffer` is ever installed, its declarations supersede
 * this file (module augmentation is additive; the shapes match). No
 * runtime impact either way — this is types only.
 */
declare module 'bytebuffer' {
	class ByteBuffer {
		constructor(capacity?: number, littleEndian?: boolean);
		/** Default backing-buffer capacity used when none is given. */
		static DEFAULT_CAPACITY: number;
		/** Little-endian byte-order flag (Graphene serializes LE). */
		static LITTLE_ENDIAN: boolean;
		/** LEB128 unsigned varint — used for array lengths and the
		 *  operation variant id. */
		writeVarint32(value: number): ByteBuffer;
		/** Flip from write mode to read mode (offset→limit, offset→0). */
		flip(): ByteBuffer;
		/** Return the written bytes as an ArrayBuffer. */
		toBuffer(): ArrayBuffer;
	}
	export = ByteBuffer;
}
