# Morphit Ansible playbook — operator deployment automation

Automates the steps in `docs/OPERATIONS.md` §31, §32, §34, §35, §37,
and §38 (squatter defense) on a fresh Ubuntu 24.04 LTS host.

## What this deploys

- **Base hardening** per OPERATIONS.md §37 (all 18 subsections) +
  §34 (UFW + fail2ban).
- **TLS** via certbot with auto-renew per §35.
- **PostgreSQL** bound to loopback only, with morphit_indexer +
  morphit_relay databases provisioned per §37.8.
- **Morphit indexer + relay + backup + mint-acts** as systemd
  units (canonical bare-metal deployment, NOT Docker — see
  "Why not Docker for morphit services?" below).
- **BunkerWeb** as a Docker container, terminating TLS in front
  of the indexer and relay per §32.  Trusted-proxy IPs wired
  correctly so the relay's rate limits work.
- **Daily encrypted Postgres backups** per §31, with off-host
  destination configurable.
- **Diamond-hardened squatter defense** preset per §38.7 applied
  to `/etc/morphit/relay.env` automatically.

### Optional sidecars (all opt-in via `enable_*: true` in group_vars)

- **`matrix_bot`** (cp9) — operator alerts to Matrix DM with
  tiered classification (CRITICAL / WARN / INFO).  Requires a
  bot Matrix account access token in vault.  Off by default.
- **`host_monitor`** (cp10) — periodic disk / memory / swap /
  CPU / swap-thrashing monitor.  Off by default.
- **`smartctl_monitor`** (cp11) — disk SMART health checks
  every 6h.  Installs `smartmontools`.  Off by default.
- **`fail2ban_monitor`** (cp11) — observability for fail2ban
  jails: alerts on daemon-down + ban-count spikes.  Off by
  default.
- **`mdadm_monitor`** (cp11) — Linux software RAID array health.
  Safe to enable defensively — exits silently on hosts without
  RAID.  Off by default.
- **`dmesg_monitor`** (cp12) — kernel ring buffer scan every
  5 min for OOM-killer activations, kernel oopses, hardware
  errors, and segfaults.  Off by default.
- **`trivy_monitor`** (cp12) — daily Docker image CVE rescan
  for CRITICAL + HIGH vulnerabilities.  Installs trivy from
  the Aqua Security apt repo.  Off by default.  Most useful
  with the BunkerWeb deploy path.
- **`postfix_monitor`** (cp12) — mail queue depth +
  oldest-message age.  Catches silent operator-alerting
  failures (smarthost credentials rotated, TLS bumped).  Off
  by default.
- **`certbot_monitor`** (cp13) — TLS cert expiry + renewal-
  stall detection (cert expiring AND no successful renewal in
  N days).  Catches the "renewal silently broke months ago"
  pattern that most monitoring misses.  Off by default.
- **`apt_monitor`** (cp13) — daily pending security-update
  count.  Surfaces what the motd line shows but operators
  stop reading.  Debian/Ubuntu only.  Off by default.
- **`compose_monitor`** (cp13) — Docker Compose service
  health + restart-loop detection.  Most useful with the
  BunkerWeb deploy path.  Useless on bare-metal-only.  Off
  by default.
- **`systemd_monitor`** (cp14) — systemd unit health.
  Watches morphit-* units for "failed" state + high restart
  counts.  Critical complement to journalctl-based alerting:
  a unit that fails to even start emits no journal output.
  Off by default.
- **`journald_monitor`** (cp14) — journal disk usage +
  rotation health.  Catches the "journal silently grew for
  6 months until disk full" pattern.  Daily check.  Off by
  default.

All sidecars emit structured JSON to journalctl that the
`matrix_bot` picks up automatically via
`MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`.  Adding a new sidecar
later requires no `matrix_bot` reconfiguration — just enable
the new role.

## What this does NOT do

- **Run on a host you're already using.**  This is for a fresh
  Ubuntu 24.04 VPS.  Running on a host with existing services
  will probably break those services (UFW rules, kernel sysctl,
  Postgres listen_addresses).
- **Provision the VPS itself.**  You bring an SSH-reachable host
  with a sudo-capable user; the playbook handles everything from
  there.
- **Generate or deploy the operator's BLURT keys.**  The relay
  needs a Blurt active key and a Blurt posting key for the
  operator account.  See `RUN-A-MORPHIT-NODE.md` for the
  key-generation procedure; place the resulting keystore at the
  path named in `group_vars/all.yml` before running the playbook.
- **Run the operator's owner-key rotation, witness-fee responses,
  or any other ongoing operations.**  Those are §4 / §8 etc. in
  OPERATIONS.md and live with the operator, not the sysadmin.
- **Replace OPERATIONS.md.**  Read it.  This playbook implements
  it but doesn't substitute for understanding it.

## Why not Docker for morphit services?

OPERATIONS.md §33 documents Docker as an *optional* alternative.
The canonical path is bare-metal systemd, for three reasons:

1. The `*_FILE` env-var-from-secret pattern shown in §33's
   docker-compose example (e.g. `MORPHIT_RELAY_DB_PASSWORD_FILE`)
   is **not yet implemented** in the relay/indexer config
   loaders (audit caveat 2026-05-06).  Today, those vars are
   ignored and credentials must be inlined in DATABASE_URL.
   Docker secrets don't help you until that pattern lands.
2. The repo deliberately ships no `docker-compose.yml`.  The
   four `ops/systemd/*.service` units are the authoritative
   deployment artifacts.
3. Operators new to Morphit have a simpler debugging story
   when the relay is a normal systemd service: `journalctl -u
   morphit-relay -f` and you're done.

**BunkerWeb is Docker** because that's BunkerWeb's natural
deployment pattern.  This playbook reflects that split:
morphit services bare-metal, BunkerWeb containerized.

## Honesty caveats from the author

I (Claude, who wrote this with Ken supervising) wrote this without
being able to test it end-to-end.  Specific places where the
sysadmin should expect to debug rather than copy-paste:

- **BunkerWeb version drift.**  BunkerWeb's env-var names and
  Docker tag layout change between major versions.  The
  `bunkerweb` role pins to a specific tag in
  `group_vars/all.yml`; verify against the BunkerWeb docs at
  release time.
- **Ubuntu 24.04 specifics.**  Tested-shape on this distro;
  may need apt-package-name adjustments on derivatives.
- **PostgreSQL major version.**  The repo's existing
  `ops/postgres/init.sql` targets PG 17 (per §33 reference).
  The playbook installs `postgresql` (whatever's in the
  Ubuntu repo).  If your sysadmin needs PG 17 specifically,
  add the PGDG apt repository in `roles/postgres/tasks/`.
- **Morphit build artifacts.**  The playbook clones the repo
  and runs `npm install + npm run build`.  Production
  deployments may prefer pre-built tarballs from CI.  The
  `morphit` role's `clone_and_build.yml` is the integration
  point.
- **Operator-editable values.**  Everything in
  `group_vars/all.yml` is a placeholder.  Operator MUST review
  every value before first run.  The diamond-hardened squatter
  preset values are fine as shipped (per §38.7) but the operator
  account names, DB passwords, domain names, email addresses,
  etc. are all dummies.

## Quick start

```bash
# 1. Edit your inventory
cp inventory/hosts.yml.example inventory/hosts.yml
$EDITOR inventory/hosts.yml          # set ansible_host, ansible_user

# 2. Edit operator-tunable values
$EDITOR group_vars/all.yml           # see DUMMY-VALUES throughout

# 3. Generate vault for secrets
ansible-vault create group_vars/vault.yml
# Put real DB passwords + relay keystore passphrase + alert email
# password here.  Reference them in group_vars/all.yml as
# {{ vault_db_password }} etc.

# 4. Dry run
ansible-playbook -i inventory/hosts.yml playbook.yml --check

# 5. Real run (one role at a time recommended)
ansible-playbook -i inventory/hosts.yml playbook.yml --tags base
ansible-playbook -i inventory/hosts.yml playbook.yml --tags hardening
ansible-playbook -i inventory/hosts.yml playbook.yml --tags tls
ansible-playbook -i inventory/hosts.yml playbook.yml --tags postgres
ansible-playbook -i inventory/hosts.yml playbook.yml --tags morphit
ansible-playbook -i inventory/hosts.yml playbook.yml --tags bunkerweb

# 6. Verify per the checklist in the sysadmin handoff doc
```

## Pre-flight checklist

Before first run:

- [ ] Target host is fresh Ubuntu 24.04 LTS
- [ ] Sudo-capable non-root user exists with your SSH key in
      authorized_keys
- [ ] DNS A record for `morphit_domain` points to the host
- [ ] Port 80 reachable for ACME HTTP-01 challenge (port 443 too
      after TLS is provisioned)
- [ ] You can ssh to the host BEFORE running this playbook (the
      hardening role will lock SSH down to key-only — make sure
      keys work first)
- [ ] You have offsite backup storage configured (the `morphit`
      role's backup task expects an rsync/scp target; configure
      `backup_remote_destination` in `group_vars/all.yml`)
- [ ] Operator account keystore file is ready at the path named
      in `group_vars/all.yml`

## Layout

```
morphit-ansible/
├── playbook.yml                # entry point — calls every role
├── README.md                   # this file
├── inventory/
│   └── hosts.yml.example       # template; operator copies + edits
├── group_vars/
│   ├── all.yml                 # all tunables, dummy values
│   └── vault.yml               # encrypted secrets (operator creates)
└── roles/
    ├── base/                   # users, base packages, NTP, hostname
    ├── hardening/              # §37 (all 18) + §34 (UFW + fail2ban)
    ├── tls/                    # §35 — certbot + renew timer
    ├── postgres/               # §30, §37.8 — install, harden,
    │                           #   provision DBs + users
    ├── morphit/                # §18, §23, §31, §38.7 — clone repo,
    │                           #   build, env files w/ diamond-
    │                           #   hardened preset, systemd units,
    │                           #   backup timer, alerts
    └── bunkerweb/              # §32 — Docker engine, BunkerWeb
                                #   container, WAF rules, trusted-
                                #   proxy IPs, OWASP CRS, anti-
                                #   referer-none rule on invite
```

## Idempotency

Every role is written to be idempotent — re-running the playbook
on a configured host should produce zero changes if nothing's
drifted.  This means you can:

- Re-run after a config tweak in `group_vars/all.yml` to apply
  it (verify with `--check` first).
- Re-run periodically as a configuration-drift check.
- Re-run after Ubuntu major-version upgrade to re-apply
  hardening that the upgrade may have undone.

## What to verify after running

See the verification checklist in `morphit-sysadmin-handoff.txt`
(the sysadmin brief).  Ansible reporting "0 failed" means the
plays ran; it does NOT mean the deployment is secure or that
Morphit is actually working.  Verify both.
