#!/usr/bin/env bash
# Run on: a dev checkout or container (NOT a production node).
#
# fastchat-latency-probe-harness — EXECUTE ops/fastchat-latency-probe.sh
# against real stub proxies and a real stub peer, and check what it reports.
#
# WHY AN EXECUTION HARNESS. The probe is what the maintainer runs on the real boxes right
# after a release to learn whether six seconds holds over real Tor and I2P. The
# v1.18.0 review found it could not be trusted on the paths that matter:
#
#   P1  a clearnet address was contacted DIRECTLY, from the box's own IP — on a
#       tor-only home server, the one thing that box exists not to do;
#   P2  an error page from the local I2P proxy counted as a timing sample, so a
#       proxy answering 500 to everything produced "PASS" and exit 0;
#   P3  I2P was measured as a plain proxied GET, not the CONNECT tunnel the
#       indexer opens — a different path, and one on which a refused tunnel is
#       not even visible;
#   P4  the three "cold" Tor samples could all share one circuit, because
#       nothing asked Tor to isolate them;
#   P5  the proxy settings came from variable names the indexer does not use,
#       and a value with a scheme (http://h:p) became http://http://h:p.
#
# Each is driven here for real — bash -n and shellcheck see none of them.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE="${PROBE:-$REPO/ops/fastchat-latency-probe.sh}"
pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

W="$(mktemp -d)"
PIDS=()
cleanup(){ for p in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }
trap cleanup EXIT

# ── the stubs: a peer, a SOCKS5 proxy, an HTTP CONNECT proxy ─────────────
cat > "$W/stubs.py" <<'PY'
import socket, sys, threading, time
mode, port_file, log_file = sys.argv[1], sys.argv[2], sys.argv[3]
peer_port = int(sys.argv[4]) if len(sys.argv) > 4 else 0
status = int(sys.argv[5]) if len(sys.argv) > 5 else 200
lock = threading.Lock()
def log(line):
    with lock:
        with open(log_file, 'a') as f: f.write(line + '\n')
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except Exception: pass
def recv_exact(c, n):
    b = b''
    while len(b) < n:
        d = c.recv(n - len(b))
        if not d: raise EOFError
        b += d
    return b
def serve_peer(c):
    # HTTP/1.1 keep-alive: answer every request on the connection.
    buf = b''
    try:
        while True:
            while b'\r\n\r\n' not in buf:
                d = c.recv(65536)
                if not d: return
                buf += d
            req, buf = buf.split(b'\r\n\r\n', 1)
            log('PEER ' + req.split(b'\r\n')[0].decode())
            time.sleep(0.05)
            body = b'{"status":"ok"}'
            c.sendall(b'HTTP/1.1 %d X\r\ncontent-type: application/json\r\ncontent-length: %d\r\n\r\n' % (status, len(body)) + body)
    except Exception: pass
    finally: c.close()
def serve_socks(c):
    try:
        ver, n = recv_exact(c, 2); methods = recv_exact(c, n)
        if 2 in methods:
            c.sendall(b'\x05\x02')
            recv_exact(c, 1); ul = recv_exact(c, 1)[0]; user = recv_exact(c, ul).decode()
            pl = recv_exact(c, 1)[0]; recv_exact(c, pl)
            c.sendall(b'\x01\x00')
        else:
            user = ''
            c.sendall(b'\x05\x00')
        hdr = recv_exact(c, 4)
        atyp = hdr[3]
        if atyp == 3:
            l = recv_exact(c, 1)[0]; host = recv_exact(c, l).decode()
        elif atyp == 1:
            host = socket.inet_ntoa(recv_exact(c, 4))
        else:
            host = '?'; recv_exact(c, 16)
        tport = int.from_bytes(recv_exact(c, 2), 'big')
        log('SOCKS user=%s host=%s port=%d' % (user, host, tport))
        up = socket.create_connection(('127.0.0.1', peer_port))
        c.sendall(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00')
        threading.Thread(target=pipe, args=(c, up), daemon=True).start()
        pipe(up, c)
    except Exception: c.close()
def serve_connect(c, behaviour):
    try:
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = c.recv(65536)
            if not d: return
            buf += d
        line = buf.split(b'\r\n')[0].decode()
        log('PROXY ' + line)
        if behaviour == 'error500':
            c.sendall(b'HTTP/1.1 500 Internal Error\r\ncontent-length: 5\r\n\r\nerror'); c.close(); return
        if not line.startswith('CONNECT '):
            c.sendall(b'HTTP/1.1 400 Bad\r\ncontent-length: 0\r\n\r\n'); c.close(); return
        if behaviour == 'refuse':
            c.sendall(b'HTTP/1.1 403 Refused\r\ncontent-length: 0\r\n\r\n'); c.close(); return
        up = socket.create_connection(('127.0.0.1', peer_port))
        c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        threading.Thread(target=pipe, args=(c, up), daemon=True).start()
        pipe(up, c)
    except Exception: c.close()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', 0)); srv.listen(64)
open(port_file, 'w').write(str(srv.getsockname()[1]))
while True:
    c, _ = srv.accept()
    if mode == 'peer': t = threading.Thread(target=serve_peer, args=(c,), daemon=True)
    elif mode == 'socks': t = threading.Thread(target=serve_socks, args=(c,), daemon=True)
    else: t = threading.Thread(target=serve_connect, args=(c, mode.split(':', 1)[1]), daemon=True)
    t.start()
PY

start(){ # <name> <mode> [peer-port] [status] → sets $PORT_<name>
	local name="$1" mode="$2"; shift 2
	python3 "$W/stubs.py" "$mode" "$W/$name.port" "$W/$name.log" "$@" &
	PIDS+=("$!")
	for _ in $(seq 100); do [ -s "$W/$name.port" ] && break; sleep 0.05; done
	printf -v "PORT_$name" '%s' "$(cat "$W/$name.port")"
	: > "$W/$name.log"
}

ONION="$(printf 'a%.0s' $(seq 56)).onion"
B32="$(printf 'b%.0s' $(seq 52)).b32.i2p"

start peer peer
start peer503 peer 0 503
start socks socks "$PORT_peer"
start connect connect:ok "$PORT_peer"
start refuse connect:refuse "$PORT_peer"
start err500 connect:error500 "$PORT_peer"
start socks503 socks "$PORT_peer503"

# Where a proxy is pointed at, it is set under the indexer's names AND the
# names the pre-review probe read, so the old script is driven down the same
# path and each check can be watched failing against it.
run(){ # <env...> -- <args...>; sets OUT and RC. HOME isolated; no real env files read.
	OUT="$(env -i PATH="$PATH" HOME="$W" "$@" 2>&1)"; RC=$?
}

echo 'fastchat-latency-probe-harness — does the probe tell the truth?'
echo ''

# P1 — clearnet refused, and nothing is contacted.
: > "$W/peer.log"
run bash "$PROBE" "http://127.0.0.1:$PORT_peer" --samples 3
if [ "$RC" -eq 2 ] && [ ! -s "$W/peer.log" ]; then
	ok 'P1 a clearnet address is refused, and nothing is contacted from this box'
else
	no "P1 a clearnet address was contacted directly (exit $RC, peer saw $(wc -l < "$W/peer.log") request(s))"
fi

# P2 — a proxy answering 500 to everything is never a PASS.
run MORPHIT_INDEXER_I2P_HTTP_PROXY="127.0.0.1:$PORT_err500" MORPHIT_I2P_HTTP_PROXY="127.0.0.1:$PORT_err500" bash "$PROBE" "http://$B32" --samples 3
if [ "$RC" -ne 0 ] && ! grep -q '^PASS' <<<"$OUT"; then
	ok 'P2 a local proxy answering 500 to everything is reported as unreachable, never PASS'
else
	no "P2 a proxy that answered only errors produced exit $RC: $(printf '%s' "$OUT" | grep -E 'PASS|MOSTLY|SLOWER' | head -1)"
fi

# P3 — I2P goes through a CONNECT tunnel, like the indexer, and measures.
: > "$W/connect.log"
run MORPHIT_INDEXER_I2P_HTTP_PROXY="http://127.0.0.1:$PORT_connect/" bash "$PROBE" "http://$B32" --samples 3
if grep -q "^PROXY CONNECT $B32:80 " "$W/connect.log" && [ "$RC" -eq 0 ] && grep -q '^PASS' <<<"$OUT"; then
	ok 'P3 I2P is measured through a CONNECT tunnel, as the indexer dials it (and a scheme in the setting is accepted)'
else
	no "P3 I2P path: exit $RC; proxy saw: $(head -1 "$W/connect.log")"
fi

# P3b — a router that REFUSES the tunnel is a failure, not a timing.
run MORPHIT_INDEXER_I2P_HTTP_PROXY="127.0.0.1:$PORT_refuse" MORPHIT_I2P_HTTP_PROXY="127.0.0.1:$PORT_refuse" bash "$PROBE" "http://$B32" --samples 3
if [ "$RC" -eq 1 ] && grep -q 'could not be reached' <<<"$OUT"; then
	ok 'P3b a router that refuses the tunnel is reported as unreachable'
else
	no "P3b a refused tunnel produced exit $RC"
fi

# P4 — Tor: every cold sample on its own circuit, then a PASS.
: > "$W/socks.log"
run MORPHIT_INDEXER_TOR_SOCKS="127.0.0.1:$PORT_socks" MORPHIT_TOR_SOCKS="127.0.0.1:$PORT_socks" bash "$PROBE" "http://$ONION" --samples 3
distinct="$(grep -o 'user=morphit-cold-[^ ]*' "$W/socks.log" | sort -u | wc -l)"
if [ "$distinct" -eq 3 ] && grep -q "host=$ONION port=80" "$W/socks.log" && [ "$RC" -eq 0 ]; then
	ok 'P4 each cold Tor sample asks for its own circuit (3 distinct isolation keys), and the onion is resolved by Tor'
else
	no "P4 cold samples used $distinct distinct isolation key(s); exit $RC"
fi

# P5 — the peer's own error answer is not a timing either.
run MORPHIT_INDEXER_TOR_SOCKS="127.0.0.1:$PORT_socks503" MORPHIT_TOR_SOCKS="127.0.0.1:$PORT_socks503" bash "$PROBE" "http://$ONION" --samples 3
if [ "$RC" -ne 0 ] && ! grep -q '^PASS' <<<"$OUT"; then
	ok 'P5 a peer answering 503 is not counted as a round trip'
else
	no "P5 a peer answering only 503 produced exit $RC"
fi

# L2a — the network is decided by the real host, not by
# how the string ends. `http://<clearnet>?.loki` used to read as Lokinet, get no
# proxy, skip the --allow-clearnet guard, and be fetched from this box's IP (no
# port, because the old parse cut at the first colon). Exit 2 is "refused before
# anything was tried"; the old script tried, found nothing on port 80, and
# exited 1.
for bad in 'http://127.0.0.1?.loki' 'http://127.0.0.1#.onion' 'http://127.0.0.1/x?.i2p' "http://$ONION@127.0.0.1"; do
	run bash "$PROBE" "$bad" --samples 3
	if [ "$RC" -eq 2 ] && ! grep -q 'NOTE: .loki\|could not be reached' <<<"$OUT"; then
		ok "L2a '$bad' is refused before anything is contacted"
	else
		no "L2a '$bad' was classified as hidden and tried (exit $RC)"
	fi
done

# L2b — a BLANK Tor setting means Tor is off, as it does for
# the indexer; it used to fall back to 127.0.0.1:9050 and the "switched off"
# message could never print.
run MORPHIT_INDEXER_TOR_SOCKS= bash "$PROBE" "http://$ONION" --samples 3
if [ "$RC" -eq 2 ] && grep -q 'Tor is switched off' <<<"$OUT"; then
	ok 'L2b a blank MORPHIT_INDEXER_TOR_SOCKS is read as Tor switched off'
else
	no "L2b a blank Tor setting was not read as off (exit $RC)"
fi
run MORPHIT_INDEXER_I2P_HTTP_PROXY= bash "$PROBE" "http://$B32" --samples 3
if [ "$RC" -eq 2 ] && grep -q 'I2P is switched off' <<<"$OUT"; then
	ok 'L2b a blank MORPHIT_INDEXER_I2P_HTTP_PROXY is read as I2P switched off'
else
	no "L2b a blank I2P setting was not read as off (exit $RC)"
fi

# P6 — the probe says which machine to run it on, in its own output.
run MORPHIT_INDEXER_TOR_SOCKS="127.0.0.1:$PORT_socks503" bash "$PROBE" "http://$ONION" --samples 3
if grep -qi 'run on the SENDING box' <<<"$OUT"; then
	ok 'P6 the output names the machine it is meant to run on'
else
	no 'P6 the output does not say which machine it is for'
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fastchat-latency-probe-harness checks passed\033[0m\n' "$pass"; exit 0
fi
printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"; exit 1
