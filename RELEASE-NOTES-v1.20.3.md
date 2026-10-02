# Morphit v1.20.3

Visitors' browsers contact a Blurt node far less often, and pages download less. There are no
database changes.

## Privacy

- **The release check reaches a Blurt node at most once a day.** To make sure an operator is not
  keeping visitors on an old build, each browser asks a public Blurt node for Morphit's signed
  release record — the one request that leaves the site, and that node sees the visitor's IP. It
  ran on every visit. A good answer is now remembered in the browser for 24 hours (and asked again
  right after the site updates), so further visits that day contact no one.
- **That request is much smaller:** it reads @morphit's last 100 history entries instead of 10,000
  (a few KB instead of about 115 KB), and looks further back only if it must.
- **The FAQ says exactly what goes out** ("Does anything see or leak my IP address…"), in every
  language: at most once a day, two small requests.

## Faster pages

- **The served build's version file is downloaded once per page load**, not twice. The release
  check and the update check both need it, and it is about 80 KB.

## Release fixes

- **Zero-clearnet instances can always upgrade.** v1.20.2 was first broadcast without its IPFS name,
  and a Tor/I2P-only instance refused it. The release builder now always includes the name, warns
  when a release has no IPFS address, and refuses an IPFS record left over from an earlier release.
  A zero-clearnet upgrade also accepts a release located by its IPFS address alone.
- **The release build retries the IPFS tool download** (and has a second source), so a slow
  download no longer leaves a release without an IPFS address.
- **The ceremony's Block 4 clears values an earlier ceremony left in the terminal.**

## Upgrading

Run `sudo morphit-ops upgrade` on each server. Nothing needs doing by hand.
