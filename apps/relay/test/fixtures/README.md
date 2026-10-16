Test-only TLS certificates (self-signed, `localhost` / `127.0.0.1`, 20 years)
for the offline-notice tests: a fake mail server, a fake Session seed and node.
`other-localhost.crt` is a second, unrelated certificate (its key was thrown away), used to show that a
pinned certificate refuses any other. Never used outside the tests.
