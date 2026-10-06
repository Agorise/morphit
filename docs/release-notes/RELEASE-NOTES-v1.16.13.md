# Morphit v1.16.13

Upgrade robustness on slow/throttled links, an honest update-check, and one more
self-heal moved onto the release that ships it.

## Fixed

- **Upgrades survive a slow connection.** The release download used a fixed 30 s
  total deadline and buffered the whole tarball in memory, so a healthy-but-slow
  link (a throttled or filtered connection) got its download aborted mid-transfer
  ("this operation was aborted"). It now **streams to disk with an idle timeout**:
  the transfer is only aborted if no bytes arrive for 90 s, so a slow-but-steady
  download completes. Only a genuine stall aborts.
- **A failed update-check no longer looks like "up to date."** When the version
  check couldn't reach the release server (e.g. a slow link timed out), the menu
  silently dropped the "update available" marker — indistinguishable from being
  current. It now shows `(couldn't check for updates — network)` so an outdated
  node is never mistaken for a current one.

## Changed

- **The frontend rebuild now runs in the post-upgrade self-heal phase**, from the
  freshly-installed binary (via the re-exec), alongside the WAF and IPFS heals.
  The frontend's nginx.conf is baked into its image, so a config change (e.g. the
  v1.16.12 `/v1/broadcast` body-size cap) previously only landed on the *next*
  upgrade; now it applies on the upgrade that ships it. A no-change rebuild is
  cheap (Docker layer cache), and a box without a compose-managed frontend no-ops.

## Notes

- No protocol/consensus change. All three are operational robustness only.
- A node upgrading *from* a pre-v1.16.11 release (no re-exec phase) picks up the
  self-heal behaviour on its next upgrade, once it is driven by a v1.16.11+
  orchestrator.
