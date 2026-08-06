/**
 * system-check-os-smoke (beta11 items 5a + 5b).
 *
 * Item 5a — `classifyOs` must recognize Ubuntu/Debian DERIVATIVES (Linux
 * Mint, Pop!_OS, Zorin, elementary, KDE neon, …) as the Ubuntu/Debian-
 * based systems they are, instead of dumping them into the generic
 * "unsupported distro" warning. It reads ID_LIKE + UBUNTU_CODENAME so it
 * can say which base release the derivative sits on (noble = 24.04 good,
 * jammy = 22.04 aging). Genuinely-unrelated distros (Arch, Fedora) still
 * get the honest "on your own" warn.
 *
 * Item 5b — runSystemCheck must include a Docker presence check and a
 * Postgres-installed check (distinct from the existing Postgres-
 * reachable TCP probe), so an operator setting up for BunkerWeb /
 * Postgres sees them in the pre-flight.
 *
 * classifyOs is PURE (string in → verdict out); this exercises the whole
 * decision matrix. The two new checks shell out to the host, so only
 * their wiring into the run sequence is asserted here.
 */

import { classifyOs } from '../src/init/systemCheck.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

/** Assert a classifyOs result's status (and optionally a note substring). */
function os(
	label: string,
	args: { id: string; ver: string; pretty: string; idLike?: string; codename?: string },
	wantStatus: 'ok' | 'warn' | 'error',
	noteIncludes?: string
): void {
	const r = classifyOs(args.id, args.ver, args.pretty, args.idLike ?? '', args.codename ?? '');
	const statusOk = r.status === wantStatus;
	const noteOk = noteIncludes === undefined || (r.note ?? '').includes(noteIncludes);
	if (statusOk && noteOk) {
		ok(label);
	} else {
		bad(label, `status=${r.status} note=${JSON.stringify(r.note)}`);
	}
}

// ─── Ubuntu proper ──────────────────────────────────────────────────
os('Ubuntu 24.04 LTS → ok', { id: 'ubuntu', ver: '24.04', pretty: 'Ubuntu 24.04.1 LTS' }, 'ok');
os('Ubuntu 26.04 LTS → ok', { id: 'ubuntu', ver: '26.04', pretty: 'Ubuntu 26.04 LTS' }, 'ok');
os('Ubuntu 22.04 LTS → warn (aging)', { id: 'ubuntu', ver: '22.04', pretty: 'Ubuntu 22.04.4 LTS' }, 'warn', 'aging');
os('Ubuntu 25.10 interim → warn (interim)', { id: 'ubuntu', ver: '25.10', pretty: 'Ubuntu 25.10' }, 'warn', 'interim');
os('Ubuntu 20.04 → error (EOL)', { id: 'ubuntu', ver: '20.04', pretty: 'Ubuntu 20.04.6 LTS' }, 'error', 'EOL');

// ─── Debian proper ──────────────────────────────────────────────────
os('Debian 12 → ok', { id: 'debian', ver: '12', pretty: 'Debian GNU/Linux 12 (bookworm)' }, 'ok');
os('Debian 11 → warn (older)', { id: 'debian', ver: '11', pretty: 'Debian GNU/Linux 11 (bullseye)' }, 'warn', 'older');

// ─── 5a: Ubuntu/Debian derivatives ──────────────────────────────────
// Linux Mint 22.x — ID=linuxmint, ID_LIKE=ubuntu, UBUNTU_CODENAME=noble.
os(
	'5a Mint 22 (noble base) → ok, names the noble base',
	{ id: 'linuxmint', ver: '22', pretty: 'Linux Mint 22', idLike: 'ubuntu', codename: 'noble' },
	'ok',
	'noble'
);
// Linux Mint 21.x — jammy base → ok but flags the aging base.
os(
	'5a Mint 21 (jammy base) → ok, flags the aging jammy base',
	{ id: 'linuxmint', ver: '21.3', pretty: 'Linux Mint 21.3', idLike: 'ubuntu', codename: 'jammy' },
	'ok',
	'jammy'
);
// Pop!_OS — ID=pop, ID_LIKE="ubuntu debian".
os(
	'5a Pop!_OS (noble base) → ok, Ubuntu-based',
	{ id: 'pop', ver: '22.04', pretty: 'Pop!_OS 22.04 LTS', idLike: 'ubuntu debian', codename: 'noble' },
	'ok',
	'Ubuntu-based'
);
// Zorin OS — ID=zorin, ID_LIKE=ubuntu.
os('5a Zorin OS → ok', { id: 'zorin', ver: '17', pretty: 'Zorin OS 17', idLike: 'ubuntu', codename: 'jammy' }, 'ok', 'Ubuntu-based');
// elementary OS — ID=elementary, ID_LIKE=ubuntu.
os('5a elementary OS → ok', { id: 'elementary', ver: '8', pretty: 'elementary OS 8', idLike: 'ubuntu', codename: 'noble' }, 'ok');
// KDE neon — ID=neon, ID_LIKE="ubuntu"; matched via the ID_LIKE regex
// even though `neon` isn't in the explicit id list.
os(
	'5a KDE neon (via ID_LIKE) → ok',
	{ id: 'neon', ver: '22.04', pretty: 'KDE neon 6.0', idLike: 'ubuntu', codename: 'noble' },
	'ok',
	'Ubuntu-based'
);
// A Debian-only derivative (e.g. Devuan): ID_LIKE=debian → Debian-based.
os(
	'5a Debian-only derivative → ok, Debian-based',
	{ id: 'devuan', ver: '5', pretty: 'Devuan GNU/Linux 5 (daedalus)', idLike: 'debian' },
	'ok',
	'Debian-based'
);
// Kicksecure — a hardened Debian (ID_LIKE=debian, no UBUNTU_CODENAME).
// The genuinely "more secure server" base we recommend in the FAQ + brag
// list; recognized via the Debian ID_LIKE path. (The Ansible one-command
// installer gates on a `noble` base and would hard-fail here — Kicksecure
// is a MANUAL-install target — but the systemCheck correctly green-lights
// the OS itself as a supported Debian-based server.)
os(
	'5a Kicksecure (hardened Debian) → ok, Debian-based',
	{ id: 'kicksecure', ver: '17', pretty: 'Kicksecure 17', idLike: 'debian' },
	'ok',
	'Debian-based'
);

// ─── Genuinely-unrelated distros still warn honestly ────────────────
os('Arch → warn (unsupported)', { id: 'arch', ver: 'rolling', pretty: 'Arch Linux' }, 'warn', 'unsupported');
os('Fedora → warn (unsupported)', { id: 'fedora', ver: '40', pretty: 'Fedora Linux 40 (Server Edition)' }, 'warn', 'unsupported');
// No ID_LIKE at all and an unknown id → the generic warn (not a crash).
os('Unknown distro, no ID_LIKE → warn', { id: 'voidlinux', ver: '', pretty: 'void' }, 'warn', 'unsupported');

// ─── 5b: new checks wired into runSystemCheck ───────────────────────
{
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'init', 'systemCheck.ts'),
		'utf8'
	);
	const has = (re: RegExp) => re.test(src);

	if (has(/checks\.push\(checkDocker\(\)\)/)) ok('5b checkDocker() is wired into runSystemCheck');
	else bad('5b checkDocker() wiring missing');

	if (has(/checks\.push\(checkPostgresInstalled\(\)\)/)) ok('5b checkPostgresInstalled() is wired into runSystemCheck');
	else bad('5b checkPostgresInstalled() wiring missing');

	// The installed-check must come BEFORE the reachable-check (presence is
	// the more basic signal; you check it first).
	const instIdx = src.indexOf('checks.push(checkPostgresInstalled())');
	const reachIdx = src.indexOf('checks.push(await checkPostgresReachable())');
	if (instIdx !== -1 && reachIdx !== -1 && instIdx < reachIdx)
		ok('5b Postgres-installed check precedes the Postgres-reachable check');
	else bad('5b Postgres check ordering', `instIdx=${instIdx} reachIdx=${reachIdx}`);

	// checkOperatingSystem must pass ID_LIKE + UBUNTU_CODENAME through to
	// classifyOs (otherwise the derivative recognition can't work).
	if (has(/classifyOs\(id, versionId, prettyName, idLike, ubuntuCodename\)/))
		ok('5a checkOperatingSystem passes idLike + ubuntuCodename into classifyOs');
	else bad('5a classifyOs is not called with idLike + ubuntuCodename');

	if (has(/ID_LIKE/) && has(/UBUNTU_CODENAME/))
		ok('5a checkOperatingSystem reads ID_LIKE + UBUNTU_CODENAME from /etc/os-release');
	else bad('5a ID_LIKE / UBUNTU_CODENAME not read');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 system-check-os smoke FAILED');
	process.exit(1);
}
console.log('\u2713 classifyOs recognizes Ubuntu/Debian derivatives; Docker + Postgres-installed checks wired');
console.log(`\u2713 all ${pass} system-check-os scenarios passed`);
