# Morphit v1.4.12

## Message notifications now arrive in seconds, not a minute

Last release made messages appear right away *inside* an open conversation. This one does the same for the **notification** — the pop-up, the little unread dots, and the badge on the app icon.

Before, if someone messaged you while you were on another tab or had Morphit closed, the alert could take up to a minute to reach you. Now it arrives within a few seconds of the message being sent. If you keep Morphit open in a background tab, its browser-tab icon and your avatar's unread dot light up promptly too — you no longer have to click back to the tab to find out something happened. And if you've installed Morphit as an app, the count on its dock or taskbar icon updates just as quickly.

## Still quiet when it should be

None of this changes who's allowed to reach you. A stranger still can't ping you out of the blue — a first message from someone you've never spoken to (and who hasn't posted an order you're replying to) still goes through the same gentle gate as before. The fast alerts are for the conversations you're actually part of: people you've talked to, and genuine replies about your own listings. And as always, if you've blocked someone, you hear nothing from them.

## For operators

- This is delivered entirely by the standard upgrade — there's nothing to configure and no settings to edit. Running the upgrade applies a small database change automatically and turns the faster notifications on.
- **The chat tracer is still here, still switched fully off.** If you're ever diagnosing a message-delivery question, you can turn on a detailed, privacy-safe console trace by adding `?chatdebug=1` to a chat URL (or `localStorage.setItem('morphit.debug.chat','1')`). It logs message *metadata only* — never contents — and does nothing unless you switch it on.

As always, Morphit's notifications carry no message content — only a nudge that something happened — and none of this changes what Morphit keeps about you: nothing.
