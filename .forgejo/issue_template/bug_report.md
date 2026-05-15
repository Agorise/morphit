---
name: "Bug report"
about: "Report a bug, error, or unexpected behavior you found in Morphit"
title: "[bug] "
labels:
  - "needs-triage"
ref: "main"
---

Thanks for taking the time to report this. The more of these fields you can fill in, the faster we can fix it. If you don't know a field, just write *don't know* or leave it blank — partial reports are still useful.

Copy this whole file, paste it into a new issue at <https://git.agorise.net/agorise/morphit/issues>, or send it directly to the operator who invited you.

---

## 1. One-line summary

*One sentence. What went wrong, in your own words.*

>

---

## 2. What were you trying to do?

*The goal — not the steps. e.g. "Post a sell order for 0.01 BTC", "Send a chat message to my counterparty", "Sign in with my keyfile".*

>

---

## 3. What happened instead?

*What you actually saw. Be specific. "It broke" is harder to fix than "I clicked Submit, the page froze for ~5 seconds, then a red banner appeared at the top saying 'rate_limited'."*

>

---

## 4. Steps to reproduce

*Number every click, type, and wait. Pretend you're writing instructions for someone who has never used Morphit. Include the **exact URL** of every page you were on.*

1.
2.
3.
4.
5.

**Does it happen every time you do these steps, or just sometimes?**

>

---

## 5. Error code / error message (if any)

*Copy the **exact** text — including punctuation. If the error appeared in a red banner, modal, or toast, that text. If the page just showed a code like `rate_limited` or `invite_invalid`, that code. If the page showed nothing but you suspect an error, say so.*

**Error code shown to user:**

>

**Full error text:**

>

---

## 6. Screenshot / screen recording

*Attach a screenshot if you have one. A short screen recording (<30 seconds) is even better for visual glitches or interaction bugs. **Crop out anything sensitive — keys, balances, recovery phrases — before sharing.***

- [ ] Screenshot attached
- [ ] Screen recording attached
- [ ] Nothing attached

**Filename(s):**

>

---

## 7. When did it happen?

*Approximate date and time, **including your timezone** — this helps the operator find your request in the logs. Even "around 2pm my time on Tuesday" is useful.*

| Field | Value |
|---|---|
| Date |  |
| Time |  |
| Timezone |  |

---

## 8. Environment

**Browser** *(e.g. Firefox 150, Chrome 148, Safari 18, Brave):*

>

**Operating system** *(e.g. Windows 11, macOS 15.2, Ubuntu 24.04, iOS 18, Android 15):*

>

**Device type:**

- [ ] Desktop
- [ ] Laptop
- [ ] Phone
- [ ] Tablet

**Connection (best guess):**

- [ ] Regular home/office internet
- [ ] Mobile data
- [ ] VPN
- [ ] Tor
- [ ] I2P
- [ ] Lokinet
- [ ] Other / don't know

**Are you using a VPN, ad blocker, or browser privacy extension** (uBlock Origin, Brave Shields, Privacy Badger, etc.)? These can sometimes break things that work on a stock browser.

>

---

## 9. Which Morphit instance were you using?

*The full URL — e.g. `https://morphit.io` or whatever operator URL you were using. **This matters because different operators run different software versions.***

**Instance URL:**

>

---

## 10. Account context

*All of these are optional. Only share what you're comfortable sharing — **never share private keys, recovery phrases, or passwords**. Public account names are fine.*

**Your Blurt account name** *(public name only — no keys!):*

>

**How long have you had this account?**

- [ ] Just created it for the beta
- [ ] Less than a week
- [ ] Less than a month
- [ ] Months or years

**How did you sign in?**

- [ ] Keyfile (downloaded `.json` file)
- [ ] Master password
- [ ] Hardware key (YubiKey / similar)
- [ ] QR pairing from another device
- [ ] Other:

**If the issue involves a specific order, trade, message, or fee, what's the URL of that thing?** *(e.g. order permlink page)*

>

---

## 11. Browser console output *(advanced — optional)*

*If you know how to open the browser developer console — usually `F12` or `Ctrl+Shift+I` — paste anything red or yellow that appeared in the **Console** tab around the time of the error. Skip this if you're not sure.*

```
(paste here)
```

---

## 12. Network tab *(advanced — optional)*

*In the developer tools **Network** tab, find the request that failed — usually highlighted red. Note its URL, status code, and response body. If you're unsure, skip this.*

**Request URL:**

>

**HTTP status code** *(e.g. 403, 429, 500):*

>

**Response body:**

```json
(paste here)
```

---

## 13. What you expected to happen

*Sometimes what looks like a bug is intentional, and what looks intentional is a bug. Tell us what you thought would happen — if your expectation was wrong, the docs need fixing too.*

>

---

## 14. Workaround found?

*Did you find a way around the issue — refreshing, retrying, logging out and in, switching browsers? This helps us understand the failure mode.*

>

---

## 15. Severity *(your honest opinion)*

- [ ] **Blocker** — I literally cannot use Morphit at all
- [ ] **Major** — A core feature doesn't work; I have to give up on it
- [ ] **Minor** — Annoying but I can work around it
- [ ] **Cosmetic** — Visual glitch, typo, alignment issue
- [ ] **Question** — Not sure if this is a bug or expected behavior

---

## 16. Security-sensitive?

> ⚠ **If this issue could let someone steal funds, leak private info, bypass a fee, or harm other users, DO NOT post it as a public issue.** Send it privately via encrypted Matrix DM:
>
> **`@agorise:matrix.org`**

**Examples of security-sensitive issues:**

- You found a way to post an order without paying the fee
- You can see another user's chat messages
- The relay let you create an account without a valid invite
- Anything that involves keys, passwords, or balances

**Is this security-sensitive?**

- [ ] **Yes** — I will send it via Matrix DM instead, NOT here
- [ ] **No** — Safe to post publicly
- [ ] **Not sure** — I'll send via Matrix DM to be safe

---

## 17. Anything else?

*Free-form. Anything you noticed that didn't fit above — a weird side effect, something that worked five minutes earlier, a hunch about what might be wrong.*

>

---

*Thank you! The more reports we get during the beta, the more solid Morphit will be at launch. Even small things matter.*

*— The Morphit team*
