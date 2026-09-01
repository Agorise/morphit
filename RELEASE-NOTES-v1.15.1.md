# Morphit v1.15.1

**A fix release on top of v1.15.0: the release build is fixed, and the installer now catches an old-Ansible trap that was silently failing fresh installs. Includes all of v1.15.0 (the orderbook language feature + the v1.14.3 rollup).**

## Fixed

**The release build no longer fails.** v1.15.0's web bundle pulled the server-only `@morphit/operator-config` module (with its `node:fs`/`node:path`/`node:util` imports) into the browser build, which broke `vite build`. The web now derives its order-language codes from its own `SUPPORTED_LOCALES` (a smoke keeps them in lockstep with the indexer's list), so nothing Node-only reaches the browser bundle.

**Old Ansible no longer fails a fresh install with a misleading error.** Ubuntu 22.04's `apt install ansible` installs the EOL **2.10**, which can't load the modern collections the playbook needs — and the old installer misreported that as *"the installer found no machine to configure (0 hosts)."* Two changes address it:

- The setup wizard's system check now verifies **ansible-core ≥ 2.15** up front. If it's too old (or the legacy pre-core 2.10), it fails the check with a clear explanation and offers a one-keystroke upgrade (via pipx), instead of letting the playbook fail cryptically later.
- Combined with v1.15.0's honest pre-flight (which already replaced the phantom "0 hosts" with the real Ansible error), an operator on old Ansible now gets told exactly what to do before anything runs.

The bundled `morphit-node-doctor.sh` diagnostic was likewise updated to flag Ansible below the floor instead of marking it OK.

## Notes

- Upgrade in place; everything from v1.15.0 is included. No database migration beyond v1.15.0's additive `orders.lang` (schema v56).
- New operators on Ubuntu 22.04 should either install this version's wizard-guided setup (which will prompt to upgrade Ansible) or upgrade Ansible to core ≥ 2.15 first.
