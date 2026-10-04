# Harness only: log every network attempt made by any Python process.
import json, os, sys
_LOG = "/var/log/bwh/audit.log"
_EV = {"socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "socket.bind"}
def _hook(ev, args):
    if ev not in _EV:
        return
    try:
        a = args[1] if ev in ("socket.connect", "socket.sendto", "socket.sendmsg", "socket.bind") and len(args) > 1 else args
        with open(_LOG, "a") as f:
            f.write(json.dumps({"pid": os.getpid(), "prog": " ".join(sys.argv[:1])[-80:], "ev": ev, "args": repr(a)[:300]}) + "\n")
    except Exception:
        pass
sys.addaudithook(_hook)
