#!/bin/bash
# Second half of run.sh: runs inside the scheduler's network namespace, in a
# private mount namespace, so every mount below disappears with it.
#   inner.sh <work-dir> <env-file> <max-seconds> [host:container ...]
set -u
W=$1
ENVF=$2
SECS=$3
shift 3
H=$(dirname "$(readlink -f "$0")")
mount --make-rprivate /
# The scheduler image's directories, empty (the image's own content is copied in).
for d in /etc/bunkerweb /var/tmp/bunkerweb /var/run/bunkerweb /var/log/bunkerweb /var/cache/bunkerweb /var/lib/bunkerweb /data /var/www /etc/nginx /var/log/bwh /usr/share/bunkerweb /etc/letsencrypt; do
	mkdir -p "$W/fs$d"
	mount --bind "$W/fs$d" "$d"
done
cp -a "$W/usb/." /usr/share/bunkerweb/
cp "$W/mmdb/"*.mmdb /var/tmp/bunkerweb/
mkdir -p /etc/bunkerweb/configs /etc/bunkerweb/plugins /etc/bunkerweb/pro/plugins
# Compose-style file mounts (a missing target is created first, as Docker does).
for b in "$@"; do
	t="${b#*:}"
	[ -e "$t" ] || {
		mkdir -p "$(dirname "$t")"
		touch "$t"
	}
	mount --bind "${b%%:*}" "$t"
done
# "bunkerweb" (the instance's container name) is the fake API on loopback; any
# other name goes to the sink's resolver.
printf '127.0.0.1 localhost bunkerweb\n' >"$W/hosts"
mount --bind "$W/hosts" /etc/hosts
printf 'nameserver 10.200.0.1\n' >"$W/resolv"
mount --bind "$W/resolv" /etc/resolv.conf
cp "$H/sitecustomize.py" "$W/sc.py"
mount --bind "$W/sc.py" /etc/python3.12/sitecustomize.py
# The scheduler and its jobs call `python3`; the image's is 3.12.
mount --bind /usr/bin/python3.12 /usr/bin/python3
: >/var/log/bwh/audit.log
chmod 666 /var/log/bwh/audit.log
ip link set lo up
python3 "$H/fake_docker.py" "$W/docker.sock" "$ENVF" &
FD=$!
python3 "$H/fake_api.py" /var/log/bwh/api.log &
FA=$!
sleep 1
# The scheduler container's environment is the same env file (Compose env_file).
mapfile -t ENVV < <(grep -vE '^\s*(#|$)' "$ENVF" | grep '=')
cd /usr/share/bunkerweb/scheduler || exit 1
env -i PATH=/usr/share/bunkerweb/deps/python/bin:/usr/bin:/bin HOME=/tmp LOG_LEVEL=info \
	DOCKER_HOST="unix://$W/docker.sock" DATABASE_URI=sqlite:////var/lib/bunkerweb/db.sqlite3 \
	"${ENVV[@]}" python3 ./main.py >/var/log/bwh/scheduler.log 2>&1 &
SP=$!
# Done when every job has run once AND the generated config was pushed.
T=0
while [ $T -lt "$SECS" ] && kill -0 $SP 2>/dev/null; do
	if grep -q 'jobs in run_once()' /var/log/bwh/scheduler.log && grep -q 'Executing job scheduler' /var/log/bwh/scheduler.log; then
		break
	fi
	sleep 2
	T=$((T + 2))
done
sleep 3
kill $SP $FD $FA 2>/dev/null
sleep 1
pkill -P $SP 2>/dev/null
kill -9 $SP 2>/dev/null
cp -a /var/log/bwh/. "$W/out/"
cp -a /etc/nginx "$W/out/nginx" 2>/dev/null
cp -a /etc/bunkerweb/configs "$W/out/configs" 2>/dev/null
ls /var/cache/bunkerweb/jobs >"$W/out/jobs-cache.txt" 2>/dev/null
exit 0
