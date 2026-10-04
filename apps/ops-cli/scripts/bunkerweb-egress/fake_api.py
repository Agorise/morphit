# Harness only: a BunkerWeb instance API on 127.0.0.1:5000 that accepts every push.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n: self.rfile.read(n)
        open(LOG, "a").write(f"{self.command} {self.path}\n")
        b = json.dumps({"status": "success", "msg": "ok", "data": {}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    do_GET = do_POST = do_PUT = do_DELETE = reply
ThreadingHTTPServer(("127.0.0.1", 5000), H).serve_forever()
