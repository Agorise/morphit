# The sink's DNS server for run.sh: logs every query (name, type) and answers
# NXDOMAIN, so nothing is resolved and every name asked for is on record.
import socket, struct, sys
LOG = sys.argv[1]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("10.201.0.1", 53))
while True:
    data, addr = s.recvfrom(4096)
    try:
        i = 12; labels = []
        while data[i]:
            n = data[i]; labels.append(data[i+1:i+1+n].decode(errors="replace")); i += n + 1
        qtype = struct.unpack(">H", data[i+1:i+3])[0]
        open(LOG, "a").write(f"{'.'.join(labels)} {qtype}\n")
        hdr = data[:2] + struct.pack(">H", 0x8183) + data[4:6] + b"\0\0\0\0\0\0"
        s.sendto(hdr + data[12:i+5], addr)
    except Exception as e:
        open(LOG, "a").write(f"? {e}\n")
