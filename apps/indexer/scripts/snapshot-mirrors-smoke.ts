#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-mirrors-smoke.ts
 *
 * Pins the rules that decide WHERE a fresh node fetches the federation indexer
 * snapshot from. The load-bearing one is the hidden-only case: before this
 * module, fast-sync's source list was `forgejo_url` + public clearnet IPFS
 * gateways, so a Tor/I2P-only node could reach none of them and the nodes we
 * most want to exist were the only ones condemned to a multi-day replay.
 *
 * The other rule worth guarding is fail-closed: a hidden-only node must NEVER
 * fall through to a clearnet gateway just because the private path was empty or
 * slow — finishing faster is not worth deanonymising the box.
 */
import {
	buildSnapshotSources,
	extractPeerAddressesFromHistory,
	hasUsableSource,
	OPERATOR_REGISTER_OP_ID,
	shortHiddenLabel
} from '../src/blurt/snapshotMirrors.ts';

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ONION = 'a'.repeat(56) + '.onion';
const ONION2 = 'b'.repeat(56) + '.onion';
const I2P = 'c'.repeat(52) + '.b32.i2p';
const GATEWAYS = ['https://ipfs.io', 'https://dweb.link'];

// ── 1. Hidden-only: clearnet sources are OMITTED, not merely deprioritised ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: 'https://git.agorise.net/snap.tar.gz',
		peers: [{ tor: ONION, i2p_b32: I2P }],
		publicGateways: GATEWAYS,
		localGateway: null,
		hiddenOnly: true
	});
	ok(
		'hidden-only: no clearnet source appears at all',
		s.every((x) => x.transport !== 'clearnet'),
		s.filter((x) => x.transport === 'clearnet').map((x) => x.url).join(', ')
	);
	ok('hidden-only: the peer .onion IS offered', s.some((x) => x.transport === 'tor'));
	ok('hidden-only: the peer .b32.i2p IS offered', s.some((x) => x.transport === 'i2p'));
	ok('hidden-only: the signed https mirror is dropped', !s.some((x) => x.url.includes('git.agorise.net')));
}

// ── 2. Hidden-only with no peers → NO sources (caller must fail closed) ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: 'https://git.agorise.net/snap.tar.gz',
		peers: [],
		publicGateways: GATEWAYS,
		localGateway: null,
		hiddenOnly: true
	});
	ok('hidden-only with no hidden peers yields zero sources', s.length === 0, `got ${s.length}`);
	ok('hasUsableSource() reports that honestly', !hasUsableSource(s));
}

// ── 3. Clearnet node: hidden peers still come FIRST among network sources ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: 'https://git.agorise.net/snap.tar.gz',
		peers: [{ tor: ONION, i2p_b32: I2P }],
		publicGateways: GATEWAYS,
		localGateway: 'http://127.0.0.1:8082',
		hiddenOnly: false
	});
	ok('local gateway is tried first', s[0]?.transport === 'local', s[0]?.url ?? 'none');
	const firstNet = s.findIndex((x) => x.transport !== 'local');
	ok('the first network source is a hidden peer, not clearnet', s[firstNet]?.transport === 'tor', s[firstNet]?.transport);
	ok('Tor is ordered before I2P (I2P tunnels are slow to warm)',
		s.findIndex((x) => x.transport === 'tor') < s.findIndex((x) => x.transport === 'i2p'));
	ok('clearnet sources are still present for a clearnet node',
		s.some((x) => x.transport === 'clearnet'));
	ok('the signed https mirror precedes public gateways',
		s.findIndex((x) => x.url.includes('git.agorise.net')) <
			s.findIndex((x) => x.url.includes('ipfs.io')));
}

// ── 4. Malformed peer addresses can never become fetch targets ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: null,
		peers: [
			{ tor: 'notanonion.onion', i2p_b32: 'short.b32.i2p' },
			{ tor: '', i2p_b32: null },
			{ tor: 'http://' + ONION, i2p_b32: undefined }, // scheme included = invalid host
			{ tor: ONION2, i2p_b32: null }
		],
		publicGateways: [],
		localGateway: null,
		hiddenOnly: true
	});
	ok('only the well-formed onion survives validation', s.length === 1 && s[0]!.url === `http://${ONION2}/ipfs/${CID}`,
		s.map((x) => x.url).join(', '));
}

// ── 5. Duplicate peers are de-duplicated, first-seen order preserved ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: null,
		peers: [{ tor: ONION }, { tor: ONION }, { tor: ONION2 }],
		publicGateways: [],
		localGateway: null,
		hiddenOnly: true
	});
	ok('duplicate peer addresses collapse to one source', s.length === 2, `got ${s.length}`);
	ok('first-seen order is preserved', s[0]!.url.includes(ONION));
}

// ── 6. Labels never dump a 56-char onion into the operator's terminal ──
{
	ok('hidden labels are shortened', shortHiddenLabel(ONION).length < 24, shortHiddenLabel(ONION));
	ok('hidden labels name the transport', shortHiddenLabel(I2P).startsWith('I2P'));
}

// ── 7. Peer discovery from account history (the fresh-node chicken-and-egg) ──
{
	const hist = [
		[
			5,
			{
				op: [
					'custom_json',
					{
						id: OPERATOR_REGISTER_OP_ID,
						required_posting_auths: ['morphit'],
						json: JSON.stringify({ alt_addresses: { tor: ONION, i2p_b32: I2P } })
					}
				]
			}
		],
		// A later re-registration is an upsert — the NEWEST address must win.
		[
			9,
			{
				op: [
					'custom_json',
					{
						id: OPERATOR_REGISTER_OP_ID,
						required_posting_auths: ['morphit'],
						json: JSON.stringify({ alt_addresses: { tor: ONION2, i2p_b32: null } })
					}
				]
			}
		],
		// Noise a volunteer RPC can legitimately return — must be skipped, not thrown on.
		[10, { op: ['transfer', { from: 'a', to: 'b' }] }],
		[11, { op: ['custom_json', { id: 'something_else', required_posting_auths: ['x'], json: '{}' }] }],
		[12, { op: ['custom_json', { id: OPERATOR_REGISTER_OP_ID, required_posting_auths: ['y'], json: 'NOT JSON' }] }],
		'garbage',
		null
	];
	const peers = extractPeerAddressesFromHistory(hist);
	ok('one entry per account, newest registration wins', peers.length === 1 && peers[0]!.tor === ONION2,
		JSON.stringify(peers));
	ok('malformed history entries are skipped, never thrown on', true);
	ok('a non-array history yields an empty list', extractPeerAddressesFromHistory(undefined).length === 0);
	ok('registrations with no hidden address are ignored',
		extractPeerAddressesFromHistory([
			[1, { op: ['custom_json', { id: OPERATOR_REGISTER_OP_ID, required_posting_auths: ['z'], json: '{}' }] }]
		]).length === 0);
}

// ── 8. The CID is always the one from the signed op ──
{
	const s = buildSnapshotSources({
		cid: CID,
		forgejoUrl: null,
		peers: [{ tor: ONION }],
		publicGateways: GATEWAYS,
		localGateway: null,
		hiddenOnly: false
	});
	ok('every IPFS-path source embeds the signed CID',
		s.filter((x) => x.url.includes('/ipfs/')).every((x) => x.url.includes(CID)));
}

console.log('');
if (fails.length > 0) {
	console.error(`✗ ${fails.length} snapshot-mirrors scenario(s) failed:`);
	for (const f of fails) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ all ${pass} snapshot-mirrors scenarios passed`);
