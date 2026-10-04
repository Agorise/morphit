# Harness only: the slice of the Docker Engine API BunkerWeb 1.5.10's scheduler
# uses to find its instance (one container, label bunkerweb.INSTANCE, the env).
import json, os, socketserver, sys, time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse
SOCK, ENV = sys.argv[1], sys.argv[2]
env = [l.rstrip("\n") for l in open(ENV) if l.strip() and not l.lstrip().startswith("#") and "=" in l]
CTR = {"Id": "bwid0", "Names": ["/bunkerweb"], "Labels": {"bunkerweb.INSTANCE": "yes"}, "State": "running", "Image": "bunkerity/bunkerweb:1.5.10"}
INSPECT = {"Id": "bwid0", "Name": "/bunkerweb", "Config": {"Env": env, "Labels": CTR["Labels"], "Image": CTR["Image"]}, "State": {"Running": True, "Status": "running"}, "NetworkSettings": {"Networks": {}}}
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = urlparse(self.path).path
        p = "/" + p.split("/", 2)[2] if p.startswith("/v1.") else p
        if p == "/version": return self.send({"ApiVersion": "1.45", "MinAPIVersion": "1.24", "Version": "26.1.0"})
        if p == "/_ping":
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"OK"); return
        if p == "/containers/json": return self.send([CTR])
        if p == "/containers/bwid0/json": return self.send(INSPECT)
        if p == "/events":
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
            while True: time.sleep(3600)
        self.send({"message": "not in harness"}, 404)
    do_HEAD = do_GET
class S(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def get_request(self):
        r, _ = super().get_request(); return r, ("local", 0)
if os.path.exists(SOCK): os.unlink(SOCK)
S(SOCK, H).serve_forever()
