# Payments Consolidation — Design

**Date:** 2026-07-28
**Status:** Implemented 2026-07-28 — code complete, device test outstanding.
Plan: `docs/superpowers/plans/2026-07-28-payments-consolidation.md`
**Replaces:** `app/payments.tsx`, `app/legacy-payments.tsx`, `app/local-payments.tsx` as three separate destinations
**Reference:** `~/Downloads/Payment_UX_Language_Conventions.md` (internal UX language guide)

## The problem

The wallet menu offers three payment destinations named after **transports**:

| Row | Route | What it really is |
|---|---|---|
| Payments | `/payments` | remote, async, addressed by identity key, delivered via MessageBox |
| Legacy Bridge | `/legacy-payments` | conventional wallets, addressed by standard address, discovered by polling |
| Local Payments | `/local-payments` | in-person, device-to-device over AWDL or QR |

Plus a fourth row, **Identity Key**, which is a QR modal — an addressing detail promoted to a destination.

This makes the user route themselves. To pay a person they must already know that "identity keys" versus "standard addresses" versus "standing next to each other" maps onto their situation. The UX guide argues the opposite: *match language to the interaction model*, and *prefer established high-adoption terms* (recommendations 2 and 3). Nobody's mental model is "which transport".

## The structure

Two axes. The primary one is **direction**, because that is the first thing a user knows about their own situation. The secondary one is **who the counterparty is**, which is what actually determines the rail.

|  | **Pay** | **Get paid** |
|---|---|---|
| **Someone nearby** | scan their code | show your payment code |
| **Someone with this app** | pick or search a handle | share your handle |
| **A conventional wallet** | paste or scan an address | show an address, then sweep it |

Six cells, one screen, one route. The user picks a row; **the transport is inferred, never chosen**.

### Why direction is the primary axis

Every one of the three existing screens already has both a send and a receive side — `payments.tsx` has an incoming-payments list, `legacy-payments.tsx` has receive/send tabs, `local-payments.tsx` has request/send roles. Direction is the split the code already makes three times over. Making it the top-level axis collapses that duplication instead of adding a fourth variation.

An earlier draft of this design used "one Pay screen, two situations" and ignored receive entirely. That was wrong: Legacy Bridge's receive side generates an address and sweeps it, which does not fit under "Pay someone" in any form.

### Naming

- **"Nearby"**, not "Local", not "P2P", not "Device to Device". Established by Nearby Share, AirDrop's "People Nearby", Apple Tap to Cash. The guide's recommendation 2 warns against inventing vocabulary where muscle memory exists. "Local" reads as *local network* to a technical user and as nothing to anyone else; "P2P" and "Device to Device" are engineering words.
- **"Legacy Bridge" disappears as a user-facing term.** The user pastes an address; the app knows what that means. The functionality is fully retained — it is the only way to move money between this wallet and conventional ones.
- Transport names survive only in **explanatory subtitles and support docs**, never on buttons.
- Success reads **"Paid"**, not "Payment sent" (guide, Quick Reference).
- In-person receive shows a **payment code**; only a fixed figure is a "request" (guide, section 3). So: "Show payment code" when open, "Request 5,000 sats" when set.

### What the user actually needs to know

Not the transport — the **precondition and the consequence**. One line each, at the point of choosing and again at confirm:

| Cell | Precondition | Consequence at confirm |
|---|---|---|
| Pay nearby | you are both here | settles in seconds |
| Pay a handle | they use this app | lands when their wallet next checks |
| Pay an address | you have their address | sent — they are not notified |

The third is the one that must never be implicit. A user who pastes an address expecting Venmo-like delivery has effectively posted cash. Guide recommendation 6 puts the amount and an explicit button at the confirm step; the consequence line belongs there too.

## Architecture

One route. The three screens' logic is extracted into transport-agnostic modules so the screen composes rather than contains.

```
app/pay.tsx                       one screen, six cells
  ├── Pay | Get paid              primary segmented control
  └── counterparty picker          nearby · handle · address

utils/pay/
  rails/nearby.ts                 wraps utils/localpay/* (unchanged)
  rails/handle.ts                 PeerPay send + incoming list/accept
  rails/address.ts                legacy send + date-keyed receive + sweep
  rails/index.ts                  RailId, inferRail(), consequence copy keys
  identity.ts                     existing utils/identity/resolveIdentity (unchanged)
```

`utils/localpay/*` is **not** touched. It is device-proven, has 210 tests behind it, and its money-safety invariants were verified line by line. The nearby rail is a thin adapter over it.

### Rail inference

```ts
type RailId = 'nearby' | 'handle' | 'address'

// Pure. Derived from how the counterparty was identified, never from a user
// choosing a transport.
function inferRail(target: PayTarget): RailId
```

`PayTarget` is a discriminated union: a scanned nearby session, a resolved identity, or a validated address. Each carries what its rail needs and nothing more.

## What must survive

Behaviour that exists today and must not be lost, because losing it strands users or money:

1. **Legacy send** — pay to a standard address. The only route between this wallet and conventional ones.
2. **Legacy receive, including the date-keyed derivation.** `getCurrentDate(daysOffset)` as the derivation prefix, and the ability to reach previous days' addresses. A user given yesterday's address must still be able to sweep it — this is why the offset control survives even after same-day sweeping becomes automatic.
3. **The sweep itself** — the balance check and the UTXO import. The *mechanism* must survive verbatim; only its trigger changes, from a user tapping to the background poll described below.
4. **PeerPay incoming** — list, accept, internalize.
5. **Identity search** and PeerPay URI scanning (`validatePeerPayURI`).
6. **Everything in `local-payments.tsx`**, unchanged in behaviour.
7. **The identity-key QR**, relocated to Get paid → handle as "your handle". Its `settings.tsx` modal is removed; that regression is accepted.

## Legacy receive becomes automatic

**Decided.** The overwhelmingly common case is that an address is handed out and paid on the same day it was issued, so the sweep should need no UI interaction at all: poll in the background, and when funds arrive, internalize them, raise a success toast, and add the entry to the inbound transaction history.

That removes the manual check-then-import step from the user's path entirely. "Get paid → a conventional wallet" becomes: show the address, and money appears.

Consequences for the design:

- **The day-offset stepper stops being load-bearing.** If today's address sweeps itself, the only reason to reach a previous day's address is the uncommon case of a payer who sat on it. That is a recovery path, not a primary control, so it belongs behind a secondary affordance rather than on the main view. It must still exist — a previously-issued address whose funds cannot be swept is lost money.
- **Polling needs an owner and a lifecycle.** It cannot live in the screen, because the screen is exactly what the user no longer has to visit. It belongs beside the existing background work in `WalletContext` — which already runs a NetInfo-triggered retry loop for nearby payments and holds an in-flight guard for it — so the two background sweeps share one pattern.
- **It needs bounds.** A poll per open is cheap; an unbounded background poll is not. Needs: an interval, a stop condition once funds are found and internalized, a cap on how many days back it will look, and no polling while offline. State them in the plan rather than leaving them to the implementer.

Open question 3 below still stands; the address-history question is now downgraded to a secondary recovery affordance rather than a redesign.

## Non-goals

- Changing any money path in `utils/localpay/*`.
- Altering how PeerPay or legacy transactions are constructed, signed or broadcast. This is an IA and copy change, not a protocol change.
- Notifying a legacy payee (the rail has no mechanism for it).
- A full address-history redesign. The day-offset control is retained as a
  secondary recovery affordance, not reworked.

## Migration

- `/pay` added. `/payments`, `/legacy-payments`, `/local-payments` removed from `_layout.tsx` and their files deleted once their logic is extracted.
- Wallet menu: four rows (Payments, Legacy Bridge, Local Payments, Identity Key) become one — **Pay**.
- Deep links: anything targeting `/payments` or `/local-payments` must redirect to `/pay` with the right cell preselected. `peerpay:` URI handling must keep working.
- Orphaned i18n keys from the current copy are removed across all twelve locales in the same pass: `local_pay_amount_specific`, `local_pay_open_request`, `local_pay_enter_amount`, plus whatever the rewrite orphans.

## Risks

| Risk | Severity | Handling |
|---|---|---|
| Losing legacy send strands the only bridge to conventional wallets | high | Explicit survival requirement 1; needs a device test paying a real external address |
| Date-keyed receive logic mis-ported, so a previously-issued address becomes unreachable and its funds unsweepable | high | Port with tests over `getCurrentDate`/offset before any UI work |
| A 5,000-line merge regresses a money path | high | Task-by-task with review gates; `utils/localpay/*` untouched |
| Six cells on one screen becomes a worse maze than three rows | medium | One focal element per cell; the picker is a row, not a grid |
| Deep links break silently | medium | Redirects, and a test per legacy route |

## Open questions

1. ~~Address history versus day-offset stepper.~~ **Decided:** keep the offset
   control as a secondary recovery affordance. Automatic same-day sweeping
   makes it a fallback rather than a primary control.
2. ~~Automatic sweep, or manual?~~ **Decided:** automatic, in the background,
   with a success toast and an inbound history entry. See "Legacy receive
   becomes automatic".
3. ~~Should "Get paid → handle" show a shareable link as well as the QR?~~
   **Decided: yes.** It shares a `peerpay:<identityKey>` URI through the native
   share sheet, alongside the QR and a copy action. That form was already parsed
   by `utils/parsePeerPayURI.ts` and already routed by `app/+native-intent.ts`,
   so a tapped link lands on `/pay` with the recipient filled in — no protocol
   work. `peerPayLinkFor` is tested against the app's own validator.
4. ~~Does anything outside the app deep-link to `/legacy-payments`?~~
   **Answered: no.** Its only references were the wallet menu and the route
   registration. `peerpay:` is the sole external entry point and it targeted
   `/payments`. All three old paths are nonetheless kept as redirect stubs, since
   a `peerpay:` link from an earlier build still names `/payments`.
5. ~~What are the polling bounds?~~ **Decided and implemented:** a 30 s
   interval, and a pass runs only while the wallet is built, the app is
   foreground and the device is online, never two at once (`shouldSweepNow`).
   The sweeper polls only addresses the app has actually shown a user — never a
   blind day look-back — capped at 8, dropped after 24 h with no activity or once
   dated more than 7 days back (`utils/pay/watchlist.ts`). An address that
   received money stays watched, so a second payment to it is still caught.

## Regressions accepted, and one fixed on the way

- The identity-key QR left `settings.tsx` for Get paid → handle, as planned.
- Dropped as informational: the green active-server chip (its job merged into
  the message-box row), the "No Message Box Set" warning (the panel auto-opens
  for that state), and the in-session legacy send log (`/transactions` has it).
- **Fixed, not accepted:** consolidating the screens initially left the
  message-box panel unreachable — a user who saved a broken host had no route to
  reset it, because reset and use-no-server both live inside the panel. Both
  handle cells now carry a row that names the active host and opens it.
- **Fixed in passing:** `enter_valid_amount` was called by the old payments
  screen and defined in no locale, so an invalid amount showed the user a raw
  key. Now defined in all twelve.
