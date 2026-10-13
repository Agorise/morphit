/**
 * What a real sshd prints for `sshd -T` (OpenSSH 9.6p1, Ubuntu 24.04), captured
 * 2026-10-12 for each config named. sshd's own `port` line is NOT where it listens
 * when a ListenAddress carries a port.
 */
export const SSHD_T = {
	/** ListenAddress 0.0.0.0:2222 — it listens on 2222 only, yet says "port 22". */
	listenWithPort: 'port 22\nlistenaddress 0.0.0.0:2222\n',
	/** Port 22, Port 2222. */
	twoPorts:
		'port 22\nport 2222\nlistenaddress [::]:22\nlistenaddress 0.0.0.0:22\nlistenaddress [::]:2222\nlistenaddress 0.0.0.0:2222\n',
	/** Port 2200, ListenAddress 0.0.0.0:2222, ListenAddress [::]. */
	mixed: 'port 2200\nlistenaddress 0.0.0.0:2222\nlistenaddress [::]:2200\n',
	/** Nothing set. */
	stock: 'port 22\nlistenaddress [::]:22\nlistenaddress 0.0.0.0:22\n',
	/** Port 2222, ListenAddress 10.1.2.3. */
	oneAddress: 'port 2222\nlistenaddress 10.1.2.3:2222\n',
	/** ListenAddress 0.0.0.0:2222 rdomain eth0 (a routing domain). */
	rdomain: 'port 22\nlistenaddress 0.0.0.0:2222 rdomain eth0\n',
	/** ListenAddress 127.0.0.1 — reached only through Tor (or a tunnel). */
	loopbackOnly: 'port 22\nlistenaddress 127.0.0.1:22\n'
};
