# Morphit v1.17.15

Makes adding a privacy-network address safe to do without guessing. No protocol
or consensus change.

## Fixed

- **You can now see which addresses a registration will publish, before you sign
  it.** Publishing your instance to the federation is permanent, and peers reach
  you at whatever those addresses say — but the confirmation screen showed only
  your origin, name, contact and tag. It never showed the addresses themselves.
  That is exactly how one instance came to announce a privacy address its own
  router had stopped hosting: every peer's attempt to reach it that way failed,
  and the one moment someone could have noticed showed nothing. All of them are
  now listed for you to check first.
- **Your instance reads its own privacy address from the right setting.** It
  previously took the first address-shaped value found anywhere in the
  configuration file. On an instance that also lists other nodes' privacy
  addresses — which most do — that could pick up someone else's and then report
  your correct configuration as wrong, indefinitely. It now reads the setting
  that holds your address.

- **Importing a privacy-network key now checks that it is the right key.** It was
  accepted on sight. Morphit now works out which address the key actually
  belongs to and shows it, so you can confirm it matches the address you
  publish — and warns you plainly if it does not. A key file exported as text
  (base64) is now accepted as-is rather than refused.
- **And it tells you if you have the address rather than the key.** The long
  string you publish as your address looks a lot like a key file and is easy to
  grab by mistake. It cannot be used to host anything: your server could not
  prove the address is its own, so the site would simply never load there, with
  no error to explain why. Morphit now recognises it, explains the difference,
  refuses the import, and tells you what the real key file looks like.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- Adding a vanity name (`something.i2p`) alongside your long address is safe: the
  long one stays the address of record, since a vanity name only resolves for
  users whose router knows the registry it is listed in.
