# Morphit v1.9.8

## More accurate BLURT prices

The estimated US-dollar value shown next to BLURT amounts — on listing fees and elsewhere — now comes first from Blurt's own price feed, the most authoritative source for what BLURT is worth. The independent market aggregators Morphit already consulted stay in place as a safety net if Blurt's feed is ever unreachable, so the estimate is always available. This only affects the on-screen dollar estimate; every fee and trade is still settled in the actual asset, exactly as before.

## For operators

Most of this release makes it far easier to run your own Morphit node.

### A guided, near-one-command setup

Setting up a node from a fresh machine is now a mostly copy-and-paste procedure. After you download and extract the release, a single command walks you through the whole install — it checks and installs what's needed, asks a short series of plain-language questions (each with an example), generates your secrets and helps you save them somewhere safe, then runs the full hardened install for you. A home mini-PC (like a Beelink) gets the same complete, hardened stack as a cloud server; the only difference is the extra networking a home connection needs.

### Optional Matrix setup help

If you want operational alerts in Matrix, the setup can now sign you in and wire up the notifications for you — including a heads-up when a new Morphit release is available. Matrix remains entirely optional; skip it and nothing changes.

### Recovers on its own

A node now recovers cleanly after a reboot or a changing home IP address, with no manual intervention.

### A shorter setup guide

The "Run a Morphit node" guide has been trimmed to a focused, roughly 15-minute read covering the guided path. The advanced material — running the Ansible playbook yourself, or building from source — now lives in the operations manual for those who want it.

The on-chain release format is unchanged and fully backward-compatible.
