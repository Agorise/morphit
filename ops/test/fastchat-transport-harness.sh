#!/usr/bin/env bash
# ops/test/fastchat-transport-harness.sh — prove the transport-selection unit
# tests actually catch the failures they claim to catch.
#
# WHY THIS EXISTS, AND WHY IT IS A HARNESS RATHER THAN A NOTE
#
# v1.18.0's round-four work added four test files covering which network a chat
# message goes out over, and every mutation written for them was watched to fail
# BY HAND. That is the right standard for a first pass and the wrong one to stop
# at: a guarantee that ran once, in a session nobody can replay, degrades into a
# claim. `broadcastTransport.test.ts` is documented in ADR-0052 as exactly that,
# openly, because there was no harness for it — this is the same situation with
# a harness instead of an apology.
#
# It is also cheap in a way the smoke harnesses are not. Those re-run a smoke
# that stands up servers and models network hops, so a mutation costs tens of
# seconds; these run vitest over a handful of files and cost about a second, so
# there is no reason to have left them unrepeatable.
#
# THE MUTATIONS. Each is a plausible edit — something a later change might do
# believing it harmless, or the shortcut the design deliberately did not take.
#
#   T1  `instanceof ProxyUnavailableError` at a fetch boundary.
#         → THE ORIGINAL BUG. fetch reports `TypeError: fetch failed` and hangs
#           the real reason off `cause`, so the branch can never be taken. It
#           took out the probe's protection against blaming healthy peers for a
#           local outage, silently, federation-wide.
#   T2  I2P blames any connect failure on the local proxy.
#         → one misbehaving peer parks the whole I2P network on a cooldown.
#   T3  A name-resolution failure is read as ours on every network.
#         → an ordinary DNS failure is recorded as "our transport is down".
#   T4  The clearnet short-circuit is removed.
#         → clearnet, which has no local daemon to be missing, can be marked
#           unreachable.
#   T5  The cause chain is walked without cycle protection.
#         → a self-referential error hangs the failure path.
#   T6  A peer's clearnet origin is discarded once it publishes a hidden one.
#         → THE OTHER ORIGINAL BUG. A clearnet-only instance — a fresh install —
#           has federated chat completely dead with every onion-publishing peer.
#   T7  The operator's "I do not run this daemon" setting is ignored.
#   T8  Alt-network values are no longer shape-checked.
#   T9  The queue key moves with the address.
#         → a peer that fails over gets a second queue and the messages in the
#           first are never pumped again.
#  T10  The sender never fails over.
#  T11  The sender fails over on a PEER failure too.
#         → the same batch delivered twice to one instance by two roads.
#  T12  A local fault is never recorded, so nothing is ever learned.
#  T13  The breaker may leave a peer with no candidate address.
#  T14  A success no longer clears a network's down-mark.
#         → a recovered network stays sidelined for the whole cooldown.
#  T15  The hidden transport branch is bypassed entirely.
#  T16  The warm-up warms every alternate regardless of cost.
#  T17  The warm-up warms only the preferred address.
#         → a zero-clearnet peer's failover pays a cold tunnel build.
#  T18  One failed route marks a whole network down.
#         → one stale .loki name takes lokinet away from every other peer.
#  T19  The warm-up's verdict never reaches the reachability tracker.
#  T20  The warm-up classifies by marker class alone.
#         → boot-time detection is blind on Lokinet, which raises no marker
#           class because it has no proxy: its local fault is a DNS miss. It
#           WAS also blind on I2P, until I2P got a CONNECT connector of ours
#           that raises the marker for a dead proxy — so that half of this
#           mutation became equivalent, and the property survived only on
#           Lokinet, where nothing was testing it. It is now driven through the
#           REAL warm-up (chatFastDispatcherWarm: "classifies an unresolvable
#           .loki ... not a seam") rather than an injected verdict.
#  T21  The censorship fallback tries `.onion` only.
#         → a clearnet-censored peer that published only an I2P destination is
#           recorded unreachable and falls out of the directory.
#  T22  Transport entry points stop normalising a local fault.
#  T23  The health endpoint stops surfacing failure reasons.
#  T24  The health block escapes its operator-only gate.
#
#  T25  Peers are ranked by probe recency again.
#         → the bounded fan-out spends its slots on instances known to be dead,
#           because "probed recently" says nothing about "can answer".
#  T26  A never-probed instance is promoted to the top of the ranking.
#         → anyone can register an origin on chain, so a burst of junk
#           registrations evicts the live federation from every peer list.
#  T27  A dead instance ranks with the healthy ones.
#  T28  A censored instance is demoted below the failures.
#         → clearnet_blocked means alive-on-chain but unreachable over clearnet,
#           which is the case this subsystem exists for, not a sick peer.
#  T29  An unrecognised status ranks best.
#         → a status added later silently outranks everything known to work.
#  T30  The registration tiebreak is dropped.
#  T31  The ranking is not a total order.
#         → an unchanged directory reshuffles between refreshes.
#  T32  The ranking mutates the caller's array.
#  T33  The fan-out bound is handed to SQL instead of applied after ranking.
#         → the database decides which peers get fast chat, by an ordering no
#           test can execute.
#  T34  The truncation count never reaches /v1/health.
#  T35  A network proven to work keeps the addresses held against it.
#          → suspicion accrues across successes, so two bad records separated
#            by a working hour convict the router anyway.
#  T36  Stale suspicion never expires.
#          → every long-lived instance eventually accumulates enough unrelated
#            bad addresses to convict itself of an outage it never had.
#  T37  The same address failing twice is counted as two addresses.
#  T38  The warm path decides for itself instead of asking the one rule.
#  T39  A local fault held against an unconvicted network is never reported.
#          → the operator sees localFault failures beside an empty networksDown
#            and no way to tell a deliberate rule from a broken field.
#  T40  The health route stops passing the held-fault count through.
#  T41  Conviction leaves the suspicion behind.
#  T42  A network already convicted keeps recording suspicion against itself.
#
#  T43-T46 came from asking what happens when the I2P proxy ANSWERS a CONNECT
#  and refuses it — the Java router's documented behaviour with
#  `i2ptunnel.httpclient.allowInternalSSL=false`, which refuses in-network
#  destinations on every port including 80.
#
#  T43  A refused CONNECT is read as the peer's failure again.
#          → a router configured to refuse tunnels has federated chat over I2P
#            dead, with the failures recorded against healthy peers and nothing
#            anywhere naming the cause.
#  T44  A refused CONNECT is treated as conclusive evidence about the network.
#          → the opposite error: one destination the router cannot reach takes
#            I2P away from every other peer.
#  T45  The chat pool goes back to undici's ProxyAgent.
#          → the refusal returns as UND_ERR_ABORTED with the status in prose,
#            which is the same shape an ordinary abort has. Nothing to decide on.
#  T46  The PROBE goes back to undici's ProxyAgent.
#          → the same blindness in the other copy of this decision.
#  T48-T50 are about a relationship between two constants in two files that
#  nothing asserted, found because lowering KEEP_ALIVE_MS to 1ms left the ENTIRE
#  battery green: every reuse check sends its messages back-to-back, so undici
#  reuses a socket that never had a chance to go idle.
#
#  T48  The idle keep-alive drops below the warm-up interval.
#          → every warm-up finds a closed socket, so the loop that exists to
#            REMOVE the cold-start cost pays it instead, on a timer, forever.
#            Messages still arrive and the warm-up still reports success; only
#            the latency moves, on the transports where a rebuild is 30-60s.
#  T49  The warm-up interval grows past the keep-alive.
#          → the same failure approached from the other file, which is the point
#            of asserting the RELATIONSHIP rather than either value.
#  T50  The keep-alive outlives the circuit idle timeout it is protecting.
#          → we hold a connection Tor has already reclaimed, so the first
#            message over it stalls rather than being fast.
#
#  T51-T55 — a hidden-only node contacts no clearnet host (F30). fetchJson
#  carries its own transport (system DNS + an IP-pinned agent), so the
#  fail-closed router never saw the probe's clearnet requests: a DNS query and
#  a direct connection to every clearnet peer, from a "zero clearnet" node.
#  T56-T60 — a hidden-only node gets its peer prices (F31): every published
#  hidden address, I2P first, through the hidden transport with the hidden
#  budget. The sampler sent them through a fetch that refuses http://, so
#  the federated median such a node prices from never had a sample.
#  T61-T70 — the relay is hidden-only too, and the claim asks it (F32). The
#  relay broadcasts, and it had no router, no hidden endpoints and no proxy
#  settings; a tor-only install left it on clearnet RPC while the instance
#  claimed zero clearnet, computed from the indexer alone. These guard the
#  relay's own config and health (run in the relay's suite) and the indexer's
#  relay leg: silence is not proof, the claim does not flicker with uptime,
#  and a hidden-only indexer never resolves its relay's public name.
#  T71-T77 — our own daemons, asked directly. Lokinet answers `localhost.loki`
#  with this node's address: the one `.loki` name no peer supplied. With it, a
#  peer's dead `.loki` is the peer's failure (so it stops holding a fan-out
#  slot) and our router failing its own name convicts on one miss. Tor/I2P
#  proxies are TCP-checked at boot, so a dead daemon is off the fan-out before
#  the first message instead of after it.
#  T78-T88 — the upgrade brings EXISTING tor-only relays into line (F32). The
#  template fix reaches fresh installs only: `morphit-ops upgrade` does not
#  re-render templates, so every node that was actually exposed would have kept
#  a clearnet relay. The heal reads the env files the way the units do (bash,
#  unit order, empty environment), writes only the old template's shape, never
#  rewrites an explicit setting, and is run by the real `__post-upgrade-selfheal`
#  entry point. T61 now targets the package: the hidden-only rule moved there so
#  the relay and the heal share one reading of it.
#  T89-T91 — the heal after the final review (O6, O7): run from the shared heal
#  list, announced only once the relay's own health report says so, and put
#  back if the relay does not come up.
#  T92-T93 — the final review's transport findings: the peer-facing nginx keeps
#  idle connections past the warm-up (S5), and Lokinet stays off unless asked
#  for, so no .loki name reaches the ISP's resolver (S3).
#
#  T47  The per-network confidence FALLBACK stops treating Lokinet as
#       ambiguous.
#          → this is the rule that decides for a marker raised without a
#            classification, which is what a blanked config and every test seam
#            produce, so it carries more traffic than it looks like it does.
#            Lokinet convicts on one address again and F11 comes straight back.
#          → the same blindness in the other copy of this decision, which writes
#            `unreachable` across the directory instead of losing one message.
#          → it appears in networksDown and networksSuspected at once, the two
#            fields disagreeing about the same network. Reached on every message
#            to a hidden-only peer, because the breaker never silences a peer.
#          → a network is reported as down AND as suspected, so the two fields
#            give contradictory accounts of the same network.
#          → the same blindness, one layer out, and the kind a field-by-field
#            rewrite of that object introduces without anyone noticing.
#          → the evidence rule exists in two places and they disagree: a
#            directory holding a single .loki peer convicts the network on the
#            warm path while the send path would not. This is how the send
#            path's version of the bug survived review in the first place.
#          → one peer retried is read as corroboration, which is the single
#            failure rule back again wearing the new rule's clothes.
#         → the bound goes back to being silent, which is the only thing that
#           made it different from the bug.
#
# An equivalent mutant is NOT included, deliberately: adding `ens` to the
# dialable key list changes nothing, because the shape check rejects a `.eth`
# name however the list is written. It is recorded in the audit under F5 rather
# than dressed up as a caught mutation here.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

# ── Hermetic copy ────────────────────────────────────────────────────
# Same reasoning as the sibling harnesses: mutate a COPY, never the tree the
# operator is working in.
#
# THE node_modules PART IS NOT BOILERPLATE, and getting it wrong cost this
# harness its first five mutations. The sibling harnesses symlink the whole of
# node_modules, which is correct for them because everything they mutate lives
# under `apps/indexer/src` and is resolved by tsconfig paths out of the COPY.
#
# This harness also mutates `packages/hidden-transport`, and that is reached as
# `@morphit/hidden-transport` — an npm-workspace symlink inside node_modules
# pointing back at the REAL tree. Symlink node_modules wholesale and every
# mutation to a package is faithfully applied to a file the tests never read:
# they pass, and the harness reports five bugs as "not guarded" when in truth
# they were never introduced. That is the single most misleading thing a
# mutation harness can do, and it is the exact failure `mutate()`'s
# found-exactly-once check exists to prevent — which it cannot catch here,
# because the text WAS found and WAS replaced.
#
# So node_modules is rebuilt: a real directory of symlinks to the real one, with
# `@morphit/*` redirected into THIS copy's packages.
mkdir -p "$WORK"
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
# The heal's tests compare its file lists with the units' own ExecStart lines.
mkdir -p "$WORK/ops"
cp -r "$REPO/ops/systemd" "$WORK/ops/systemd"
# hiddenPoolKeepAlive checks the frontend nginx every peer's hidden-service
# connection lands on (v1.18.0 review, S5), and T92 mutates it.
mkdir -p "$WORK/ops/bunkerweb"
cp -r "$REPO/ops/bunkerweb/frontend" "$WORK/ops/bunkerweb/frontend"

mkdir -p "$WORK/node_modules"
for entry in "$REPO"/node_modules/*; do
	name="$(basename "$entry")"
	[ "$name" = '@morphit' ] && continue
	ln -s "$entry" "$WORK/node_modules/$name"
done
for entry in "$REPO"/node_modules/.[!.]*; do
	[ -e "$entry" ] || continue
	ln -s "$entry" "$WORK/node_modules/$(basename "$entry")"
done
mkdir -p "$WORK/node_modules/@morphit"
for pkg in "$REPO"/node_modules/@morphit/*; do
	name="$(basename "$pkg")"
	ln -s "$WORK/packages/$name" "$WORK/node_modules/@morphit/$name"
done

# Prove the redirection actually took, before a single mutation is applied. A
# harness that can be wrong about this is a harness whose green is worthless.
probe_marker='__morphit_transport_harness_marker__'
printf '\nexport const %s = 1;\n' "$probe_marker" >> "$WORK/packages/hidden-transport/src/index.ts"
if ! ( cd "$WORK/apps/indexer" && node -e "
  const fs = require('fs');
  // The package's own entry, not a deep path: since v1.18.0 it has an exports
  // map (it gained a ./router entry), and a deep path is no longer resolvable.
  const p = require.resolve('@morphit/hidden-transport', { paths: [process.cwd()] });
  process.exit(fs.readFileSync(p, 'utf8').includes('$probe_marker') ? 0 : 1);
" ) 2>/dev/null; then
	echo "ERROR: @morphit/hidden-transport still resolves to the real tree." >&2
	echo "       Every mutation to a package would be applied to a file the tests never read," >&2
	echo "       and would be reported as SURVIVED. Refusing to run." >&2
	exit 2
fi
python3 - "$WORK/packages/hidden-transport/src/index.ts" "$probe_marker" <<'PYEOF'
import sys
p, marker = sys.argv[1], sys.argv[2]
s = open(p).read()
open(p, 'w').write(s.replace(f"\nexport const {marker} = 1;\n", ""))
PYEOF

HT="$WORK/packages/hidden-transport/src/index.ts"
FED="$WORK/apps/indexer/src/indexer/chatFastFederation.ts"
DISPATCH="$WORK/apps/indexer/src/indexer/chatFastDispatcher.ts"
POOL="$WORK/apps/indexer/src/indexer/hiddenServicePool.ts"
FETCH="$WORK/apps/indexer/src/indexer/hiddenServiceFetch.ts"
PROBE="$WORK/apps/indexer/src/indexer/federationProbe.ts"
HEALTH="$WORK/apps/indexer/src/api/health.ts"
# The router moved into the package in v1.18.0 (F32) so the relay installs the
# same one; the indexer's hiddenServiceDispatcher.ts is a re-export now.
ROUTER="$WORK/packages/hidden-transport/src/router.ts"
PRICE="$WORK/apps/indexer/src/indexer/price/peerPriceMonitor.ts"
GATE="$WORK/apps/indexer/src/indexer/clearnetGate.ts"
POSTURE="$WORK/apps/indexer/src/indexer/relayPosture.ts"
OPH="$WORK/apps/indexer/src/api/operationalHealth.ts"
RCFG="$WORK/apps/relay/src/config/index.ts"
LIVE="$WORK/apps/indexer/src/indexer/localTransportLiveness.ts"
RHEALTH="$WORK/apps/relay/src/api/health.ts"
HEAL="$WORK/apps/ops-cli/src/lib/relayHiddenHeal.ts"
OPSMAIN="$WORK/apps/ops-cli/src/main.ts"
OPSUPGRADE="$WORK/apps/ops-cli/src/commands/upgrade.ts"

# The four files under test, plus the two that cover the surfaces these
# mutations reach. Run as a set so a mutation is caught by whichever of them
# actually guards it, rather than by whichever one this harness guessed.
TESTS=(
	test/indexer/localTransportFault.test.ts
	test/indexer/fastPeerAddressing.test.ts
	test/indexer/chatFastDispatcherWarm.test.ts
	test/indexer/federationProbeLocalProxyDown.test.ts
	test/indexer/hiddenPoolKeepAlive.test.ts
	test/api/health.test.ts
	test/indexer/hiddenOnlyNoClearnet.test.ts
	test/api/relayPostureGate.test.ts
	test/indexer/localTransportLiveness.test.ts
	test/indexer/lokinetOptIn.test.ts
)
# The relay half of F32 lives in the relay's own suite.
RELAY_TESTS=(
	test/hiddenOnly.test.ts
)
# The upgrade heal for existing relays lives in ops-cli.
OPS_TESTS=(
	test/relayHiddenHeal.test.ts
)

run_tests(){
	local a b c
	a="$( cd "$WORK/apps/indexer" && timeout 300 npx vitest run "${TESTS[@]}" 2>&1 )"
	b="$( cd "$WORK/apps/relay" && timeout 300 npx vitest run "${RELAY_TESTS[@]}" 2>&1 )"
	c="$( cd "$WORK/apps/ops-cli" && timeout 300 npx vitest run "${OPS_TESTS[@]}" 2>&1 )"
	printf '%s\n%s\n%s\n' "$a" "$b" "$c"
	# Three suites, three verdicts. One that never reported is a crash, never a
	# pass carried by the others: a relay run that died on an import must not
	# read as green because the indexer's was.
	if ! printf '%s' "$a" | grep -qE 'Tests +[0-9]+' || ! printf '%s' "$b" | grep -qE 'Tests +[0-9]+' \
		|| ! printf '%s' "$c" | grep -qE 'Tests +[0-9]+'; then
		echo 'RUN-INCOMPLETE'
	fi
}

verdict(){ # <output> -> pass | fail | crash
	if printf '%s' "$1" | grep -q 'RUN-INCOMPLETE'; then echo crash
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ (failed|passed).*failed'; then echo fail
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ failed'; then echo fail
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ passed'; then echo pass
	else echo crash; fi
}

snapshot(){ cp "$1" "$1.orig"; }
restore(){ mv "$1.orig" "$1"; }

# Apply an exact literal substitution and REFUSE to continue if the text was not
# found. A mutation that silently fails to apply produces a green run against
# unmutated source — the single most misleading outcome a harness can have.
mutate(){ # <file> <needle-file> <replacement-file>
	python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
path, needle_path, repl_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
needle = open(needle_path).read()
repl = open(repl_path).read()
if src.count(needle) != 1:
    sys.stderr.write(f"mutation target found {src.count(needle)} times, expected exactly 1\n")
    sys.exit(3)
open(path, 'w').write(src.replace(needle, repl))
PYEOF
}

# A mutation must make the tests FAIL. A crash is never a catch: a run that died
# on a syntax error detected nothing, and counting it as success is precisely
# how a guard ends up guarding nothing.
expect_caught(){ # <label> <file>
	local label="$1" file="$2" out v
	out="$(run_tests)"; v="$(verdict "$out")"
	case "$v" in
		fail) ok "$label — caught" ;;
		pass) no "$label — SURVIVED. The tests pass with this bug in place, so they are not guarding it." ;;
		crash)
			no "$label — the run CRASHED; no verdict. Not counted as a catch."
			printf '%s\n' "$out" | tail -5 | sed 's/^/        /' ;;
	esac
	restore "$file"
}

# Convenience: one-line literal mutation.
try(){ # <label> <file> <needle> <replacement>
	local label="$1" file="$2"
	snapshot "$file"
	printf '%s' "$3" > "$WORK/.needle"
	printf '%s' "$4" > "$WORK/.repl"
	if mutate "$file" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught "$label" "$file"
	else
		no "$label — mutation did not apply (the code moved; update this harness)"
		restore "$file"
	fi
}

echo 'fastchat-transport-harness — are the transport tests actually tests?'
echo ''

base_out="$(run_tests)"
if [ "$(verdict "$base_out")" = pass ]; then
	ok 'baseline — the tests pass against unmutated source'
else
	no 'baseline FAILED — the tests do not pass before any mutation. Nothing below means anything.'
	printf '%s\n' "$base_out" | tail -15 | sed 's/^/        /'
	echo ''
	printf '\033[31m✗ aborting: the baseline must be green\033[0m\n'
	exit 1
fi

# ── the classifier ───────────────────────────────────────────────────
try 'T1  instanceof at a fetch boundary (the original bug)' "$HT" \
	'if (chain.some((e) => e instanceof ProxyUnavailableError)) return true;' \
	'if (err instanceof ProxyUnavailableError) return true;'

try 'T2  I2P blames any connect failure on our proxy' "$HT" \
	'			return c.address === host && c.port === port;' \
	'			return true;'

try 'T3  a DNS failure is ours on every network' "$HT" \
	"	if (network === 'loki') {" \
	"	if (network === 'loki' || true) {"

try 'T4  clearnet can be marked unreachable' "$HT" \
	'	if (network === null) return false;
	const chain = causeChain(err);' \
	'	const chain = causeChain(err);'

try 'T5  the cause chain is walked without cycle protection' "$HT" \
	'	while (cur !== null && cur !== undefined && out.length < maxDepth && !seen.has(cur)) {' \
	'	while (cur !== null && cur !== undefined && out.length < maxDepth) {'

# ── which address a peer is reached at ───────────────────────────────
# Re-aimed after the v1.18.0 deep-deep (TP-C1): the origin is now added under a
# hidden-only condition; the mutation adds the old "only if nothing hidden was
# found" guard to that line (as M35 in federation-chat-fast-harness).
try 'T6  a hidden address discards the clearnet origin' "$FED" \
	'	if (originHidden || !hiddenOnly) add(row.origin, originHidden);
' \
	'	if (addresses.length === 0 && (originHidden || !hiddenOnly)) add(row.origin, originHidden);
'

try 'T7  the operator off-switch is ignored' "$FED" \
	'			if (network === null || !networkConfigured(network, proxies)) continue;' \
	'			if (network === null) continue;'

try 'T8  alt-network values are no longer shape-checked' "$FED" \
	'			const network = hiddenHostNetworkOf(bare);' \
	"			const network = hiddenHostNetworkOf(bare) ?? 'tor';"

try 'T9  the queue key moves with the address' "$FED" \
	'		key: normalisedOrigin(row.origin),' \
	'		key: first.origin,'

# ── the send path ────────────────────────────────────────────────────
try 'T10 the sender never fails over' "$FED" \
	'		if (res.localFault !== true) {' \
	'		if (true) {'

try 'T11 a PEER failure triggers a failover too' "$FED" \
	'		if (res.localFault !== true) {' \
	'		if (false) {'

try 'T12 a local fault is never detected' "$FED" \
	'		const localFault = isProxyUnavailable(err);' \
	'		const localFault = false;'

try 'T13 the breaker can leave a peer with no address' "$FED" \
	'	const order = usable.length > 0 ? usable : all;' \
	'	const order = usable;'

try 'T14 a success no longer clears the mark' "$FED" \
	'			reach.markUp(network);
			supersede(null);
			return null;' \
	'			supersede(null);
			return null;'

try 'T15 a hidden peer is dialled over the clearnet transport' "$FED" \
	'		const res = addr.hidden' \
	'		const res = false'

# ── the warm-up ──────────────────────────────────────────────────────
try 'T16 the warm-up warms every alternate regardless of cost' "$DISPATCH" \
	'				if (hasCheapFallback) break;' \
	''

try 'T17 the warm-up never warms an alternate' "$DISPATCH" \
	'				if (hasCheapFallback) break;' \
	'				break;'

try 'T18 one failed route marks the whole network down' "$DISPATCH" \
	'			seenNet.allLocalFault = seenNet.allLocalFault && !res.ok && res.localFault;' \
	'			seenNet.allLocalFault = seenNet.allLocalFault || (!res.ok && res.localFault);'

try 'T19 the warm-up verdict never reaches the tracker' "$DISPATCH" \
	'			if (verdict.any) this.sender.reachability.markUp(net as HiddenNetwork);' \
	'			if (false) this.sender.reachability.markUp(net as HiddenNetwork);'

# The result now also carries a confidence (v1.18.0 review, S2), so the
# classification is its own line.
try 'T20 the warm-up is blind on I2P and Lokinet' "$POOL" \
	'		const localFault = isLocalTransportFault(err, network, config);' \
	'		const localFault = isProxyUnavailable(err);'

# ── the directory probe ──────────────────────────────────────────────
try 'T21 the censorship fallback tries .onion only' "$PROBE" \
	'	for (const host of [alt.tor, alt.i2p_b32, alt.i2p_name, alt.lokinet]) {' \
	'	for (const host of [alt.tor]) {'

try 'T22 the probe transport stops normalising a local fault' "$FETCH" \
	'		throw asLocalTransportFault(err, network, config);' \
	'		throw err;'

# ── what an operator can actually see ────────────────────────────────
try 'T23 failure reasons are no longer surfaced' "$HEALTH" \
	'						federationDiagnostics: chatFastDispatcher?.diagnostics() ?? null,' \
	''

try 'T24 the operator-only block is exposed publicly' "$HEALTH" \
	"		const localDiag = c.req.header('x-morphit-local-health') === '1';" \
	'		const localDiag = true;'

# ── which peers get a bounded fan-out slot ───────────────────────────
# The rank reads the probe error too since the final review (S2).
try 'T25 peers are ranked by probe recency again' "$FED" \
	'		const ra = peerRank(a.last_probe_status, a.last_probe_error);
		const rb = peerRank(b.last_probe_status, b.last_probe_error);
		if (ra !== rb) return ra - rb;' \
	''

try 'T26 a never-probed instance is promoted to the top' "$FED" \
	'	never: 4,' \
	'	never: -1,'

try 'T27 a dead instance ranks with the healthy' "$FED" \
	'	unreachable: 6' \
	'	unreachable: 0'

try 'T28 a censored instance is demoted below the failures' "$FED" \
	'	clearnet_blocked: 3,' \
	'	clearnet_blocked: 6,'

try 'T29 an unrecognised status ranks best' "$FED" \
	'const PEER_RANK_UNKNOWN = 7;' \
	'const PEER_RANK_UNKNOWN = -1;'

try 'T30 the registration tiebreak is dropped' "$FED" \
	'		const ga = timeValue(a.registered_at_time);
		const gb = timeValue(b.registered_at_time);
		if (ga !== gb) {
			if (ga === null) return 1;
			if (gb === null) return -1;
			return ga - gb;
		}' \
	''

try 'T31 the ranking is not a total order' "$FED" \
	'		return a.origin.localeCompare(b.origin);' \
	'		return 0;'

try 'T32 the ranking mutates the caller array' "$FED" \
	'	return [...rows].sort((a, b) => {' \
	'	return (rows as DirectoryPeerRow[]).sort((a, b) => {'

try 'T33 the fan-out bound is handed to SQL' "$FED" \
	'		[selfOrigin, DIRECTORY_SCAN_MAX]' \
	'		[selfOrigin, limit]'

try 'T34 the truncation count is never recorded' "$DISPATCH" \
	'					this.peersDropped = dir.dropped;' \
	''

try 'T35 a proven success no longer clears suspicion' "$FED" \
	'		this.downUntil.delete(network);
		// The network demonstrably works, so every address we were holding
		// against it is the address'\''s problem, not the router'\''s.
		this.suspect.delete(network);' \
	'		this.downUntil.delete(network);'

try 'T36 stale suspicion never expires' "$FED" \
	'		for (const [addr, at] of seen) if (now - at >= NETWORK_DOWN_MS) seen.delete(addr);' \
	'		void 0;'

try 'T37 the same address failing twice counts twice' "$FED" \
	'		const seen = this.suspect.get(network) ?? new Map<string, number>();' \
	'		const seen = this.suspect.get(network) ?? new Map<string, number>();
		addressKey = `${addressKey}:${Math.random()}`;'

try 'T38 the warm path reaches its own verdict again' "$DISPATCH" \
	'			else if (verdict.allLocalFault)
				for (const f of verdict.faulted)
					this.sender.reachability.reportAddressFault(' \
	'			else if (verdict.allLocalFault) this.sender.reachability.markDown(net as HiddenNetwork);
			else if (false)
				for (const f of verdict.faulted)
					this.sender.reachability.reportAddressFault('

try 'T39 a held fault is never reported' "$DISPATCH" \
	'			networksSuspected: this.sender.reachability.pendingSuspicion(),' \
	'			networksSuspected: {},'

try 'T40 the health route drops the held-fault count' "$HEALTH" \
	'						federationDiagnostics: chatFastDispatcher?.diagnostics() ?? null,' \
	'						federationDiagnostics: chatFastDispatcher
							? {
									networksDown: chatFastDispatcher.diagnostics().networksDown,
									recentFailures: chatFastDispatcher.diagnostics().recentFailures
								}
							: null,'

try 'T41 a convicted network is still reported as suspected' "$FED" \
	'		this.downUntil.set(network, now + NETWORK_DOWN_MS);
		this.suspect.delete(network);' \
	'		this.downUntil.set(network, now + NETWORK_DOWN_MS);'

try 'T42 a convicted network keeps accruing suspicion' "$FED" \
	'		if (this.isDown(network, now)) return true;' \
	'		void 0;'

# ── the proxy that answers and refuses ───────────────────────────────

try 'T43 a refused CONNECT is blamed on the peer again' "$HT" \
	'		if (chain.some((e) => e instanceof ProxyConnectRejectedError)) return true;' \
	'		void 0;'

try 'T44 a refused CONNECT is treated as conclusive' "$HT" \
	"	if (chain.some((e) => e instanceof ProxyConnectRejectedError)) return 'ambiguous';" \
	'	void 0;'

try 'T45 the chat pool reverts to undici ProxyAgent' "$POOL" \
	'			connect: makeHttpConnectConnector(host, port) as any,' \
	'			connect: undefined as any,'

try 'T46 the PROBE reverts to undici ProxyAgent' "$FETCH" \
	'		dispatcher = new Agent({ connect: makeHttpConnectConnector(host, port) as any });' \
	'		dispatcher = new (require("undici").ProxyAgent)(`http://${host}:${port}`);'

try 'T47 the per-network confidence fallback loses Lokinet' "$HT" \
	"	if (network === 'loki') return lokinetLive === false ? 'conclusive' : 'ambiguous';" \
	"	if (network === 'loki') return 'conclusive';"

# ── the keep-alive and the warm interval ─────────────────────────────

try 'T48 the keep-alive drops below the warm-up interval' "$POOL" \
	'export const KEEP_ALIVE_MS = 4 * 60 * 1000;' \
	'export const KEEP_ALIVE_MS = 1;'

try 'T49 the warm-up interval grows past the keep-alive' "$DISPATCH" \
	'export const WARM_INTERVAL_MS = 3 * 60 * 1000;' \
	'export const WARM_INTERVAL_MS = 9 * 60 * 1000;'

try 'T50 the keep-alive outlives the circuit it is protecting' "$POOL" \
	'export const KEEP_ALIVE_MS = 4 * 60 * 1000;' \
	'export const KEEP_ALIVE_MS = 15 * 60 * 1000;'

# ── a hidden-only node contacts no clearnet host (F30) ───────────────
try 'T51 fetchJson ignores the hidden-only policy' "$PROBE" \
	'	if (clearnetRefused()) {' \
	'	if (false) {'

try 'T52 the policy is checked only AFTER the DNS lookup names the peer' "$PROBE" \
	'	if (clearnetRefused()) {
		throw new ClearnetRefusedError(parsed.origin);
	}
	const hostname = parsed.hostname.toLowerCase();' \
	'	const hostname = parsed.hostname.toLowerCase();
	await (_dnsResolverForTesting ?? resolveAndValidatePublicIp)(hostname).catch(() => undefined);
	if (clearnetRefused()) {
		throw new ClearnetRefusedError(parsed.origin);
	}'

try 'T53 installing the router no longer records the policy' "$ROUTER" \
	'	clearnetPolicy = policy;' \
	''

try 'T54 the probe contacts clearnet peers on a hidden-only node' "$PROBE" \
	'					const hiddenOnly = clearnetRefused();' \
	'					const hiddenOnly = false;'

try 'T55 a request we declined to make is recorded against the peer' "$PROBE" \
	"					if (hiddenOnly && outcome.status === 'unreachable' && onlyOurSideFailed) {" \
	'					if (false) {'

# ── a hidden-only node gets its peer prices (F31) ────────────────────
try 'T56 the price sampler knows only i2p_b32 and tor again' "$PRICE" \
	'	return hosts
		.map((h, i) => ({ h, i }))' \
	"	return hosts
		.filter((h) => h.endsWith('.b32.i2p') || h.endsWith('.onion'))
		.map((h, i) => ({ h, i }))"

try 'T57 the price sampler tries Tor before I2P' "$PRICE" \
	'{ i2p: 0, tor: 1, loki: 2 }' \
	'{ i2p: 1, tor: 0, loki: 2 }'

try 'T58 a hidden address goes through the clearnet fetch' "$PRICE" \
	'			const r = hiddenOnly' \
	'			const r = false'

try 'T59 a peer is tried at its first address only' "$PRICE" \
	'		for (const base of t.bases) {' \
	'		for (const base of t.bases.slice(0, 1)) {'

try 'T60 the hidden budget is discarded again' "$PRICE" \
	'		const body = await fetcher<PeerReceiptResponse>(url.toString(), timeoutMs);' \
	'		const body = await fetcher<PeerReceiptResponse>(url.toString(), PEER_FETCH_TIMEOUT_MS);'

# ── the relay is hidden-only too, and the claim asks it (F32) ────────
try 'T61 the relay never recognises it is hidden-only' "$HT" \
	'	return all.length > 0 && all.every((ep) => isHiddenServiceOrigin(ep));' \
	'	return false;'

try 'T62 a hidden-only relay still sends Web Push' "$RCFG" \
	'				!relayIsHiddenOnly(blurtRpcEndpoints, hiddenRpcEndpoints)' \
	'				true'

try 'T63 a hidden-only relay installs the router in allow mode' "$RCFG" \
	"	if (cfg.hiddenOnly) return 'refuse';" \
	"	if (cfg.hiddenOnly) return 'allow';"

try 'T64 the relay stops saying what it is' "$RHEALTH" \
	'				hidden_only: this.cfg.hiddenOnly' \
	'				hidden_only: undefined'

try 'T65 the hidden knob accepts a clearnet URL' "$RCFG" \
	"		if (!isHiddenServiceOrigin(ep) || (net !== 'tor' && net !== 'i2p')) {" \
	'		if (false) {'

try 'T66 the gate stops requiring the relay' "$GATE" \
	'		legs.matrixClean &&
		legs.relayHidden' \
	'		legs.matrixClean'

try 'T67 a relay that says nothing counts as hidden-only' "$POSTURE" \
	'	return lastReported === true;' \
	'	return lastReported !== false;'

try 'T68 the claim flickers with the relay uptime' "$OPH" \
	'						hidden_only: relayRes.value.up ? relayRes.value.hiddenOnly : cached.relay.hidden_only' \
	'						hidden_only: relayRes.value.hiddenOnly'

try 'T69 a hidden-only indexer resolves its relay public name' "$OPH" \
	'		(u) => !(clearnetRefused() && needsPublicLookup(u))' \
	'		(u) => u.length > 0'

try 'T70 the relay answer never reaches the gate' "$OPH" \
	'	noteRelayHiddenOnly(cached.relay.hidden_only);' \
	''

# ── our own daemons, asked directly (localTransportLiveness) ─────────
try 'T71 the classifier ignores that our lokinet answered its own name' "$HT" \
	'		if (lokinetLive === true) return false;' \
	''

try 'T72 our lokinet failing its own name stays ambiguous' "$HT" \
	"	if (network === 'loki') return lokinetLive === false ? 'conclusive' : 'ambiguous';" \
	"	if (network === 'loki') return 'ambiguous';"

try 'T73 lokinet is asked a name no one vouches for' "$HT" \
	"export const LOKINET_SELF_NAME = 'localhost.loki';" \
	"export const LOKINET_SELF_NAME = 'self.loki';"

try 'T74 the lokinet answer is never recorded' "$LIVE" \
	'	noteLokinetLiveness(loki);' \
	''

try 'T75 a daemon the operator does not run is counted as down' "$LIVE" \
	"	if (state.tor === false) out.push('tor');" \
	"	if (state.tor !== true) out.push('tor');"

try 'T76 the dispatcher asks and then ignores the answer' "$DISPATCH" \
	'			for (const net of networksDownIn(state)) this.sender.reachability.markDown(net);' \
	''

try 'T77 a wedged resolver hangs the check' "$LIVE" \
	'				timer = setTimeout(() => r(false), timeoutMs);' \
	'				timer = setTimeout(() => r(false), 2_147_483_647);'

# ── existing relays, brought into line on upgrade ────────────────────

try 'T78 the heal decides and never writes' "$HEAL" \
	"				appendFileSync(target, renderRelayHealBlock(decision.settings), 'utf8');" \
	''

try 'T79 an explicit relay list is rewritten' "$HEAL" \
	'	if (relayClearRaw !== undefined) {' \
	'	if (false) {'

try 'T80 a clearnet node has its relay stripped of clearnet' "$HEAL" \
	"	if (idxClear.length > 0) return { kind: 'indexer-uses-clearnet' };" \
	''

try 'T81 the upgrade process environment stands in for the files' "$HEAL" \
	"		env: { PATH: '/usr/local/bin:/usr/bin:/bin' }," \
	'		env: { ...process.env },'

try 'T82 the files are read in the opposite order to the unit' "$HEAL" \
	$'\t\t`for f in ${files.map(shq).join(\' \')}; do [ -f "$f" ] && . "$f"; done`,' \
	$'\t\t`for f in ${[...files].reverse().map(shq).join(\' \')}; do [ -f "$f" ] && . "$f"; done`,'

try 'T83 a hidden list the relay refuses at boot is copied to it' "$HEAL" \
	'		if (idxHidden.length > 0 && idxHidden.every(relayAcceptsHidden)) {' \
	'		if (idxHidden.length > 0) {'

try 'T84 a blank proxy (no daemon here) is not carried over' "$HEAL" \
	'		if (relay.get(relayName) === undefined && v !== undefined) settings.push([relayName, v]);' \
	'		if (relay.get(relayName) === undefined && v) settings.push([relayName, v]);'

try 'T85 the block is glued to a last line with no newline' "$HEAL" \
	"		'\\n# ─── Added by morphit-ops upgrade (v1.18.0) ───────────────────\\n' +" \
	"		'# ─── Added by morphit-ops upgrade (v1.18.0) ───────────────────\\n' +"

try 'T86 a relay left with no endpoint at all is written anyway' "$HEAL" \
	"	if (!isHiddenOnlyEndpointSet([], finalHidden)) return { kind: 'relay-has-no-endpoints' };" \
	''

try 'T87 the upgrade self-heal phase never runs it' "$OPSUPGRADE" \
	"		['the relay RPC heal', () => healRelayClearnet()]," \
	''

try 'T89 the self-heal phase stops calling the shared heal list' "$OPSMAIN" \
	'			await runSelfHeals();' \
	''

try 'T90 the heal announces the result without checking the relay' "$HEAL" \
	'	if (last.reachable && last.hiddenOnly === true) {' \
	'	if (true) {'

try 'T91 a relay that does not come back is left on the new settings' "$HEAL" \
	'		copyFileSync(relayHealBackupPath(target), target);' \
	'		void 0;'

try 'T88 the relay file list drifts from the unit' "$HEAL" \
	"	'/etc/morphit/relay-vapid.env'" \
	''

# ── The final review's transport findings (S5, S3) ──────────────────────
# T92: the peer-facing nginx falls back to its 75 s default idle timeout, so
# every three-minute warm-up finds the connection closed and pays a new tunnel.
try 'T92 the frontend drops idle peer connections before the next warm-up' "$WORK/ops/bunkerweb/frontend/nginx.conf" \
	'    keepalive_timeout 300s 300s;' \
	''
# T93: Lokinet on by default again — every node without lokinet asks its ISP's
# resolver for .loki names, once a minute and for every .loki peer.
try 'T93 a node that never asked for Lokinet looks .loki names up anyway' "$HT" \
	"	return (env.MORPHIT_INSTANCE_LOKINET_ADDRESS ?? '').trim().length > 0;" \
	'	return true;'

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fastchat-transport-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
