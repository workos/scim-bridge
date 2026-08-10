# `app/ui` — the panel's local component layer

Everything the panel renders comes from public [`@radix-ui/themes`](https://www.radix-ui.com/themes),
imported directly at the call site. This directory holds only the handful of
pieces Radix does not provide, so that the import list in a route file tells you
honestly which components are third-party and which are ours.

It replaced `app/vendor/design-system` — 470 files copied out of the WorkOS
monorepo, of which 299 were a _modified_ fork of `@radix-ui/themes`, a package
already in `package.json`. Beyond publishing internal source in a repo that is about
to go public, the vendored CSS declared `@font-face` rules pointing at
`https://cdn.workos.com/fonts/*`, so opening the panel of a
_self-hosted_ bridge made live requests to a WorkOS CDN. Fonts are now served
from the bridge itself; see `app/theme.css`.

## What lives here, and why Radix can't supply it

| module             | why it is local                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `badge.tsx`        | adds the `white` pseudo-colour and `lowContrast`, which map onto Radix's `gray` + `variant` |
| `button.tsx`       | adds `loading` and `ghost`, and the `type={null}` escape hatch for `asChild` anchors        |
| `status.tsx`       | a coloured dot beside a label — no Radix equivalent                                         |
| `empty-state.tsx`  | `title`/`subtitle` placeholder block — no Radix equivalent                                  |
| `dialog.tsx`       | `Header`/`Body`/`Footer` composites over Radix's `Dialog`                                   |
| `alert-dialog.tsx` | `Header`/`Footer` composites over Radix's `AlertDialog`                                     |

Everything else — `Box Callout Card Checkbox Code Flex Grid Heading Link
RadioCards Select Separator Switch TabNav Table Text TextArea TextField Theme` —
is imported straight from `@radix-ui/themes`.

## Deliberately not reproduced

This is not a port of the WorkOS design system, and the panel is not meant to
look like WorkOS's admin UI — it runs inside a customer's infrastructure. Two
concrete losses, both accepted:

- **Table sticky header / sticky first column / roving-focus keyboard nav.** The
  vendored `Table.Content` implemented these with `ResizeObserver`s and a custom
  roving-focus group. Radix's `Table.Root` scrolls horizontally but does not pin
  the header. The `Table.Content` layer is gone from the call sites with it.
- **WorkOS's brand accent, gray ramp, and Untitled Sans.** The theme is now
  Radix's own `indigo`/`slate` with Geist.
