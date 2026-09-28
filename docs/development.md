# Development Guide

> Conventions and patterns for working in nuri-expo. Read this before writing code.

---

## Rules (Read First)

These are non-negotiable. Every agent and developer must follow them.

### Use existing components -- never inline UI primitives

| Need | Use this | Never this |
|------|----------|------------|
| Text | `<Body>`, `<BodyBold>`, `<H1>`-`<H4>`, `<Caption>`, `<Subtitle>` from `components/typography.tsx` | Raw `<Text style={...}>` |
| Button | `<Button>` or `<IconButton>` from `components/` | Raw `<TouchableOpacity>`, `<Pressable>` for buttons |
| Text input | `<InputField>` or `<AmountInput>` | Raw `<TextInput>` |
| Loading | `<Spinner>` from `components/Spinner.tsx` | Raw `<ActivityIndicator>` |
| Modal | `<ModalSheet>` + `<ModalHeaderWithCloseButton>` | Raw `<Modal>` |
| Layout | `<Row>`, `<Section>`, `<KeyValueRow>`, `<Divider>` from `components/layout.tsx` | Ad-hoc `<View style={{ flexDirection: 'row' }}>` for common patterns |
| Colors | `COLORS.*` from `designSystem.ts` | Hex literals (`"#FF0000"`) |
| Font sizes | `FONT_SIZES.*` from `designSystem.ts` | Raw numbers (`fontSize: 14`) |
| Border radius | `RADIUS.*` from `designSystem.ts` | Raw numbers (`borderRadius: 12`) |
| Typography styles | `TYPOGRAPHY.*` from `designSystem.ts` | Raw `fontFamily` strings |

If a component doesn't exist for what you need, **create it in `components/`** -- don't inline it in a screen file. One-off UI that only one screen uses can live in `screens/<domain>/components/`.

### Put things where they belong

| Thing | Location | Not here |
|-------|----------|----------|
| Reusable component | `components/<Name>.tsx` | Inline in a screen file |
| Screen-specific component | `screens/<domain>/components/<Name>.tsx` | Inline in the screen file |
| Screen-specific hook | `screens/<domain>/hooks/use<Name>.ts` | Top of the screen file |
| Shared hook | `lib/use<Name>.ts` | In a screen file or component file |
| Business logic / service | `services/<domain>/<Name>Service.ts` | In a screen file |
| Utility function | `lib/<name>.ts` | Top of a screen or component file |
| Types | `types/<domain>.ts` | Inline in a screen file |
| Constants | `config/constants.ts` or `config/endpoints.ts` | Hardcoded in a screen or service |
| Styles | `StyleSheet.create()` at bottom of the file, or `screens/<domain>/<Screen>.styles.ts` for large screens | Inline `style={{...}}` (except dynamic values) |

### Don't

- Don't define a helper function at the top of a screen file -- if it's reusable, it belongs in `lib/`. If it's screen-specific logic, extract it to a hook in `screens/<domain>/hooks/`.
- Don't define types/interfaces inside screen files -- put them in `types/<domain>.ts`.
- Don't put hooks inside component files -- hooks belong in `screens/<domain>/hooks/` or `lib/`.
- Don't hardcode colors, font sizes, border radii, or font families -- use design tokens.
- Don't use `AsyncStorage` for anything -- use `lib/secureKeyStorage.ts` for secrets, service-level caching for the rest.
- Don't add npm dependencies without approval.
- Don't create abstraction layers for one-off operations.
- Don't modify `designSystem.ts` without approval.
- Don't let screen files grow -- if a screen file is getting large, extract hooks and components into their colocated folders.
- Don't duplicate -- before creating anything, search if it exists already.

### Before writing any code, check

1. Does a component for this already exist in `components/`?
2. Does a utility for this already exist in `lib/`?
3. Does a service for this already exist in `services/`?
4. Does a type for this already exist in `types/`?
5. Is there a design token for this value in `designSystem.ts`?

If yes, use it. If no, create it in the right place -- not inline.

---

## Components

### Creating a new component

1. File location: `components/<ComponentName>.tsx`
2. Naming: PascalCase, one component per file
3. Props: typed interface, `React.FC<Props>`
4. `StyleSheet.create()` at the bottom of the file
5. No inline styles except dynamic values

### Typography

Always use components from `components/typography.tsx`:

- `<Body>`, `<BodyBold>` -- standard text (16px)
- `<H1>`, `<H2>`, `<H3>`, `<H4>` -- headings (64/40/32/24px)
- `<Caption>`, `<CaptionBold>` -- small text (12px)
- `<Subtitle>`, `<SubtitleBold>` -- secondary text (14px)
- `<TextLink>` -- tappable text link
- `<DisplayHeadline>` -- large display text

Never use raw `<Text style=` in screen files.

### Layout

Always use components from `components/layout.tsx`:

- `<Row>` -- horizontal flex container with gap
- `<Section>` -- vertical section with optional title
- `<KeyValueRow>` -- label + value row
- `<Divider>` -- horizontal separator

Never build raw flex containers for these patterns.

### Inputs

- `<AmountInput>` (`components/AmountInput.tsx`) -- currency/amount fields with formatting
- `<InputField>` (`components/InputField.tsx`) -- form text fields with label and validation
- Never use raw `<TextInput>`

### Buttons

- `<Button>` (`components/Button.tsx`) -- standard button, multiple variants and sizes
- `<IconButton>` (`components/IconButton.tsx`) -- round icon button with optional label
- Never use raw `<Pressable>` or `<TouchableOpacity>` for buttons

### Loading

- `<Spinner>` (`components/Spinner.tsx`) -- unified loading indicator
- Variants: `pending` (green), `loading` (purple), `overlay` (white), `button` (dark), `buttonDark` (white)
- Never use raw `<ActivityIndicator>`

### Modals

- `<ModalSheet>` (`components/ModalSheet.tsx`) -- bottom sheet with option list
- `<ModalHeaderWithCloseButton>` (`components/ModalHeaderWithCloseButton.tsx`) -- modal header
- Never use raw `<Modal>`

---

## Design System

All tokens are in `designSystem.ts`. Never hardcode visual values.

### Colors

Only `COLORS.*` from designSystem. Never hex literals in screen or component files.

```ts
import { COLORS } from "../designSystem";
// COLORS.BACKGROUND, COLORS.TEXT, COLORS.BUTTON_PRIMARY, COLORS.BUTTON_ACCENT, etc.
```

### Font sizes

Only `FONT_SIZES.*`. Never raw numbers.

```ts
FONT_SIZES.CAPTION    // 12
FONT_SIZES.BODY_SMALL // 14
FONT_SIZES.BODY       // 16
FONT_SIZES.BUTTON_XL  // 20
FONT_SIZES.H4         // 24
FONT_SIZES.H3         // 32
FONT_SIZES.H2         // 40
FONT_SIZES.H1         // 64
```

### Border radius

Only `RADIUS.*`. Never raw numbers.

```ts
RADIUS.PILL   // 100 (buttons)
RADIUS.CARD   // 24  (cards, modals)
RADIUS.INPUT  // 12  (inputs)
RADIUS.BADGE  // 9   (badges)
RADIUS.SMALL  // 8   (small elements)
```

### Typography styles

Only `TYPOGRAPHY.*` in StyleSheets. Never raw fontFamily strings.

```ts
TYPOGRAPHY.body, TYPOGRAPHY.bodyBold
TYPOGRAPHY.headline, TYPOGRAPHY.headlineThin
TYPOGRAPHY.label, TYPOGRAPHY.button
TYPOGRAPHY.caption, TYPOGRAPHY.captionBold
TYPOGRAPHY.subtitle, TYPOGRAPHY.subtitleBold
```

### Spacing

`SPACING.*` tokens where they exist: `xs(4)`, `sm(8)`, `md(12)`, `lg(16)`, `xl(20)`, `xxl(24)`, `xxxl(32)`, `huge(40)`, `giant(48)`.

---

## Hooks

- **Screen-specific hooks** go in `screens/<domain>/hooks/`
- **Shared hooks** go in `lib/`
- Pattern: options-object-in, return-object-out
- Max 5 `useState`, max 3 `useEffect` per hook -- if more, split

```ts
// Good pattern
export function useCardBalance({ safeAddress, currency }: Options) {
  // ... state, effects, callbacks
  return { balance, isLoading, refresh };
}
```

---

## Services

- Singletons in `services/<domain>/`
- Domain folders:

| Domain | Purpose |
|--------|---------|
| `auth/` | Auth state, passkeys, PRF wallet bootstrap |
| `bitcoin/` | Blockchain, wallet, signing, PSBT |
| `arkade/` | Arkade wallet, NWC, remote signer |
| `near/` | NEAR intent swaps |
| `balance/` | Balance caching, reconciliation, transactions |
| `pricing/` | BTC/EUR prices, FX rates |
| `wirex/` | Wirex card, smart account, SEPA |
| `base/` | EURC token transfers on Base |
| `nostr/` | Nostr messaging, unread sync |
| `logging/` | Network logger, debug log buffer |
| `support/` | Support dump, welcome email |
| `events/` | AppEventBusService |
| `app/` | App update, factory reset, server config, Apple Pay |

---

## Types

- Domain types in `types/<domain>.ts` (`bitcoin.ts`, `card.ts`, `wallet.ts`, `near.ts`, `mercuryo.ts`, `debug.ts`)
- Shared types in `types/shared.ts`
- Never define types inline in screen files

---

## Constants

- App constants (poll intervals, pubkeys, timeouts) in `config/constants.ts`
- API endpoints in `config/endpoints.ts`
- Never hardcode these values in screen files

---

## Environment Variables

- Use `.env` for API keys
- `EXPO_PUBLIC_*` prefix only for values safe to expose to the client bundle
- Never commit secrets

---

## Adding New Features (Plug-and-Play Architecture)

Every new feature or integration must be **plug-and-play**: self-contained, feature-flagged, and removable without touching unrelated code. Nothing should be deeply wired into a screen unless it's core to that screen's purpose.

### The Problem

Today, features like Mercuryo (buy bitcoin) and NEAR swaps each add logic, state, modals, and buttons directly into screen files. Disabling one means hunting through multiple screens to comment out scattered code. This doesn't scale.

### The Target

A feature is a **module** that:
1. Lives in its own domain folder
2. Gates behind a feature flag
3. Communicates with screens through a defined interface (EventBus events + a contribution registry)
4. Can be disabled by flipping one flag -- no other code changes needed

### Feature Module Structure

```
services/<domain>/
  <Domain>Service.ts          # Business logic singleton
  <Domain>Contributions.ts    # What this feature contributes to screens (see below)

screens/<domain>/
  modals/                     # Feature-specific modals
  hooks/                      # Feature-specific hooks (if it has its own screen)
  components/                 # Feature-specific UI

types/<domain>.ts             # Feature types
config/endpoints.ts           # Feature API endpoints (add here, not inline)
lib/featureFlags.ts           # Feature flag definition
```

### Contribution Registry (Strategy)

Screens should not import feature code directly. Instead, features **register contributions** that screens consume generically. This is the interface that makes plug-and-play work.

**What a feature can contribute to a screen:**

| Contribution | Example | How it plugs in |
|-------------|---------|-----------------|
| Action button | "Buy Bitcoin" on BitcoinScreen | Feature registers an action button spec; screen renders all registered buttons |
| Balance line item | NEAR swap pending balance | Feature emits balance data via EventBus; screen listens and renders |
| Status indicator | Pending swap progress | Feature emits status events; FloatingTransactionStatus renders them |
| Section | IBAN details on WalletScreen | Feature registers a section component; screen renders it in a slot |

**Implementation pattern:**

```ts
// services/mercuryo/MercuryoContributions.ts
import { registerActionButton } from "../../lib/screenContributions";
import { isFeatureEnabled } from "../../lib/featureFlags";

export function init() {
  if (!isFeatureEnabled("F_MERCURYO")) return;

  registerActionButton("bitcoin", {
    id: "mercuryo-buy",
    label: "Buy",
    icon: "cart",
    onPress: () => EventBus.emit("mercuryo:openBuyModal"),
    order: 3,
  });
}
```

```ts
// In BitcoinScreen — generic, not feature-specific
const actionButtons = useActionButtons("bitcoin");
// Renders whatever buttons are registered for this screen
```

### Screen Extension Points (Slots)

Screens expose **named slots** where features can inject UI:

| Screen | Slot | Purpose |
|--------|------|---------|
| BitcoinScreen | `actionButtons` | Send, Receive, Buy, Swap buttons |
| BitcoinScreen | `statusOverlay` | Pending transaction status |
| CardScreen | `actionButtons` | Top up, Send, Freeze buttons |
| CardScreen | `sections` | IBAN section, limits section |
| WalletScreen | `actionButtons` | Send, Receive, Bridge buttons |
| WalletScreen | `sections` | Currency list, IBAN details |

The slot system doesn't exist yet. It needs to be built as the next architectural step. The pattern:

1. `lib/screenContributions.ts` -- registry where features register their contributions
2. `useSlot(screenId, slotName)` -- hook that screens call to get registered contributions
3. Features call `registerXxx()` during their service init
4. Feature flag off = init doesn't run = nothing registered = slot is empty

### Feature Flag Contract

Every new feature gets a flag in `lib/featureFlags.ts`:

```ts
"F010_Mercuryo_buyBitcoin"
"F011_Near_oneClickSwap"
```

The flag gates the feature's `init()`. When disabled:
- No contributions registered (buttons, sections, modals don't appear)
- No EventBus listeners registered (no background processing)
- No network requests made
- Screen code unchanged -- it just renders an empty slot

### Adding a New Feature -- Checklist

1. **Create the feature flag** in `lib/featureFlags.ts`
2. **Create the service** in `services/<domain>/` -- business logic only, no UI
3. **Create types** in `types/<domain>.ts`
4. **Create the contributions file** -- registers what the feature adds to which screens
5. **Create modals/components** in `screens/<domain>/` -- feature-specific UI
6. **Register the feature's init** in the app startup (App.tsx or a feature registry)
7. **Add endpoints** to `config/endpoints.ts` (not hardcoded in service files)
8. **Add i18n keys** to `lib/i18n/en.ts` + `lib/i18n/de.ts`
9. **Test with flag off** -- the app must work identically with the flag disabled

### What NOT to do

- Don't import feature modals directly in screen files -- use EventBus to trigger them
- Don't add feature-specific state (`useState`) to screen files -- put it in a hook in the feature's domain folder
- Don't add feature-specific conditions (`if (hasMercuryo)`) scattered through screen render functions -- use the contribution registry
- Don't hardcode API URLs in service files -- use `config/endpoints.ts`
- Don't skip the feature flag -- every feature must be independently disableable

### Migration Path

Existing features (Mercuryo, NEAR) are currently deeply integrated. They should be migrated to this pattern incrementally:

1. Build `lib/screenContributions.ts` (the registry + hooks)
2. Start with one feature (e.g., Mercuryo -- smallest surface area)
3. Extract its screen integrations into a contributions file
4. Verify it can be cleanly disabled via flag
5. Repeat for NEAR

---

## The Golden Rule

Never duplicate. Before creating anything, search if it exists. If two files need the same function, component, type, constant, or style -- it belongs in a shared location (`lib/`, `components/`, `types/`, `config/`), not inline.
