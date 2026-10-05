# Security and privacy review, October 2026 (v1.21.0)

This is a summary of the review behind v1.21.0. The current threat model is in
[`docs/audit/2026-10-stride-matrix.md`](audit/2026-10-stride-matrix.md),
[`docs/audit/2026-10-attack-tree.md`](audit/2026-10-attack-tree.md) and
[`docs/audit/2026-10-red-team-narrative.md`](audit/2026-10-red-team-narrative.md).
To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Scope

The whole repository: the indexer, relay, web app, `morphit-ops`, the MCP server, the Matrix alert bot,
the shared packages, the server configuration (Ansible, nginx, BunkerWeb, systemd, Tor, i2pd, Kubo), the
release pipeline, and every operator and user document, in all ten languages.

## Method

- **Independent reviewers, one area each,** none of whom wrote the code: web security, browser privacy,
  indexer, chain-op handlers, database, relay and network layer, `morphit-ops` and the release chain, server
  infrastructure, marketplace, cryptography, supply chain, documentation, repository hygiene, and a
  "hostile reader" of the public repository.
- **A fresh threat model** (STRIDE per element and per trust boundary, and an attack tree for six attacker
  goals: unmask a user, unmask an operator, steal funds, backdoor an instance, forge trust, take the
  federation down).
- **A red team against a running local instance** (real indexer, real nginx configuration, Chromium):
  endpoint fuzzing, request smuggling, cache and header abuse, cross-origin attacks, fingerprinting, and
  hidden-service identity leaks.
- **The project's standing 94-task checklist** (hostile review of every chain operation, HTTP surface,
  crypto and secrets, database, frontend, code quality, regular expressions, tests, documentation, wiring,
  fallbacks) and a mutation campaign against the security tests themselves.
- **Every finding was reproduced by running code** before it counted. Every code fix has a test that was
  run against the unfixed code and seen failing.
- **Four rounds of verification:** after each round of fixes, reviewers who had not seen the fixes tried
  to break them, including the upgrade path from the previous release on each kind of server.

## Results

238 distinct issues: 4 critical, 28 high, 115 medium, 82 low, 9 informational. All are fixed in v1.21.0
except where listed under "Known limits". The most serious:

- one cheap on-chain operation could stop every indexer (two different ways);
- the bundled BunkerWeb configuration sent visitor data to third parties;
- a single RPC node could forge the browser's release record or feed the indexer unsigned official
  operations;
- chat messages did not authenticate their sender, and the peer-verification code was too short;
- an upgrade could be served an unsigned release, and a zero-clearnet upgrade used the clearnet;
- the service account could gain root; TLS certificates did not renew on BunkerWeb servers;
- several public claims about privacy and security were not true; they were corrected or removed.

The release notes ([RELEASE-NOTES-v1.21.0.md](../RELEASE-NOTES-v1.21.0.md)) describe the fixes.

## Known limits

- **Block content is cross-checked, not proven.** Every applied block's Merkle root, id and link are
  recomputed and counted, but a mismatch is reported, not acted on, until the live federation has shown it
  never fires falsely.
- **RPC operators are counted by node name.** A name does not prove that two nodes have different owners;
  the default hidden-service nodes are run by the project.
- **Two cooperating RPC operators can delay** trusted reads (they can no longer make a false value win).
- **One RPC node can delay the "newer version" notice** in a browser by up to a day by withholding the
  newest release record; it cannot forge one.
- **The page checks itself.** The in-page integrity check is served by the operator it checks, so it
  catches accidental tampering, not a hostile operator. The download verifier (`scripts/verify-download.mjs`)
  is the independent check.
- **Chat messages sent before v1.21.0** are shown as unverified.
- **A release is GPG-signed only when the release job holds the signing key.** Without it, nodes install the
  release by the SHA-256 in @morphit's signed on-chain record, and that hash is the one the release job computed:
  the job's runner is trusted to build what the signed tag names.

## Reproducing

Every guard named in the threat model is in the repository and runs in CI:
`bash scripts/run-smokes.sh` and the `vitest` suites of each workspace.
