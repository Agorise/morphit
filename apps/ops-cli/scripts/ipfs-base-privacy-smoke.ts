/**
 * ipfs-base-privacy-smoke.
 *
 * Every node, clearnet ones too, keeps Kubo from announcing itself where it
 * need not: telemetry off and AutoTLS off (AutoTLS registers the node with
 * libp2p.direct, which puts its address in a public certificate log), while a
 * clearnet node stays on the public IPFS network over the DHT (the rest of
 * that list: kubo-no-phone-home-smoke). Runs the
 * real ops/ipfs/morphit-ipfs-privacy.sh check-base / apply-base against a fake
 * `ipfs` that keeps its config in a file, starting from Kubo's defaults.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_IPFS_PRIVACY_SCRIPT ?? join(REPO, 'ops/ipfs/morphit-ipfs-privacy.sh');
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const dir = mkdtempSync(join(tmpdir(), 'ipfsbase-'));
const bin = join(dir, 'bin');
mkdirSync(bin);
const cfg = join(dir, 'config.tsv');
// Kubo 0.42 defaults for the keys involved.
writeFileSync(
	cfg,
	'Plugins.Plugins.telemetry.Config.Mode\t"auto"\nAutoTLS.Enabled\tnull\nRouting.Type\t"auto"\n'
);
writeFileSync(
	join(bin, 'ipfs'),
	`#!/bin/sh
F=${cfg}
[ "$1" = config ] || exit 1
if [ "$2" = --json ]; then
  grep -v "^$3	" "$F" > "$F.n"; printf '%s\\t%s\\n' "$3" "$4" >> "$F.n"; mv "$F.n" "$F"; exit 0
fi
v=$(awk -F'\\t' -v k="$2" '$1==k {print $2}' "$F"); [ -n "$v" ] || exit 1; printf '%s\\n' "$v"
`
);
chmodSync(join(bin, 'ipfs'), 0o755);
const run = (mode: string) =>
	spawnSync('sh', [SCRIPT, mode], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin`, IPFS_PATH: dir }
	});
check('check-base on a stock Kubo reports drift', run('check-base').status === 1);
run('apply-base');
const conf = readFileSync(cfg, 'utf8');
check(
	'apply-base turns telemetry off',
	/^Plugins\.Plugins\.telemetry\.Config\.Mode\t"off"$/m.test(conf),
	conf
);
check(
	'apply-base turns AutoTLS off (no registration with libp2p.direct)',
	/^AutoTLS\.Enabled\tfalse$/m.test(conf),
	conf
);
check(
	'a clearnet node stays on the public IPFS network, over the DHT only',
	/^Routing\.Type\t"dht"$/m.test(conf)
);
check('check-base then passes', run('check-base').status === 0);
rmSync(dir, { recursive: true, force: true });
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} ipfs-base-privacy checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} ipfs-base-privacy checks failed`);
process.exit(1);
