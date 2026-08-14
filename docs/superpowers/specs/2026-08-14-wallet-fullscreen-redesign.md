# Wallet full-screen redesign — design + implementation spec

**Date:** 2026-08-14
**Scope:** the wallet menu, the inline transactions list, transaction export, and the vault screen.
**Out of scope:** `app/pay.tsx` (the Payments screen) stays exactly as it is. Only its *entry point* changes.
**Status:** spec only. No code was modified producing this document.

---

## 0. Three corrections to the brief, up front

These are places where the brief and the code disagree. Reporting them rather than working around them silently.

### 0.1 `app/wallet-config.tsx` is NOT the wallet menu

The brief describes `app/wallet-config.tsx` as "the current wallet menu screen". It is not.

| File | What it actually is | Title it renders |
|---|---|---|
| `app/settings.tsx` (167 lines) | **The wallet menu.** Balance + Activity rows (Transactions / Payments / Vault) + one row into Settings. Rendered as a **bottom sheet**, never as a route. | none (sheet has no title) |
| `app/wallet-config.tsx` (677 lines) | **The Settings drill-down.** Network, ARC endpoint, display currency, auto-spend threshold, trust network, recovery phrase, DB import/export, delete wallet. | `t('settings')` (`app/wallet-config.tsx:276`) |

The naming is inverted relative to what each file does. `app/settings.tsx:139` pushes `/wallet-config`; `components/browser/SheetRouter.tsx:14` imports `app/settings.tsx` *as a component*.

**Consequence for this spec:** the screen being redesigned is `app/settings.tsx`. `app/wallet-config.tsx` is the destination of the third button ("Settings") and is otherwise untouched, except for one row removal (§7.4).

### 0.2 Brief items #5 and #7 are already partly satisfied

- **#7 (color guides the eye)** is already correct on the *vault action row*: `app/vault.tsx:205` gives Deposit `colors.accent` as a fill, `app/vault.tsx:213` gives Withdraw a hairline outline. That pattern is right and this spec propagates it rather than replacing it.
- The vault screen's real problems are (a) padding (§2), (b) bottom sheets (§1.3), (c) two accent-filled elements competing on the not-enrolled state (§5.2), and (d) a dark-mode invisible icon (§8.3).

### 0.3 Brief item #6 ("no bottom drawers") has one unavoidable exception

`components/vault/VaultCeremonySheet.tsx` is mounted globally at `app/_layout.tsx:138` and is driven by `VaultContext`, which mirrors the ceremony singleton. It fires from inside `withdrawFromVault` → the privileged-signature path — i.e. from *any* screen, at an arbitrary moment, with no navigation intent. It is a **system prompt**, in the same class as `PermissionSheet` (`app/_layout.tsx:137`) and `AlertCard`'s centered `Modal`. Converting it to a route would require re-architecting the privileged-key ceremony to own navigation, which is a much larger change with real security surface.

**Recommendation:** the ban on bottom drawers applies to *navigational* surfaces. `VaultCeremonySheet` and `PermissionSheet` stay. `SheetRouter`'s settings sheet, `TransferSheet`, and `RecoverSheet` all go (§1.3, §7).

---

## 1. Current state audit

### 1.1 Routing / presentation, screen by screen

| Screen | File | How it is reached | Presentation |
|---|---|---|---|
| Wallet menu | `app/settings.tsx` | ⋯ menu in the address bar → `onSettings` (`components/browser/AddressBar.tsx:1123`) → `onOpenSheet('settings')` → `app/index.tsx:1627` `sheet.push(route)` | **Bottom sheet**, `fitContent` (`components/browser/SheetRouter.tsx:46,48,80,100`) |
| Transactions | `app/transactions.tsx` | `app/settings.tsx:112` `router.push('/transactions')` | Full-screen pushed route (`app/_layout.tsx:151`) |
| Payments | `app/pay.tsx` | `app/settings.tsx:122` `router.push('/pay')` — **the only entry point in the app** | Full-screen pushed route (`app/_layout.tsx:154`) |
| Vault | `app/vault.tsx` | `app/settings.tsx:128` `router.push('/vault')` | Full-screen pushed route (`app/_layout.tsx:153`) |
| Settings | `app/wallet-config.tsx` | `app/settings.tsx:139` `router.push('/wallet-config')` | Full-screen pushed route (`app/_layout.tsx:152`) |

Note: `app/settings.tsx` is *also* a valid expo-router route (`/settings`) purely by file convention, even though it is not declared in the `<Stack>` in `app/_layout.tsx`. Nothing in the repo navigates to it. It is only ever used as an imported component.

### 1.2 What each screen does today

**`app/settings.tsx` (wallet menu).** Fetches wallet balance via `permissionsManager.listOutputs({ basket: sdk.specOpWalletBalance })` with a per-network AsyncStorage cache (`cached_wallet_balance_${selectedNetwork}`, 30s TTL, lines 15–88), re-fetching on `txStatusVersion` bumps. Renders a 100pt-high balance block (34/700, `localStyles.balanceAmount:160`) hidden in web2 mode, then two `GroupedSection`s: Activity (Transactions / Payments / Vault) and a bare section holding one Settings row. Root is `<View style={{ backgroundColor }}>` with **no `flex: 1`** (line 91) — deliberate, so the sheet's `fitContent` `onLayout` measurement works.

**`app/transactions.tsx`.** Paginated `FlatList` (PAGE_SIZE 30) over `permissionsManager.listActions`, with an advisory offline-queue overlay read from SQLite (`findOfflineActions`, lines 90–104). Per-row actions: abort (for `unsigned`/`nosend`/`nonfinal`), refresh proof, open in explorer, copy raw tx. Export lives as a `download-outline` icon in the header (lines 362–374) and calls `exportTransactionsAsCsv`.

**`app/vault.tsx`.** Five mutually exclusive renders sharing one `Header`: unsupported device (126), loading (139), enroll wizard (151), not enrolled (161), enrolled (184). The enrolled state is balance block → deposit/withdraw actions → Key `GroupedSection` → Manage `GroupedSection`, with `TransferSheet` and `RecoverSheet` mounted at 256–257.

**`app/wallet-config.tsx`.** Settings drill-down. Uses inline-expanding `ListRow` disclosure (network, ARC, currency, threshold) rather than sub-screens. Contains a *different* export — `export_wallet_data` → `exportAllWalletDatabases` (lines 541–548). See §6.2.

**`app/pay.tsx`.** Grid of payment cells with a pay/get segment; each cell swaps the body in place under one header. Unchanged by this spec.

### 1.3 Every bottom drawer in these flows

| # | Where mounted | Sheet component | Verdict |
|---|---|---|---|
| 1 | `components/browser/SheetRouter.tsx:73–101` (child at `:100`) | `components/ui/Sheet.tsx` `fitContent` | **Remove.** This is the wallet menu itself. |
| 2 | `app/vault.tsx:256` → `components/vault/TransferSheet.tsx:70–104` | `components/ui/Sheet.tsx` `fitContent` | **Remove** → route `/vault-transfer`. |
| 3 | `app/vault.tsx:257` → `components/vault/RecoverSheet.tsx:50–78` | `components/ui/Sheet.tsx` `fitContent` | **Remove** → route `/vault-recover`. |
| 4 | `app/_layout.tsx:138` → `components/vault/VaultCeremonySheet.tsx:131` | `components/ui/Sheet.tsx` `fitContent` | **Keep** — system prompt, not navigation (§0.3). |
| 5 | `app/_layout.tsx:137` → `components/ui/PermissionSheet.tsx` | own sheet | **Keep** — system prompt. |

`components/ui/AlertCard.tsx` uses a **centered** `Modal` (`:128`, `:183–184` `alignItems/justifyContent: 'center'`), not a bottom drawer. It stays.

`FULL_PAGE_ROUTES = ['bookmarks','history']` in `SheetRouter.tsx:45` are browser surfaces, outside this brief's scope. Leave them.

### 1.4 Safe-area convention (verified, must be matched)

Every full-screen route in this repo uses exactly the same skeleton:

```
<View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
  <View style={styles.header}>  {/* paddingHorizontal: spacing.sm, paddingVertical: spacing.md, hairline bottom */}
    <TouchableOpacity style={{width:44,height:44,...}}><Ionicons name="chevron-back" size={24} color={colors.accent}/></TouchableOpacity>
    <Text style={typography.headline}>{title}</Text>
    <View style={{width:44,height:44}} />   {/* or a trailing control */}
  </View>
  ...
</View>
```

Confirmed identical at `app/transactions.tsx:355`, `app/vault.tsx:185`, `app/pay.tsx:293`, `app/wallet-config.tsx:270`, `app/connections.tsx:187`, `app/logs.tsx:141`, `app/trust.tsx:155`.

Bottom inset is handled per-list, not on the container: `app/transactions.tsx:347` and `app/logs.tsx:290` use `<View style={{ height: insets.bottom + 40 }} />` as a `ListFooterComponent`/trailing spacer. **No screen uses `SafeAreaView`.** `components/ui/CustomSafeArea.tsx` exists but is unused by these screens.

The new wallet screen must adopt this skeleton verbatim. `app/settings.tsx` has **no inset handling at all** today because a bottom sheet needs none.

---

## 2. Double-padding diagnosis

### 2.1 The offending nesting (confirmed)

```
app/vault.tsx:187   <ScrollView contentContainerStyle={styles.content}>
app/vault.tsx:268     content: { padding: spacing.lg /* 16 */, gap: spacing.xl /* 20 */ }
                        │
                        ├── app/vault.tsx:220  <GroupedSection header={t('vault_key_section')}>
                        └── app/vault.tsx:238  <GroupedSection header={t('vault_manage_section')}>
                                                 │
components/ui/GroupedList.tsx:107                └── styles.group: { marginHorizontal: spacing.lg /* 16 */ }
components/ui/GroupedList.tsx:102                    styles.header: { paddingHorizontal: spacing.xl /* 20 */ }
components/ui/GroupedList.tsx:97                     styles.section: { marginBottom: spacing.xxl /* 24 */ }
```

`GroupedSection` **self-insets**. It is designed to be dropped into a scroll view that has *no* horizontal padding. Measured result:

| Element | In `app/vault.tsx` | Everywhere else | Excess |
|---|---|---|---|
| Card left/right inset | 16 (ScrollView) + 16 (`group.marginHorizontal`) = **32pt** | 16pt | **+16pt each side** |
| Section header text inset | 16 + 20 (`header.paddingHorizontal`) = **36pt** | 20pt | **+16pt** |
| Gap between the two sections | 20 (`content.gap`) + 24 (`section.marginBottom`) = **44pt** | 24pt | **+20pt** |

### 2.2 Proof that 16pt (not 32pt) is the house value

Both other consumers of `GroupedSection` pass a `contentContainerStyle` with **no horizontal padding**:

- `app/wallet-config.tsx:279` — `contentContainerStyle={{ paddingTop: spacing.lg, paddingBottom: spacing.xxxl }}`
- `app/settings.tsx:92` — `contentContainerStyle={{ paddingBottom: spacing.xxxl }}`

So the vault screen's cards are visibly narrower than the cards on Settings and the wallet menu. That is the extra padding the product owner is seeing.

### 2.3 The precise fix

Three edits, all in `app/vault.tsx`'s `StyleSheet`, plus one in the JSX:

```diff
  // app/vault.tsx:268
- content: { padding: spacing.lg, gap: spacing.xl },
+ // GroupedSection self-insets (GroupedList.tsx:107 marginHorizontal: spacing.lg)
+ // and self-spaces (GroupedList.tsx:97 marginBottom: spacing.xxl). Adding
+ // horizontal padding or a gap here double-applies both. Non-GroupedSection
+ // blocks below carry their own spacing.lg gutter instead.
+ content: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },

  // app/vault.tsx:275
- balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
+ balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },

  // app/vault.tsx:278
- actions: { flexDirection: 'row', gap: spacing.md },
+ actions: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xxl },
```

`actions.marginBottom: spacing.xxl` replaces the removed `content.gap` for the one boundary that had no `GroupedSection` on its leading side, so the vertical rhythm becomes a consistent 24pt everywhere.

### 2.4 What is NOT double-padded (checked, reporting honestly)

- **`app/vault.tsx:155` `<EnrollWizard/>`** — parent is `styles.container` (`:263`) which is bare `{ flex: 1 }`. The wizard's own `styles.body` `padding: spacing.xl` (`components/vault/EnrollWizard.tsx:238`) is the only padding. Correct.
- **`app/vault.tsx:165` `contentContainerStyle={styles.centered}`** (`:267`, `padding: spacing.xl`) — children are bare `Text`/`Ionicons`/`PressableScale`. Correct.
- **`TransferSheet.tsx:109` / `RecoverSheet.tsx:83` `body: { padding: spacing.xl }`** inside `<Sheet fitContent>` — `Sheet.tsx:226` renders `<View style={fitContent ? undefined : {flex:1}}>`, no padding. Not nested. **However** the sheet chrome *stacks*: `handleArea.paddingTop` 8 (`Sheet.tsx:290`) + `headerRow.paddingTop` 8 + `headerRow.paddingBottom` 12 (`:302–303`) + `body.padding` top 20 = **48pt** from the sheet's top edge to the first glyph. That is stacked, not nested, and it reads as "extra padding" too. `VaultCeremonySheet.tsx:240` already works around it by using `paddingHorizontal` + `paddingBottom` with **no** `paddingTop` — evidence the author hit this. Moot once these two sheets become routes (§7.5–7.6), but if either is kept, copy the ceremony sheet's approach.

---

## 3. Token inventory (`context/theme/tokens.ts`, `context/theme/motion.ts`)

Nothing below is invented. Anything not in this list does not exist.

### 3.1 Spacing — 4pt base grid

`spacing.xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 20 · `xxl` 24 · `xxxl` 32

### 3.2 Radii

`radii.sm` 6 · `md` 10 · `lg` 14 · `xl` 20 · `pill` 999

### 3.3 Typography — iOS scale, ≈1.25 ratio

`display` 44/700 (lh 52, ls −0.5) · `largeTitle` 34/700 · `title1` 28/700 · `title2` 22/700 · `title3` 20/600 · `headline` 17/600 · `body` 17/400 · `callout` 16/400 · `subhead` 15/400 · `footnote` 13/400 · `caption1` 12/400 · `caption2` 11/400

The file's own doc comment states the rule this spec follows: *"`display` … is for a single focal figure on a screen that has one … Two `display` elements on one view means the view has no focal point."*

### 3.4 Colors (both themes defined; light/dark values shown)

| Token | Light | Dark |
|---|---|---|
| `accent` | `black` | `white` |
| `accentSecondary` | `#222222` | `#e8e8e8` |
| `textOnAccent` | `#FFFFFF` | `#000000` |
| `background` | `#FFFFFF` | `#000000` |
| `backgroundSecondary` | `#F2F2F7` | `#1C1C1E` |
| `backgroundTertiary` | `#FFFFFF` | `#2C2C2E` |
| `backgroundElevated` | `#FFFFFF` | `#1C1C1E` |
| `textPrimary` | `#000000` | `#FFFFFF` |
| `textSecondary` | rgba(60,60,67,.6) | rgba(235,235,245,.6) |
| `textTertiary` | rgba(60,60,67,.3) | rgba(235,235,245,.3) |
| `textQuaternary` | rgba(60,60,67,.18) | rgba(235,235,245,.18) |
| `separator` | rgba(60,60,67,.29) | rgba(84,84,88,.6) |
| `separatorOpaque` | `#C6C6C8` | `#38383A` |
| `fill` / `fillSecondary` / `fillTertiary` | rgba(120,120,128,.2/.16/.12) | rgba(120,120,128,.36/.32/.24) |
| `success` | `#34C759` | `#30D158` |
| `error` | `#FF3B30` | `#FF453A` |
| `warning` | `#FF9500` | `#FF9F0A` |
| `info` | `#007AFF` | `#0A84FF` |
| `permissionProtocol/Basket/Identity/Spending` | — | — |

Also: `chromeBackground`, `chromeBackgroundBlur`, `sheetBackground`, and `paperBackground` (defined only in `context/theme/ThemeContext.tsx:59,90,112`, aliased to `backgroundSecondary`).

`hitTargets.minimum` = 44.

### 3.5 Motion

`easings.out` = `Easing.bezier(0.23, 1, 0.32, 1)` — the only curve.
`springs.snappy` `{mass:1, stiffness:380, damping:36}` (buttons) · `springs.settle` `{mass:1, stiffness:280, damping:32}` (surfaces).
`durations.instant` 150 · `quick` 250 · `moderate` 350.

### 3.6 Gaps and hazards in the token system — flagged, not invented around

1. **`accent` is achromatic and collapses into `textPrimary` as a text color.** Light: `accent: 'black'` ≡ `textPrimary: '#000000'`. Dark: `accent: 'white'` ≡ `textPrimary: '#FFFFFF'`. So `color={colors.accent}` on text is *visually identical* to `color={colors.textPrimary}`. **`accent` only carries meaning as a fill.** The codebase already relies on this correctly (`app/vault.tsx:205`) and incorrectly (`app/wallet-config.tsx:274`, `app/vault.tsx:216` — harmless but meaningless).
2. **There is no "tappable text" token.** The de-facto one is `colors.info`, used for the `/pay` modal's Done control (`app/pay.tsx`, `color: colors.info`). This spec uses `info` where a text control must read as tappable.
3. **There is no border/outline token.** `separator` is doing double duty as both hairline divider and button outline (`app/vault.tsx:213`). Acceptable — noting it so it isn't mistaken for a missing token.
4. **There is no elevation scale.** Depth in this app is **surface-color shift + hairline border** (`GroupedList.tsx:105–109`: `backgroundElevated` + `separator` + `radii.md`). One strategy, already committed to. Do not introduce shadows.
5. **`fontVariant: ['tabular-nums']` is an established convention but is missing where it matters most.** Present at `components/pay/NearbyFlow.tsx:2083–2084` and `components/wallet/AmountInput.tsx:167`. **Absent** from `app/transactions.tsx:440` (`styles.amount`) and `app/settings.tsx:160` (`balanceAmount`) — the two places with a right-aligned column and a live-updating figure. Fixing this is part of the plan.
6. **`ListRow` hardcodes its icon glyph to `#FFFFFF`** (`components/ui/ListRow.tsx:41`) while the tile background is `iconColor || colors.accent`. In dark mode `accent` is `white` → white glyph on a white tile → **invisible icon**. Confirmed live at `app/vault.tsx:225` (`iconColor={colors.accent}`), and latent on every `<ListRow icon=...>` that omits `iconColor`. See §8.3.
7. **Ad-hoc hex is widespread in `ListRow` icon tiles**: `#6E56CF`, `#00C7BE`, `#FF9F0A`, `#32ADE6`, `#30D158`, `#BF5AF2`, `#CC8400`, `#5856D6`, `#636366`, `#8E8E93`, `#30B0C7` across `app/wallet-config.tsx` and `app/settings.tsx`. Eleven unrelated hues, none from the token file, none meaning anything. This spec removes them from the wallet screen (§5.1) and leaves `wallet-config.tsx` alone (a separate cleanup).

---

## 4. Target IA

### 4.1 Design intent

**Who.** Someone mid-browsing who tapped the ⋯ menu. A web page is loaded behind them. They came for one of two things: *did that payment land?* or *pay someone*. They will be back on the page in under ten seconds.

**Verb.** *Check*, then *leave*. Or *pay*, then *leave*. Nobody is browsing this screen for pleasure.

**Feel.** A bank statement, not a fintech app. The product's world is a ledger book next to a safe: paper, ink, a green "cleared" stamp, an amber "in transit" stamp, a red returned cheque, and the brushed steel of the hardware key. This is not a metaphor imposed on the codebase — it is what the codebase already decided when it set `accent: 'black'` / `accent: 'white'`. **Color in this app is never brand. It is only ever money-state.**

**Signature.** One filled achromatic button between two hairline-outlined siblings — the single filled surface above the fold — with a transaction list below it that is entirely grayscale except for the rows that need you.

**Defaults being rejected.**
- Three equally-weighted action chips (the iOS-wallet default) → one filled, two outlined.
- A rainbow of rounded icon tiles on every row (the current `ListRow` pattern, eleven hues, §3.6.7) → **no icon tiles at all** on the wallet screen.
- A tinted status pill on every row (`app/transactions.tsx:249` `status.color + '20'`) → the common case earns **no** chroma. See §6.

### 4.2 Main wallet screen — `app/wallet.tsx` (new)

```
┌── View {flex:1, bg: colors.backgroundSecondary, paddingTop: insets.top} ───────┐
│                                                                                │
│ ┌── View styles.header  (paddingH sm, paddingV md, hairline bottom separator)─┐│
│ │ [◀ chevron-back 24 / accent]      Wallet          [ 44×44 spacer ]          ││
│ │  TouchableOpacity 44×44           typography.headline / textPrimary         ││
│ │  → router.back()                                                            ││
│ └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                │
│ ┌── FlatList  (owns the entire scroll — one list, not a ScrollView+FlatList) ─┐│
│ │                                                                             ││
│ │  ListHeaderComponent ─────────────────────────────────────────────────────┐ ││
│ │  │                                                                        │ ││
│ │  │  View styles.balanceBlock   {align center, paddingV xxl, paddingH lg}   │ ││
│ │  │  ┌───────────────────────────────────────────────────────────────────┐  │ ││
│ │  │  │                     YOU HAVE                                      │  │ ││
│ │  │  │      typography.footnote / textTransform uppercase                 │  │ ││
│ │  │  │      color: colors.textSecondary        t('you_have')              │  │ ││
│ │  │  │                                                                   │  │ ││
│ │  │  │                  1.2453 BSV              ◀◀◀ FOCAL POINT           │  │ ││
│ │  │  │      typography.display (44/700/-0.5)                              │  │ ││
│ │  │  │      fontVariant ['tabular-nums']                                  │  │ ││
│ │  │  │      color: colors.textPrimary                                     │  │ ││
│ │  │  │      <AmountDisplay abbreviate>{accountBalance}</AmountDisplay>    │  │ ││
│ │  │  │      onPress → refreshBalance()   opacity .4 while loading         │  │ ││
│ │  │  └───────────────────────────────────────────────────────────────────┘  │ ││
│ │  │                                                                        │ ││
│ │  │  View styles.actions  {row, gap md, paddingH lg, marginBottom xxl}      │ ││
│ │  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐              │ ││
│ │  │  │  ▓▓▓▓▓▓▓▓▓▓▓▓  │ │                │ │                │              │ ││
│ │  │  │  ▓ Payments ▓  │ │    Vault       │ │   Settings     │              │ ││
│ │  │  │  ▓▓▓▓▓▓▓▓▓▓▓▓  │ │                │ │                │              │ ││
│ │  │  └────────────────┘ └────────────────┘ └────────────────┘              │ ││
│ │  │   PressableScale     PressableScale     PressableScale                 │ ││
│ │  │   haptic="confirm"   haptic="tap"       haptic="tap"                   │ ││
│ │  │   flex:1  radii.md   flex:1  radii.md   flex:1  radii.md               │ ││
│ │  │   paddingV md                                                          │ ││
│ │  │   bg colors.accent   bg transparent     bg transparent                 │ ││
│ │  │   —                  hairline separator hairline separator             │ ││
│ │  │   label textOnAccent label textPrimary  label textPrimary              │ ││
│ │  │   typography.subhead/600  (all three — identical type, differing fill) │ ││
│ │  │   → router.push('/pay')  → '/vault'     → '/wallet-config'             │ ││
│ │  └────────────────────────────────────────────────────────────────────────┘ ││
│ │                                                                             ││
│ │  ┌── View styles.listHeader {row, space-between, align center,            ┐ ││
│ │  │                            paddingH lg, paddingBottom sm}              │ ││
│ │  │  ACTIVITY                                          Export CSV          │ ││
│ │  │  typography.footnote / uppercase                   PressableScale      │ ││
│ │  │  color: colors.textSecondary                       typography.footnote │ ││
│ │  │  t('activity')                                     colors.textSecondary│ ││
│ │  │  ── matches GroupedList.tsx:100–104 header treatment ──   hitSlop 8    │ ││
│ │  │                                       disabled when actions.length===0 │ ││
│ │  │                                       → exportTransactionsAsCsv(...)   │ ││
│ │  └────────────────────────────────────────────────────────────────────────┘ ││
│ │  ══════════════════ hairline, colors.separator, full-bleed ═══════════════   ││
│ │                                                                             ││
│ │  renderItem × n  →  <TransactionRow />   (components/wallet/TransactionRow) ││
│ │  ┌──────────────────────────────────────────────────────────────────────┐   ││
│ │  │ Coffee at Ada's                                       −4,200 sats    │   ││
│ │  │ body / textPrimary / 1 line              body/600 / textPrimary      │   ││
│ │  │                                          fontVariant tabular-nums    │   ││
│ │  │ Confirmed                                        [⧉]      [↗]        │   ││
│ │  │ footnote / textTertiary — NO dot, NO pill    32×28 iconButtons       │   ││
│ │  └──────────────────────────────────────────────────────────────────────┘   ││
│ │  ┌──────────────────────────────────────────────────────────────────────┐   ││
│ │  │ Invoice #22                                        +180,000 sats     │   ││
│ │  │ ● Not sent                                    [↻]   [⧉]      [↗]     │   ││
│ │  │ 6pt dot + footnote, both colors.warning   ◀ the ONLY chroma on screen │   ││
│ │  └──────────────────────────────────────────────────────────────────────┘   ││
│ │  ... rows are separated by hairline colors.separator (existing styles.row)  ││
│ │                                                                             ││
│ │  ListEmptyComponent → View {paddingV xxxl, align center}                    ││
│ │                        Text typography.body / textSecondary                 ││
│ │                        t('no_transactions')                                 ││
│ │  ListFooterComponent → loadingMore                                          ││
│ │                          ? <ActivityIndicator color={colors.accent}/>       ││
│ │                          : <View style={{height: insets.bottom + 40}}/>     ││
│ │  onEndReached=loadMore  onEndReachedThreshold=0.3                           ││
│ │  refreshing / onRefresh  (pull-to-refresh preserved)                        ││
│ └─────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

**Structural notes.**
- One `FlatList` owns the whole scroll. Do **not** nest a `FlatList` inside a `ScrollView` — it breaks virtualization and pull-to-refresh. The balance + buttons + section header go in `ListHeaderComponent`.
- No `GroupedSection` on this screen. The transaction list is a full-bleed hairline-separated list, which is the right form for a scannable log and is what `app/transactions.tsx` already does (`styles.row:410–416`).
- Web2 mode: keep the existing guard — hide the balance block when `isWeb2Mode` (currently `app/settings.tsx:94`). The three buttons and the list stay.

### 4.3 Vault screen — `app/vault.tsx` (restructured, same five states)

Enrolled state:

```
┌── View styles.container {flex:1, bg backgroundSecondary, paddingTop insets.top}┐
│ ┌── View styles.header (unchanged, app/vault.tsx:264) ────────────────────────┐│
│ │ [◀]                        Vault                     [ 44×44 spacer ]       ││
│ └─────────────────────────────────────────────────────────────────────────────┘│
│ ┌── ScrollView contentContainerStyle={styles.content} ───────────────────────┐ │
│ │   ◀ FIXED: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl }         │ │
│ │     NO horizontal padding. NO gap.  (see §2.3)                             │ │
│ │                                                                            │ │
│ │  View styles.balanceBlock {align center, paddingV xxl, paddingH lg}         │ │
│ │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│ │  │                   VAULT BALANCE                                      │  │ │
│ │  │        typography.footnote / uppercase / textSecondary                │  │ │
│ │  │                   0.4000 BSV            ◀◀◀ FOCAL POINT               │  │ │
│ │  │        typography.display / tabular-nums / textPrimary                │  │ │
│ │  │        <AmountDisplay>{balance ?? 0}</AmountDisplay>                  │  │ │
│ │  │        TouchableOpacity onPress={refresh}                             │  │ │
│ │  │        ActivityIndicator while (loading && balance === null)           │  │ │
│ │  └──────────────────────────────────────────────────────────────────────┘  │ │
│ │                                                                            │ │
│ │  View styles.actions {row, gap md, paddingH lg, marginBottom xxl}  ◀ FIXED  │ │
│ │  ┌──────────────────────────┐ ┌──────────────────────────┐                 │ │
│ │  │ ▓▓ [↓] Deposit ▓▓▓▓▓▓▓▓  │ │    [↑] Withdraw          │                 │ │
│ │  └──────────────────────────┘ └──────────────────────────┘                 │ │
│ │   PressableScale flex:1        PressableScale flex:1                       │ │
│ │   bg colors.accent             bg transparent                              │ │
│ │   icon+label textOnAccent      hairline colors.separator                   │ │
│ │   radii.md paddingV lg         icon+label colors.textPrimary  ◀ was accent │ │
│ │   → push /vault-transfer         → push /vault-transfer                    │ │
│ │       ?direction=deposit             ?direction=withdraw                   │ │
│ │                                                                            │ │
│ │  <GroupedSection header={t('vault_key_section')}>   ← self-insets 16pt      │ │
│ │    <ListRow label=nickname icon="hardware-chip"                            │ │
│ │             iconColor={colors.textSecondary}  ◀ FIXED, was colors.accent   │ │
│ │             showChevron={false} />                                          │ │
│ │    <ListRow label=serial icon="finger-print"                               │ │
│ │             iconColor={colors.textSecondary}  ◀ FIXED, was permissionSpending│
│ │             showChevron={false} isLast />                                   │ │
│ │  </GroupedSection>                                                          │ │
│ │                                                                            │ │
│ │  <GroupedSection header={t('vault_manage_section')}>                        │ │
│ │    <ListRow label=recover icon="medkit-outline"                            │ │
│ │             iconColor={colors.textSecondary}                                │ │
│ │             onPress={() => router.push('/vault-recover')} />                │ │
│ │    <ListRow label=disable icon="lock-open" iconColor={colors.error}         │ │
│ │             destructive onPress={confirmDisable} isLast />                  │ │
│ │  </GroupedSection>                                                          │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│  ✗ <TransferSheet/>  and  ✗ <RecoverSheet/>  are GONE — now routes             │
└────────────────────────────────────────────────────────────────────────────────┘
```

Not-enrolled state (same container + header):

```
│  ScrollView contentContainerStyle={styles.centered}  {flexGrow:1, center, padding xl, gap lg}
│  ┌───────────────────────────────────────────────────────────────┐
│  │        ╭─────────╮   80×80 circle, radii 40                   │
│  │        │   🔒    │   bg: colors.fillTertiary   ◀ FIXED         │
│  │        ╰─────────╯   icon: colors.textSecondary  ◀ FIXED       │
│  │                      (was accent-on-accent — two accent fills) │
│  │       Vault hero title      typography.title1 / textPrimary    │
│  │       Vault hero body       typography.subhead / textSecondary │
│  │  ┌─────────────────────────────────────────────────────────┐  │
│  │  │  ▓▓▓▓▓▓▓▓  Begin enrollment  ▓▓▓▓▓▓▓▓  ◀ ONLY accent fill│  │
│  │  └─────────────────────────────────────────────────────────┘  │
│  └───────────────────────────────────────────────────────────────┘
```

### 4.4 Vault transfer / recover — new full-screen routes

```
app/vault-transfer.tsx     ?direction=deposit|withdraw
app/vault-recover.tsx

┌── View {flex:1, bg backgroundSecondary, paddingTop insets.top} ──┐
│  header:  [◀]  Deposit / Withdraw / Recover vault   [ spacer ]   │
│  ┌── KeyboardAvoidingView (iOS 'padding') ──────────────────────┐│
│  │  ScrollView contentContainerStyle={styles.body}              ││
│  │    { padding: spacing.xl, gap: spacing.lg, alignItems:center }││
│  │    — lifted verbatim from TransferSheet.tsx:109 /             ││
│  │      RecoverSheet.tsx:83; the sheet-chrome stacking of §2.4   ││
│  │      disappears with the sheet.                               ││
│  │    <Ionicons arrow-down/up-circle-outline 40 accent>          ││
│  │    sub copy (subhead / textSecondary)                         ││
│  │    <AmountInput/>  or  phrase <TextInput/>                    ││
│  │    error (footnote / colors.error)                            ││
│  │    ▓▓ primary CTA — colors.accent fill ▓▓  ◀ only accent      ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

`KeyboardAvoidingView` replaces the `Sheet`'s bespoke keyboard lift (`components/ui/Sheet.tsx:82–97`), which only ever existed because a bottom sheet cannot scroll out from under the keyboard. **Do not** wrap the wallet screen's warm-WebView-adjacent trees in `KeyboardAvoidingView` — see §8.5.

---

## 5. Color strategy

The rule for both screens: **exactly one accent-filled surface per view; chroma appears only where money-state demands it.**

### 5.1 Main wallet screen

| Element | Token | Why |
|---|---|---|
| **Payments button fill** | `colors.accent` bg + `colors.textOnAccent` label | The single accent carrier. `accent` is achromatic (black/white), so it is the highest-contrast surface on screen and never competes with status chroma. Payments is the only reason a user opens this screen with intent to *act*. |
| Vault button | `transparent` bg, `StyleSheet.hairlineWidth` border in `colors.separator`, label `colors.textPrimary` | Peer of Payments in size and type, subordinate in weight. **Not** `colors.accent` as a label — that is indistinguishable from `textPrimary` (§3.6.1) and would falsely imply three accents. |
| Settings button | same as Vault | — |
| Balance figure | `colors.textPrimary` on `colors.backgroundSecondary` | Wins by **size** (`typography.display`, 44/700), not by color. The screen's focal point, and it must not be chromatic — a colored balance would compete with status. |
| "YOU HAVE" label | `colors.textSecondary`, `typography.footnote`, uppercase | Demoted. Matches `GroupedList.tsx:100–104` section-header treatment. |
| "ACTIVITY" label | `colors.textSecondary`, `typography.footnote`, uppercase | Same treatment — one section-header idiom across the app. |
| **Export CSV** | `colors.textSecondary`, `typography.footnote`; `colors.textQuaternary` when disabled | Rare escape hatch. It must not compete with Payments. *If usability testing says it is too quiet, the codebase's tappable-text token is `colors.info` (§3.6.2) — but that puts a second chromatic element above the list, so make the trade knowingly.* |
| Row description | `colors.textPrimary`, `typography.body` | — |
| Row amount | `colors.textPrimary`, `typography.body`/600, `fontVariant: ['tabular-nums']` | **Never green/red.** Sign carries direction; `formatSatoshisAsBsv` (`utils/amountFormatHelpers.ts:137`) already emits `−`/`+`. Coloring amounts is the default that puts chroma on 100% of rows. |
| Row icon buttons | `colors.textSecondary`; `colors.textQuaternary` when disabled; `colors.error` for abort | Unchanged from `app/transactions.tsx`. |
| Row separators | `colors.separator`, hairline | — |
| Status text + dot | see §6 | The only chroma on the screen. |
| **Icon tiles** | **removed entirely** | The eleven ad-hoc hues (§3.6.7) go. A transaction log does not need per-row iconography. |

**Squint test:** a screen of settled transactions is pure grayscale with one black (or white) button. A single amber dot is findable instantly. That is the whole design.

### 5.2 Vault screen

| Element | Token | Why |
|---|---|---|
| **Deposit button fill** | `colors.accent` + `colors.textOnAccent` | Already correct at `app/vault.tsx:205`. Deposit is the frequent, un-gated, low-consequence action. |
| Withdraw button | `transparent` + hairline `colors.separator`, icon and label `colors.textPrimary` | **Change:** currently `backgroundElevated` bg with `colors.accent` label (`app/vault.tsx:213,215,216`). `backgroundElevated` is `#FFFFFF`/`#1C1C1E` — nearly invisible against `backgroundSecondary` in dark mode, and the accent label is a no-op (§3.6.1). Transparent + hairline is honest and matches the wallet screen's outline buttons. |
| Vault balance | `colors.textPrimary`, `typography.display`, tabular-nums | One `display` per screen — the token file's own rule. |
| Key section icon tiles | `colors.textSecondary` | **Change:** `app/vault.tsx:225` `iconColor={colors.accent}` is a dark-mode invisible icon (§3.6.6, §8.3). `app/vault.tsx:233` `colors.permissionSpending` (orange) on a serial number is meaningless chroma. |
| Recover row icon tile | `colors.textSecondary` | **Change:** currently `colors.info ?? colors.accent` (`app/vault.tsx:242`). Recovery is not "informational"; and the `??` fallback is dead — `info` is always defined. |
| Disable row | `colors.error` tile, `destructive` prop | Correct as-is (`app/vault.tsx:248–249`). The one chromatic element on the enrolled vault screen, and it is a genuine warning. |
| Not-enrolled hero badge | `colors.fillTertiary` bg, `colors.textSecondary` icon | **Change:** currently `colors.accent` bg (`app/vault.tsx:166`) *and* the CTA is `colors.accent` (`:174`). Two accent fills = no focal point. |
| Not-enrolled CTA | `colors.accent` + `colors.textOnAccent` | Becomes the only accent fill on that state. |
| Transfer / recover CTA | `colors.accent` + `colors.textOnAccent` | Only accent fill on those routes. Already correct in the sheet versions. |

---

## 6. Transaction status clarity

### 6.1 How status is modeled today (verbatim from the code)

`getStatusInfo(status, colors, t, offline)` at `app/transactions.tsx:33–60`. The offline-queue row **outranks** the raw transaction status, with the reason documented in-code at `:40–43`. Full mapping:

| Source | Raw value | Label key | Color today |
|---|---|---|---|
| offline overlay | `queued` | `tx_status_offline_queued` | `colors.info` |
| offline overlay | `posting` | `tx_status_offline_sending` | `colors.info` |
| offline overlay | `rejected` | `tx_status_offline_rejected` | `colors.error` |
| `WalletAction.status` | `completed` | `tx_status_confirmed` | `colors.success` |
| | `unproven` | `tx_status_accepted` | `colors.success` |
| | `sending` | `tx_status_broadcasting` | `colors.success` |
| | `nosend` | `tx_status_not_sent` | `colors.warning` |
| | `unsigned` | `tx_status_unsigned` | `colors.warning` |
| | `nonfinal` | `tx_status_nonfinal` | `colors.warning` |
| | `failed` | `tx_status_failed` | `colors.error` |
| | *default* | raw string | `colors.textSecondary` |

Rendered at `app/transactions.tsx:249–253` as a filled pill: `backgroundColor: status.color + '20'` (12.5% alpha), text `status.color` at 12/500.

Related derived state: `ABORTABLE_STATUSES = {unsigned, nosend, nonfinal}` (`:31`), and `canRefresh = !canAbort && status !== 'completed' && !!txid` (`:240`).

### 6.2 The problem

**Every row wears a tinted pill.** In a healthy wallet, ~95% of rows are `completed`/`unproven`, so ~95% of the list is green pills. The eye adapts to green as the background texture, and the one amber row that actually needs the user is fighting a wall of chroma for attention. Green is being spent on the case that needs no attention at all.

Secondary problem: `sending` is mapped to `colors.success` (`:53`) alongside `completed` and `unproven`, so "still broadcasting" and "confirmed on chain" are the same color.

### 6.3 The model

Collapse eleven raw states into **four intents**, and give chroma only to the three that are not "fine".

| Intent | Raw states | Treatment | Reads as |
|---|---|---|---|
| **Settled** — nothing to do | `completed`, `unproven` | `typography.footnote`, `colors.textTertiary`, **no dot, no pill** | quiet gray text |
| **In flight** — wait | `sending`, offline `queued`, offline `posting` | 6pt dot + `typography.footnote`, both `colors.info` | one blue dot |
| **Needs you** — act | `nosend`, `unsigned`, `nonfinal` | 6pt dot + `typography.footnote`, both `colors.warning` | one amber dot |
| **Failed** — attend | `failed`, offline `rejected` | 6pt dot + `typography.footnote`, both `colors.error` | one red dot |
| *unknown* | anything else | raw label, `colors.textSecondary`, no dot | — |

**Labels are unchanged.** Every `tx_status_*` translation key stays exactly as it is, across all locales. Only the *rendering* of the returned `color` changes: the filled pill becomes a dot + colored text, and the Settled bucket forfeits its color.

`sending` moves from `success` to `info`, which is the one semantic correction: it is in flight, not done.

Implementation: `getStatusInfo` gains a third field rather than being rewritten —

```ts
type StatusInfo = { label: string; color: string; tone: 'settled' | 'flight' | 'attention' | 'failed' | 'unknown' }
```

`TransactionRow` renders the dot only when `tone !== 'settled' && tone !== 'unknown'`, and picks the text color as `tone === 'settled' ? colors.textTertiary : status.color`.

### 6.4 Row anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│ Coffee at Ada's                                       −4,200 sats   │  ← body/textPrimary  ·  body/600/tabular-nums
│ Confirmed                                        [⧉]      [↗]       │  ← footnote/textTertiary  ·  32×28 hit areas
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Invoice #22                                        +180,000 sats    │
│ ● Not sent                                    [↻]  [⧉]      [↗]     │  ← 6pt dot + footnote, both colors.warning
└─────────────────────────────────────────────────────────────────────┘
```

Structure and hit areas are the existing `app/transactions.tsx:410–454` styles, preserved. Only `statusBadge`/`statusText` (`:428–436`) are replaced by `statusDot` + `statusLabel`.

Accessibility: a dot alone is not a status. The colored **text label** is always present beside it, so the information survives color-blindness and grayscale. Add `accessibilityLabel={`${description}, ${status.label}, ${amountText}`}` on the row.

---

## 7. Taps-to-outcome

All counts start from a loaded web page. Tap 1 is always the ⋯ address-bar menu (`components/browser/AddressBar.tsx`, `menuPopoverOpen`); tap 2 is always the Wallet item (`onSettings` → `:1123`).

| Outcome | Today | Proposed | Δ |
|---|---|---|---|
| **Send a payment** | 4 — ⋯ · Wallet · *Payments* row · a `/pay` cell | 4 — ⋯ · Wallet · **Payments button** · a `/pay` cell | **0** |
| **Check whether a tx confirmed** | 3 — ⋯ · Wallet · *Transactions* row (+ a full push animation) | **2** — ⋯ · Wallet (list is already there) | **−1** and one fewer screen transition |
| **Open the vault** | 3 — ⋯ · Wallet · *Vault* row | 3 — ⋯ · Wallet · **Vault button** | **0** |
| **Export transactions** | 4 — ⋯ · Wallet · *Transactions* row · header ⤓ icon | **3** — ⋯ · Wallet · **Export CSV** | **−1** |
| Vault deposit | 4 — ⋯ · Wallet · Vault · Deposit → *sheet* | 4 — ⋯ · Wallet · Vault · Deposit → *route* | 0 |
| Open Settings | 3 — ⋯ · Wallet · Settings row | 3 — ⋯ · Wallet · **Settings button** | 0 |

**Being honest about the payments number: it does not drop.** `/pay` is reached in three taps today and three taps after. What changes is *target acquisition*, not tap count: Payments stops being the middle of three visually identical 44pt rows and becomes a filled, high-contrast, ~110pt-wide button at a fixed position. Fitts's law, not arithmetic. Any claim of a tap saving here would be false.

The genuine wins are (a) reviewing activity — the brief's stated second goal — where a whole screen push disappears, and (b) export, which stops being a bare icon buried in a screen the user has to know to open first.

---

## 8. Implementation plan

Ordered. Each step compiles on its own.

### 8.1 Extract the shared transaction machinery

**NEW `hooks/useTransactions.ts`** — lift, unmodified, from `app/transactions.tsx:27–232`: `PAGE_SIZE`, `ABORTABLE_STATUSES`, `fetchActions`, `fetchOfflineRows`, the mount effect, `loadMore`, `onRefresh`, `handleCopyRawTx`, `handleAbort`, `handleRefreshProof`, `handleExport`. Return `{ actions, totalActions, loading, loadingMore, refreshing, offlineByTxid, copyingTxid, abortingTxid, refreshingTxid, exporting, loadMore, onRefresh, handleCopyRawTx, handleAbort, handleRefreshProof, handleExport }`.
Do **not** move `handleExplorerLink` (`:145–161`) — it is navigation-shaped and screen-specific. See 8.2.

**NEW `components/wallet/TransactionRow.tsx`** — lift `renderItem` (`app/transactions.tsx:234–319`) into a memoised component. Apply §6.3 (dot + tone) and §5.1 (tabular-nums, no icon tiles). Props: `{ item, offline, onCopy, onAbort, onRefreshProof, onExplorer, copyingTxid, abortingTxid, refreshingTxid }`.

**NEW `utils/txStatus.ts`** — move `getStatusInfo` (`app/transactions.tsx:33–60`) here and add the `tone` field (§6.3). Keep every translation key untouched.

### 8.2 Create the wallet screen

**NEW `app/wallet.tsx`.**
1. Copy the balance block from `app/settings.tsx:15–104` and `:148–166` verbatim — the per-network cache is correct and better than `components/wallet/Balance.tsx`'s.
2. Adopt the safe-area skeleton of §1.4. **The root `View` must be `{ flex: 1, ... }`.** `app/settings.tsx:91` deliberately has **no** `flex: 1` because `Sheet`'s `fitContent` measures content height; carrying that over collapses the `FlatList` to zero height. This is the single easiest bug to ship here.
3. Header: back chevron → `router.back()`, title `t('wallet')` (**new key, all locales** — see 8.9), 44pt spacer trailing.
4. `ListHeaderComponent`: balance block (web2-gated), three-button row, `ACTIVITY` / `Export CSV` row, hairline.
5. `useTransactions()` for the list; `TransactionRow` for `renderItem`.
6. `handleExplorerLink`: copy `app/transactions.tsx:145–161`. **Keep the `router.canGoBack() ? router.back() : router.replace('/')` shape and its comment** — the comment at `:156–160` documents that `push('/')` stacks a second Browser instance. Drop the `sheet.close()` call and the `useSheet` import: `SheetProvider` is mounted inside `app/index.tsx:1676` and does not wrap pushed routes, so `useSheet()` here would return the no-op default context.
7. `ListFooterComponent`: `<View style={{ height: insets.bottom + 40 }} />` (matches `app/transactions.tsx:347`).

### 8.3 Fix the shared `ListRow` icon contrast

**MODIFY `components/ui/ListRow.tsx:41`.** The glyph is hardcoded `color="#FFFFFF"` while the tile is `iconColor || colors.accent`; in dark mode `accent` is `white`, so the glyph vanishes. Add an `iconTint?: string` prop defaulting to `'#FFFFFF'`, and change the tile default from `colors.accent` to `colors.textSecondary`. Verified live at `app/vault.tsx:225`; latent wherever `<ListRow icon=...>` omits `iconColor` (e.g. `app/connections.tsx:215,238`).

### 8.4 Restructure the vault screen

**MODIFY `app/vault.tsx`.**
- `:268` `content` → `{ paddingTop: spacing.lg, paddingBottom: spacing.xxxl }` (§2.3).
- `:275` `balanceBlock` → add `paddingHorizontal: spacing.lg`, `paddingVertical: spacing.xxl`.
- `:278` `actions` → add `paddingHorizontal: spacing.lg`, `marginBottom: spacing.xxl`.
- `:277` `balance` → add `fontVariant: ['tabular-nums']`.
- `:189` label → add `typography.footnote` uppercase treatment (already uppercase at `:276`; keep).
- `:213,215,216` Withdraw button → `backgroundColor: 'transparent'`, keep the hairline `colors.separator` border, icon + label `colors.textPrimary`.
- `:166–167` hero badge → `colors.fillTertiary` bg, `colors.textSecondary` icon.
- `:225` → `iconColor={colors.textSecondary}`; `:233` → `iconColor={colors.textSecondary}`; `:242` → `iconColor={colors.textSecondary}`.
- `:203–204` deposit → `router.push('/vault-transfer?direction=deposit')`; `:211–212` withdraw → `?direction=withdraw`.
- `:243` recover → `router.push('/vault-recover')`.
- Delete `:256–257` (`<TransferSheet/>`, `<RecoverSheet/>`), the `transfer`/`recovering` state (`:45,:46`), and their imports (`:23,:30`).
- Keep `runRecovery` (`:98–113`) — it moves to `app/vault-recover.tsx`. Keep `confirmDisable` (`:67–93`) in place.

### 8.5 Convert the two vault sheets to routes

**NEW `app/vault-transfer.tsx`** — reads `useLocalSearchParams<{direction: 'deposit'|'withdraw'}>()`; body is `components/vault/TransferSheet.tsx:76–103` verbatim; `run()` (`:38–67`) with `onClose()` → `router.back()` and `onComplete()` dropped (the vault screen's `useVaultBalance` already refreshes on `txStatusVersion`). Wrap in `KeyboardAvoidingView` (iOS `behavior="padding"`).

**NEW `app/vault-recover.tsx`** — same shape; body from `components/vault/RecoverSheet.tsx:51–77`; `runRecovery` moves here from `app/vault.tsx:98–113`, with the trailing `reload()`/`refresh()` replaced by `router.back()`.

**DELETE `components/vault/TransferSheet.tsx`** and **`components/vault/RecoverSheet.tsx`** once their bodies are moved.

**Keep `components/vault/VaultCeremonySheet.tsx`** and its mount at `app/_layout.tsx:138` (§0.3).

### 8.6 Retire the transactions route

**REPLACE `app/transactions.tsx`** with a redirect stub, matching the repo's existing pattern at `app/payments.tsx`:

```tsx
/**
 * Retired route. The transactions list is now inline on /wallet.
 * Kept as a redirect so old links and back-stack entries resolve.
 */
import { Redirect } from 'expo-router'
export default function RetiredTransactionsRoute() {
  return <Redirect href="/wallet" />
}
```

### 8.7 Retire the settings-as-wallet-menu component

**REPLACE `app/settings.tsx`** with `<Redirect href="/wallet" />`, same pattern. (Rather than deleting it — the file name is a plausible deep-link target via `redirectSystemPath`'s pass-through at `app/+native-intent.ts`, and a stub costs six lines.)

### 8.8 Rewire routing

**MODIFY `components/browser/SheetRouter.tsx`:**
- delete the `SettingsScreen` import (`:14`)
- delete `FIT_CONTENT_ROUTES` (`:46`), `isFitContent` (`:48`), and the `fitContent` prop (`:80`)
- delete the `{sheet.route === 'settings' && <SettingsScreen />}` branch (`:100`)

**MODIFY `context/SheetContext.tsx`:** remove `'settings'` from the `SheetRoute` union (`:12–22`).

**MODIFY `components/browser/AddressBar.tsx:1123`:** `onSettings={() => onOpenSheet('settings')}` → `onSettings={() => router.push('/wallet')}`. Verify the ⋯ popover closes on this path — `setMenuPopoverOpen(false)` already fires at `:358` and `:607`; confirm one of those covers this handler, and add it if not.
*(Optional, cleaner: keep the `onSettings` prop signature and do the `router.push` in `app/index.tsx` beside the existing `onConnections={() => router.push('/connections')}` at `:1626`, so `AddressBar` keeps zero navigation knowledge.)*

**MODIFY `app/_layout.tsx`:**
- add `<Stack.Screen name="wallet" />`, `<Stack.Screen name="vault-transfer" />`, `<Stack.Screen name="vault-recover" />`
- keep `<Stack.Screen name="transactions" />` (now the redirect stub)
- optionally add `<Stack.Screen name="settings" />` for the stub

### 8.9 Translations

**MODIFY `context/i18n/translations.tsx`** — add to **every** locale block (en / zh / hi / … — the file has one object per locale; there are existing keys at `:149` `settings`, `:151` `activity`, `:281` `you_have`, `:287` `transactions`):
- `wallet: 'Wallet'` — the new screen title
- `tx_export_csv: 'Export CSV'` — the wallet-screen export control

Reuse without change: `you_have`, `activity`, `payments` (`:450`), `vault_row_title` (`:159`), `settings` (`:149`), `no_transactions` (`:290`), every `tx_status_*`, `tx_export_success` (`:308`), `vault_balance_label` (`:164`), `vault_deposit_cta` (`:169`).

### 8.10 Resolve the two-exports collision

`app/wallet-config.tsx:541–548` already has a row labelled `t('export_wallet_data')` → `exportAllWalletDatabases` (`utils/exportDatabases.ts`) — a **full database dump**, entirely different from `utils/exportTransactions.ts` (a CSV of actions). Two things called "Export" one tap apart is a clarity regression, which is the opposite of the brief's goal.

**Resolution:** the wallet screen's control is labelled **"Export CSV"** (`tx_export_csv`). `wallet-config.tsx`'s row keeps `export_wallet_data` ("Export Wallet Data"). Different verbs, different screens, no ambiguity. No code change in `wallet-config.tsx`.

### 8.11 Optional cleanup (not required by the brief)

- **DELETE `components/wallet/Balance.tsx`** — zero references anywhere in the repo (verified). It also reads `colors.paperBackground`, a `ThemeContext`-only alias, and uses an un-network-keyed cache that would go stale across a network switch. Dead and slightly wrong.
- Extract the wallet balance fetch (`app/settings.tsx:15–88`) into `hooks/useWalletBalance.ts` to match `hooks/useVaultBalance.ts`.
- Replace `app/wallet-config.tsx`'s eleven ad-hoc icon hexes with tokens (§3.6.7).

### 8.12 File summary

| Action | Path |
|---|---|
| NEW | `app/wallet.tsx` |
| NEW | `app/vault-transfer.tsx` |
| NEW | `app/vault-recover.tsx` |
| NEW | `hooks/useTransactions.ts` |
| NEW | `components/wallet/TransactionRow.tsx` |
| NEW | `utils/txStatus.ts` |
| MODIFY | `app/vault.tsx` (padding fix, color fix, sheets → routes) |
| MODIFY | `app/_layout.tsx` (register `wallet`, `vault-transfer`, `vault-recover`) |
| MODIFY | `components/browser/SheetRouter.tsx` (drop the settings sheet) |
| MODIFY | `components/browser/AddressBar.tsx` (or `app/index.tsx`) — `onSettings` → route |
| MODIFY | `context/SheetContext.tsx` (drop `'settings'` from `SheetRoute`) |
| MODIFY | `components/ui/ListRow.tsx` (`iconTint`, safe default) |
| MODIFY | `context/i18n/translations.tsx` (`wallet`, `tx_export_csv` × all locales) |
| REPLACE→stub | `app/transactions.tsx`, `app/settings.tsx` |
| DELETE | `components/vault/TransferSheet.tsx`, `components/vault/RecoverSheet.tsx` |
| DELETE *(optional)* | `components/wallet/Balance.tsx` |
| UNTOUCHED | `app/pay.tsx`, `app/wallet-config.tsx` (except §8.10 = no change), `components/vault/VaultCeremonySheet.tsx`, `components/vault/EnrollWizard.tsx` |

---

## 9. Regression risks

1. **The zero-height list.** `app/settings.tsx:91` has no `flex: 1` on its root `View`, because `Sheet`'s `fitContent` (`components/ui/Sheet.tsx:193–200`) measures the child via `onLayout`. Carry that into a pushed route and the `FlatList` renders at height 0 — a blank screen below the buttons, with no error. **Highest-probability bug in this change.**

2. **Safe-area.** `app/settings.tsx` has zero inset handling today. The new screen needs `paddingTop: insets.top` on the container **and** `insets.bottom + 40` in `ListFooterComponent`. Missing the latter puts the last row under the home indicator; missing the former puts the header under the notch.

3. **Stacking a second Browser.** `app/transactions.tsx:156–160` carries a load-bearing comment: `router.push('/')` mounts a **second** `index`/Browser on top of the live one, and native-stack keeps both mounted — two concurrent Browser instances doubling all render work. The explorer-link path in `app/wallet.tsx` must keep `router.canGoBack() ? router.back() : router.replace('/')`. Carry the comment across.

4. **`useSheet()` outside `SheetProvider`.** `SheetProvider` wraps only the Browser (`app/index.tsx:1676–1680`). A pushed `/wallet` sits outside it, so `useSheet()` returns the module default whose `close` is a no-op (`context/SheetContext.tsx:28–36`) — silent, not a crash, but any logic depending on `sheet.close()` becomes dead. Drop the dependency rather than relying on the no-op.

5. **Warm WebView pool.** Net effect is favourable: today, opening Transactions from the wallet menu leaves Browser + an open `Sheet` + a pushed Transactions screen all mounted. After, it is Browser + one pushed Wallet screen. **But:** do not wrap anything in the wallet screen in `KeyboardAvoidingView` — the standing rule is that KAV must never wrap the warm WebView pool. The wallet screen has no text input, so it needs none. `app/vault-transfer.tsx` / `app/vault-recover.tsx` are separate pushed routes with their own trees and are safe.

6. **Back behaviour.** Today the wallet menu closes via backdrop tap, drag-down, or `sheet.close()` — never via the OS back gesture. As a pushed route it gains Android hardware back and iOS swipe-back, and loses drag-to-dismiss. Behaviourally correct, but it is a change in muscle memory worth device-testing. Note `Sheet`'s pan gesture uses `.failOffsetX([-25, 25])` (`components/ui/Sheet.tsx:105`) specifically to not fight horizontal swipes — that concern disappears with the sheet.

7. **Deep links.** `app/+native-intent.ts` passes unmatched paths straight through to Expo Router, so a bare `bsvbrowser://transactions` or `://settings` currently resolves. The redirect stubs in 8.6/8.7 preserve both. `peerpay:` links are unaffected (they target `/pay`, untouched). `hooks/useDeepLinking.ts` only ever pushes `/pay` and `/connections`.

8. **The offline-queue overlay.** `fetchOfflineRows` (`app/transactions.tsx:90–104`) reads `storage.sqliteDb` directly and is filtered by `walletUserId`. It must survive the move into `hooks/useTransactions.ts` with its `try/catch` intact — the in-code comment at `:101–103` states the overlay is advisory and a read failure must not break the list.

9. **Pull-to-refresh + pagination inside `ListHeaderComponent`.** `onEndReached` fires against the `FlatList`, which now contains a tall non-list header. Verify `onEndReachedThreshold: 0.3` still triggers on short lists where the header dominates the viewport; if it fires immediately on mount, guard `loadMore` with `offsetRef.current >= totalActions` (already present at `app/transactions.tsx:122`).

10. **`AmountDisplay` and negative values.** `AmountDisplay` rejects non-integers (`components/wallet/AmountDisplay.tsx`, `Number.isInteger` guard) but accepts negative integers. `formatSatoshisAsBsv` emits a `-` prefix (`utils/amountFormatHelpers.ts:137`); the **USD** path formats negatives as accounting parentheses `(…)` (`:39`). Verify the signed-amount rendering in both currency modes before shipping — a `(4,200)` where a `−4,200` was designed is a legibility surprise, not a bug.

11. **`txStatusVersion` fan-out.** Both the balance effect (`app/settings.tsx:82–88`) and the transactions effect (`app/transactions.tsx:106–119`) key off `txStatusVersion`. Co-locating them on one screen means one SSE status bump now triggers a `listOutputs` **and** a `listActions` on the same render pass. Previously these were on separate screens and only one was ever mounted. Watch for a JS-thread stall on the wallet screen after a payment lands; if it appears, stagger the two.

12. **i18n coverage.** `context/i18n/translations.tsx` holds one object per locale. Adding `wallet` and `tx_export_csv` to only the `en` block leaves other locales falling back to the raw key string on screen.
