# Morphit v1.15.2

**Installer robustness + quieter output. Every failure is now diagnosable in one shot instead of a wall of raw Ansible.**

## Added / Changed

**A failed install now tells you exactly what broke and how to fix it.** The whole Ansible run is captured to a log, and if it fails the wizard prints a plain-English summary — the failed step, what Ansible said, and a likely fix — instead of a generic "exit code N, check the messages above." Recognised failures (Postgres unreachable, apt lock held, Docker permission, missing sudo, disk full, old ansible-core, DNS/network, port in use) come with the specific remedy. An *unrecognised* failure points you at the full log and support (`agorise@pm.me` / `@agorise:matrix.org`) — so even a brand-new edge case is a captured, actionable artifact, not a dead end.

**Quieter, calmer install output.**
- npm's "New major version available!" and funding banners are suppressed during install/upgrade — we vendor a pinned npm, so those were noise you couldn't act on.
- The "stopping leftover process(es)" step during an upgrade is now a single calm line ("Superseding N stale worker process(es) from the previous version…"). It only prints the detail — PIDs and a manual-kill command — in the rare case it *can't* stop them, which is the only case worth your attention.

## Notes

- Builds on the v1.15.x installer hardening: the ansible-core ≥ 2.15 pre-check, the port/subnet/localhost pre-checks, and the automatic `localhost`→`127.0.0.1` database-host fix all remain.
- No database migration beyond v1.15.0's additive `orders.lang` (schema v56). Upgrade in place; everything from v1.15.1 is included.

## Robustness: the installer never dead-ends now

A full end-to-end audit of the install path closed every place a failure could still surface as a raw stack trace or a cryptic one-liner:

- **A global error backstop.** *Any* error anywhere in the wizard — a system call, a prompt, a file write, an apt/collections step, even a bug in our own code — is now turned into a plain-English message that names the likely cause, gives the fix, points to the run log, and (only when we don't recognise it) hands you support (`agorise@pm.me` / `@agorise:matrix.org`). Node system errors (permission, port-in-use, disk-full, missing command, DNS/network) are mapped to their fixes.
- **Process-level crash handlers** catch any async rejection that escapes the normal flow, so the worst case is still a clean sanitized line — never a V8 stack dump.
- **A non-interactive-terminal guard**: running the wizard through a pipe or a non-interactive SSH command now fails fast with "run it in a real terminal" instead of looping forever on empty input.
- **Censored/limited networks**: a blocked Ansible Galaxy fetch (a missing-collection failure) now maps to a clear "the release bundles these — just re-run" message.
- **Dependency hygiene**: patched a build-time `browserslist` advisory (dev/build only, never in the shipped bundle).

## More pre-flight checks (catch the environment, not just the code)

A second audit — this time of the *server's real-world state*, not the wizard's control flow — added up-front checks for the conditions that silently break a fresh install:

- **PostgreSQL version gate.** Morphit needs PostgreSQL **15+**, but Ubuntu 22.04's `apt install postgresql` is **14** — the same distro-too-old trap as the Ansible one. The wizard now flags it before the migrations run, with the PGDG-repo upgrade path.
- **DNS-points-here.** Right after you enter your domain, the wizard resolves it and checks it points at *this* server — the single most common reason a self-hosted HTTPS install fails (the cert can't be issued if DNS isn't pointed/propagated). It distinguishes not-resolving-yet, behind-NAT (with port-forward guidance), and a plain mismatch, and reminds you that a cloud firewall must also allow inbound 80 + 443. Non-blocking — you can point DNS while the install runs.
- **Locale.** Warns on a non-UTF-8 locale (`LANG=C`/POSIX on minimal images), which would otherwise make Postgres default a new database to SQL_ASCII and garble multilingual + RTL content.

## Hand-holding: a grandma can hit Enter all the way through

A usability pass so the install is smooth for any experience level, on any topology (Tor-only or clearnet, home box or VPS):

- **Press Enter = the recommended answer, everywhere.** An up-front tip says so, every yes/no question has a safe default, and the offered auto-fixes (add swap, install Docker, add the localhost hosts entry) now default to *yes* and say "recommended — just press Enter", so an operator who doesn't understand a question can keep pressing Enter and end up with a working node. The only things they must type are their own domain, account names, and key.
- **The braille spinner now runs during every silent step** — the system checks, the on-chain account lookup, and the DNS check — so a slow network moment never looks frozen. (It degrades to a one-line label when there's no terminal to animate.)
- **Tor-only nodes skip the domain + DNS + certificate questions entirely**; home boxes behind NAT get port-forwarding guidance from the DNS check; VPS boxes get the public-IP comparison. Each topology only sees the questions that apply to it.
- **A no-output watchdog on the long install run.** The setup step streams Ansible's progress live, and if the run goes quiet for a few minutes (a big download, a first database migration, or issuing the HTTPS certificate) it prints a calm reassurance with the recommendation — just wait, it will continue, and a re-run is always safe. A slow step never looks like a dead hang, and the operator never has to make a decision to keep going.

