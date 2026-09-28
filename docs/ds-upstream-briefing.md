# DS upstream briefing — changes reverted from `ds/` on 2026-07-16

Context: merging `wf/773-wirex-phase-1-new-user-kyc-smart-account` (carries a
fresh DS import) into `feat/arkade-vhtlc-phase-2`. Decision (Emin): the app
repo never modifies the imported `ds/` tree. The four local DS edits this
branch had accumulated were reverted to the imported state and are documented
here so they can be made properly in the upstream design system
(`nuri-design-system`), then arrive via the next ds-pull.

## 1. TextField: `actionVariant` axis

Files: `internal/spec/components/text-field.ts`,
`internal/rn/generated/components/text-field.ts`

The inline action button of TextField was hardcoded to `variant: 'soft'`. We
added an axis so a screen can request a solid (accent-taking) action button:

- spec: `TextFieldAxes = { actionVariant: 'soft' | 'solid' }`, button variant
  becomes `'$axis.actionVariant'`, `variants: { actionVariant: { soft: {},
  solid: {} } }`, `defaults: { actionVariant: 'soft' }`, `api.axes:
  ['actionVariant']`.
- generated RN: `actionVariant?: 'soft' | 'solid'` prop, wired into the
  selection map with default `"soft"`.

Wanted by: NostrChatModal composer (solid orange send/share affordance).

## 2. TextField: optional `label` slot

Same files. The imported DS throws at runtime when a TextField renders
without a `TextFieldLabel` (`nuri-factory: 'TextField' requires Label`). For
compact composers (chat input) a label is visual noise; we made the slot
optional:

- spec: `label: { part: 'label', kind: 'text', component: true }` (dropped
  `required: true`).
- generated RN: deleted the `requires Label` throw.

Interim app state: every TextField keeps a label (the chat composer reuses
its placeholder copy as the label).

## 3. Icons: `wallet-eth`

File: `internal/rn/generated/data/icons.ts`

New icon `wallet-eth` (wallet with an Ethereum glyph) for the wallet tab.
Emin's asset; the 24-grid source was shifted into the DS 32 viewBox via
`<g transform="translate(4 4)">`. Full SVG paths live in this branch's
history: `git show 3e6453d7:ds/nuri/internal/rn/generated/data/icons.ts`
(search `wallet-eth`).

Interim app state: `App.tsx` wallet tab falls back to the `wallet` icon.

## 4. Text primitive: `onPress` + `accessibilityRole`

File: `internal/rn/primitives/Text.tsx`

DS Text forwards neither `onPress` nor `accessibilityRole` to RNText, so
tappable inline text (links in chat bubbles) can't be built from the DS
alone. We added both props as straight pass-throughs.

Interim app state: `components/ChatBubble.tsx` wraps the link's DS Text in an
unstyled RN `Text` that carries `onPress`/`accessibilityRole="link"`. Remove
the wrapper once the DS ships the props.

---

Once all four land upstream and a ds-pull imports them, revert the three
interim app patches (labels stay — they're fine either way).
