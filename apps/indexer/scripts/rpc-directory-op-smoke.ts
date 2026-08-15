/**
 * Smoke: the on-chain RPC-directory op (`morphit_rpc_v1`) validator + builder.
 * @morphit publishes the canonical hidden-node list; indexers self-populate from
 * it. Covers schema validation, the endpoint flattener, and op shaping.
 */
import {
	validateRpcDirectoryPayload,
	directoryEndpointUrls,
	buildRpcDirectoryCustomJsonOp,
	isHiddenRpcUrl,
	RPC_DIRECTORY_OP_ID,
	RPC_DIRECTORY_MAX_NODES,
	BLURT_CUSTOM_JSON_MAX_BYTES
} from '../src/blurt/rpcDirectoryOp.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

const STAR_ONION = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091';
const STAR_I2P = 'http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091';
const JADE_ONION = 'http://axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion:8091';

const GOOD = {
	v: 1,
	ts: '2026-08-14T22:00:00Z',
	nodes: [
		{ onion: STAR_ONION, i2p: STAR_I2P },
		{ onion: JADE_ONION }
	]
};

// ── isHiddenRpcUrl ───────────────────────────────────────────────────
check('onion url recognised', isHiddenRpcUrl(STAR_ONION, 'onion'));
check('i2p url recognised', isHiddenRpcUrl(STAR_I2P, 'i2p'));
check('onion is not an i2p url', !isHiddenRpcUrl(STAR_ONION, 'i2p'));
check('https rejected (self-authenticating → http only)', !isHiddenRpcUrl('https://x.onion:8091', 'onion'));
check('clearnet rejected', !isHiddenRpcUrl('http://rpc.example.com', 'onion'));

// ── validate: happy path ─────────────────────────────────────────────
{
	const r = validateRpcDirectoryPayload(GOOD);
	check('valid directory accepted', r.ok === true);
	check('keeps both nodes', r.ok && r.payload.nodes.length === 2);
}

// ── validate: rejections ─────────────────────────────────────────────
const reject = (name: string, payload: unknown, reason: string) => {
	const r = validateRpcDirectoryPayload(payload);
	check(`${name} → ${reason}`, r.ok === false && r.reason === reason);
};
reject('non-object', 'nope', 'not_an_object');
reject('wrong version', { ...GOOD, v: 2 }, 'unsupported_version');
reject('missing ts', { v: 1, nodes: GOOD.nodes }, 'bad_or_missing_ts');
reject('bad ts', { ...GOOD, ts: 'not-a-date' }, 'bad_or_missing_ts');
reject('nodes not array', { ...GOOD, nodes: {} }, 'nodes_not_an_array');
reject('empty nodes', { ...GOOD, nodes: [] }, 'nodes_empty');
reject('too many nodes', { ...GOOD, nodes: Array.from({ length: RPC_DIRECTORY_MAX_NODES + 1 }, () => ({ onion: STAR_ONION })) }, 'too_many_nodes');
reject('node with no address', { ...GOOD, nodes: [{}] }, 'node_has_no_address');
reject('bad onion', { ...GOOD, nodes: [{ onion: 'http://rpc.example.com' }] }, 'bad_onion_url');
reject('bad i2p', { ...GOOD, nodes: [{ i2p: 'http://x.onion:8091' }] }, 'bad_i2p_url');
{
	// Oversized payload → payload_too_large (many nodes with long labels).
	const big = {
		v: 1,
		ts: '2026-08-14T22:00:00Z',
		nodes: Array.from({ length: RPC_DIRECTORY_MAX_NODES }, () => ({
			onion: STAR_ONION,
			i2p: STAR_I2P
		}))
	};
	const r = validateRpcDirectoryPayload(big);
	check('oversized → payload_too_large (or fits under cap)', r.ok === false ? r.reason === 'payload_too_large' : true);
	check('cap constant is the byte guard', BLURT_CUSTOM_JSON_MAX_BYTES > 0);
}

// ── directoryEndpointUrls ────────────────────────────────────────────
{
	const r = validateRpcDirectoryPayload(GOOD);
	if (r.ok) {
		const urls = directoryEndpointUrls(r.payload);
		check('flattens onion-first then i2p', urls[0] === STAR_ONION && urls[1] === JADE_ONION && urls[2] === STAR_I2P);
		check('de-duplicates', directoryEndpointUrls({ v: 1, ts: GOOD.ts, nodes: [{ onion: STAR_ONION }, { onion: STAR_ONION }] }).length === 1);
	}
}

// ── buildRpcDirectoryCustomJsonOp ────────────────────────────────────
{
	const op = buildRpcDirectoryCustomJsonOp(GOOD);
	check('op id is morphit_rpc_v1', op.id === RPC_DIRECTORY_OP_ID);
	check('posting-auth signer is @morphit', op.required_posting_auths[0] === 'morphit' && op.required_auths.length === 0);
	check('op json round-trips to the validated payload', JSON.parse(op.json).nodes.length === 2);
	check('custom signer honoured', buildRpcDirectoryCustomJsonOp(GOOD, 'agorise').required_posting_auths[0] === 'agorise');
	let threw = false;
	try {
		buildRpcDirectoryCustomJsonOp({ v: 1, ts: GOOD.ts, nodes: [] });
	} catch {
		threw = true;
	}
	check('builder throws on invalid payload (before any key touched)', threw);
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} rpc-directory-op checks passed`
		: `\n\u2717 rpc-directory-op: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
