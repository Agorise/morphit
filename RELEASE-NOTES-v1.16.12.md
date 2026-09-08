# Morphit v1.16.12

Two directory-accuracy fixes reported from live instances: a `verify.json`
`operator_tag` that stayed `null`, and an operator whose contact showed on the
instances page but not the operators page.

## Fixed

- **`verify.json` `operator_tag` no longer stays `null`.** The deploy stamps the
  served `verify.json` with this instance's tag, but it only read the local config
  — and on an instance whose tag was registered on-chain but never written to the
  local env, that read nothing and left `null`. It now falls back to the on-chain
  registration the local indexer already serves at `/v1/instances` (matched to this
  instance's own origin) — the same source that correctly shows the tag in the
  public directory — so a deployed `verify.json` shows the real tag.
- **Operators page shows a contact even when the on-chain operator record has
  none.** An operator's contact renders from its on-chain `operator_register`
  contact, which can be empty even when the operator's *instance* publishes one
  (e.g. `time.relay`: a contact on `/instances` but blank on `/operators`). The
  operators page now falls back to that instance contact (keyed by operator tag)
  when the on-chain operator contact is empty, using the same scheme-aware policy
  (email / Matrix / XMPP / … render; bare emails repaired).

## Notes

- No protocol/consensus change; both fixes are display/deploy only. `operator_tag`
  in `verify.json` remains informational (fee attribution comes from the runtime
  indexer config, unaffected).
