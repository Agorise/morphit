/**
 * Morphit relay — claim_account + create_claimed_account operation
 * serializers (cp324).
 *
 * WHY THIS EXISTS
 * `@beblurt/dblurt@0.10.9` (the latest published version) ships
 * transaction serializers for only `account_create` (operation id 5).
 * Its private `OperationSerializers` map has NO entry for the two ops the
 * ADR-0010 ACT model depends on:
 *   • `claim_account`            (op id 15) — MINTS one ACT.
 *   • `create_claimed_account`   (op id 16) — CONSUMES one ACT to create
 *                                             an account (fee-free).
 * So dblurt throws `SerializationError: No serializer for operation:
 * claim_account` at SIGN time — before anything reaches the chain. That
 * is why the relay's auto-minter logged `automint_mint_failed` on every
 * cycle, and why the signup path (which broadcasts create_claimed_account)
 * could never have created an account either. The Blurt CHAIN supports
 * both ops (accounts carry `pending_claimed_accounts`); this is purely a
 * client-library gap, not a chain limitation.
 *
 * HOW THIS FIXES IT (without patching node_modules — survives `npm ci`)
 * dblurt's `transactionDigest` / `signTransaction` / `generateTrxId`
 * serialize a transaction by reading the EXPORTED, mutable
 * `Types.Transaction` at call time (verified in
 * @beblurt/dblurt/lib/crypto.js). We replace `Types.Transaction` with an
 * augmented serializer that is byte-for-byte identical to dblurt's for
 * every existing operation — it reuses the EXACT same envelope field
 * serializers AND delegates each known op to dblurt's own `Types.Operation`
 * dispatcher — and adds serializers for our two ops built from dblurt's
 * exported field primitives (Asset, String, Authority, PublicKey, Array).
 *
 * Op IDs and field layouts are not guessed:
 *   • IDs come from dblurt's own operation-name enum order (id = index;
 *     cross-checked against account_create=5, account_update=6,
 *     account_witness_vote=8, change_recovery_account=19,
 *     claim_reward_balance=31, comment=1 — all match).
 *   • Layouts mirror dblurt's `account_create` definition (Blurt is a
 *     direct Steem fork; these structs predate the fork):
 *       claim_account            = { creator, fee, extensions }
 *       create_claimed_account   = account_create minus the leading `fee`,
 *                                  plus a trailing `extensions`.
 * The co-located test proves the augmented serializer reproduces dblurt's
 * digest for `transfer` + `account_create` byte-for-byte, that the two new
 * ops carry the right op-id, and that create_claimed_account's field bytes
 * match account_create's shared fields exactly.
 *
 * Idempotent. Called once at relay startup (client.ts module load), before
 * any broadcast.
 */
import { Types } from '@beblurt/dblurt';

/** Operation type IDs — the index of each op in the chain's operation
 *  variant (confirmed from dblurt's own enum order; see header). */
export const CLAIM_ACCOUNT_OP_ID = 15;
export const CREATE_CLAIMED_ACCOUNT_OP_ID = 16;

/** A dblurt field/operation serializer: writes `data` into the
 *  bytebuffer `buffer`. (dblurt's own type is structurally the same.) */
type Serializer = (buffer: unknown, data: unknown) => void;

/** The slice of the dblurt `Types` table we use. Cast through `unknown`
 *  because dblurt types `Types` more narrowly and as readonly. */
interface DblurtTypes {
	Transaction: Serializer;
	Operation: Serializer;
	Object: (definitions: ReadonlyArray<readonly [string, Serializer]>) => Serializer;
	Array: (itemSerializer: Serializer) => Serializer;
	Asset: Serializer;
	String: Serializer;
	Authority: Serializer;
	PublicKey: Serializer;
	UInt16: Serializer;
	UInt32: Serializer;
	Date: Serializer;
}

const T = Types as unknown as DblurtTypes;

/** The bytebuffer dblurt hands serializers exposes writeVarint32. */
interface VarintBuffer {
	writeVarint32(value: number): void;
}

/** Replicates dblurt's private `OperationDataSerializer`: write the op id
 *  as a varint, then serialize each field in chain order. */
function operationData(
	opId: number,
	definitions: ReadonlyArray<readonly [string, Serializer]>
): Serializer {
	const fields = T.Object(definitions);
	return (buffer, data) => {
		(buffer as VarintBuffer).writeVarint32(opId);
		fields(buffer, data);
	};
}

/** claim_account: creator, fee, extensions. Exported for the byte test. */
export const claimAccountSerializer: Serializer = operationData(CLAIM_ACCOUNT_OP_ID, [
	['creator', T.String],
	['fee', T.Asset],
	['extensions', T.Array(T.String)]
]);

/** create_claimed_account: account_create's fields minus the leading
 *  `fee`, plus a trailing `extensions`. Exported for the byte test. */
export const createClaimedAccountSerializer: Serializer = operationData(CREATE_CLAIMED_ACCOUNT_OP_ID, [
	['creator', T.String],
	['new_account_name', T.String],
	['owner', T.Authority],
	['active', T.Authority],
	['posting', T.Authority],
	['memo_key', T.PublicKey],
	['json_metadata', T.String],
	['extensions', T.Array(T.String)]
]);

/** Operation dispatcher: our two ops, else delegate to dblurt's own
 *  dispatcher (byte-identical to stock dblurt for every existing op).
 *  Exported for the byte test. */
export const augmentedOperationSerializer: Serializer = (buffer, op) => {
	const tuple = op as [string, unknown];
	if (tuple[0] === 'claim_account') return claimAccountSerializer(buffer, tuple[1]);
	if (tuple[0] === 'create_claimed_account') return createClaimedAccountSerializer(buffer, tuple[1]);
	return T.Operation(buffer, op);
};

let registered = false;

/** Install the augmented `Types.Transaction` so dblurt can serialize (and
 *  therefore sign + broadcast) claim_account and create_claimed_account.
 *  Idempotent; safe to call from multiple module-load paths. */
export function registerClaimedAccountOperationSerializers(): void {
	if (registered) return;
	// Mirrors dblurt's TransactionSerializer field-for-field; only the
	// operations item serializer is swapped for our augmented dispatcher.
	T.Transaction = T.Object([
		['ref_block_num', T.UInt16],
		['ref_block_prefix', T.UInt32],
		['expiration', T.Date],
		['operations', T.Array(augmentedOperationSerializer)],
		['extensions', T.Array(T.String)]
	]);
	registered = true;
}
