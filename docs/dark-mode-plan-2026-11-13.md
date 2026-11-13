# Dark mode: plan (13 November 2026)

A plan, not a change: no code moves with it. AX274 (vision) asks for a dark mode; Marktmorgen has none today (no `prefers-color-scheme` rule anywhere in `app/globals.css`). The creator's store already has a dark theme of its own (`night`, chosen by the creator in `lib/store-look.ts`). Everything below was counted on `main` on 13 November 2026.

## 1. What colours the site and the studio use today

Colours come from 40 tokens on `:root` in `app/globals.css`, read as Tailwind colours (`bg-ink`, `text-ink-soft`…) or as `var(--…)`. A dark mode can switch them all at once, without touching a component, as long as nothing is written outside them.

| Token | Light value | Uses |
| --- | --- | ---: |
| `--ink-soft` | `#343d4a` | 2570 |
| `--ink` | `#111827` | 1662 |
| `--line` | `#e2ded4` | 717 |
| `--paper` | `#f7f5f0` | 365 |
| `--violet-deep` | `#3b3890` | 288 |
| `--ink-mute` | `#394150` | 229 |
| `--sand` | `#efece5` | 132 |
| `--danger` | `#c2261f` | 119 |
| `--lilac` | `#ecebf7` | 101 |
| `--line-strong` | `#cbc5b8` | 49 |
| `--mint-deep` | `#0b6a4d` | 39 |
| `--violet` | `#4946a6` | 36 |
| `--danger-soft` | `#fdecea` | 36 |
| `--violet-ink` | `#2d2b6e` | 27 |
| `--mint-soft` | `#e5f6ef` | 23 |
| `--danger-text` | `#8e211b` | 21 |
| `--sand-deep` | `#e4e0d6` | 17 |
| `--on-dark` | `#ffffff` | 8 |
| `--night` | `#0b1119` | 5 |
| `--violet-lift` | `#9a97e0` | 5 |
| `--lilac-deep` | `#d9d8ef` | 5 |
| `--amber-soft` | `#fdf3e1` | 4 |
| `--line-off` | `#857f70` | 2 |
| `--navy` | `#111827` | 2 |
| `--coral` | `#4946a6` | 2 |
| `--mint-text` | `#07553e` | 2 |
| `--mint-lift` | `#6fe3ba` | 2 |
| `--amber` | `#8a4f00` | 2 |
| `--violet-glow` | `#cfc7f2` | 2 |
| `--navy-2` | `#1b2433` | 1 |
| `--navy-3` | `#26303f` | 1 |
| `--night-2` | `#1b2433` | 1 |
| `--sky` | `#4946a6` | 1 |
| `--sky-soft` | `#ecebf7` | 1 |
| `--sky-lift` | `#9a97e0` | 1 |
| `--pink` | `#4946a6` | 1 |
| `--mint` | `#15a37a` | 1 |
| `--amber-lift` | `#ffc77a` | 1 |
| `--focus` | `#4946a6` | 1 |
| `--gold` | `#c9a227` | 0 |

Outside the tokens, these do not follow a token and would stay light in a dark mode:

| Kind | Uses | Files |
| --- | ---: | ---: |
| `bg-white` | 280 | 121 |
| `text-black` | 210 | 12 |
| `text-white` | 84 | 24 |
| `text-white/…` | 38 | 13 |
| `bg-white/…` | 17 | 12 |
| `bg-ink` (dark band) | 13 | 8 |
| `border-white` | 8 | 7 |
| `bg-black` | 4 | 3 |
| `text-paper` | 2 | 1 |
| hex colours written in components | 69 | 26 |
| hex colours in `app/globals.css` outside `:root` | 77 | 1 |

Files with the most hex colours written out:

| File | Hex colours | Open PRs |
| --- | ---: | ---: |
| `components/logo.tsx` | 9 | 0 |
| `app/[handle]/certificate/[id]/opengraph-image.tsx` | 7 | 188 |
| `components/home-interactive.tsx` | 5 | 0 |
| `components/home-static.tsx` | 5 | 2 |
| `components/page-coach.tsx` | 4 | 0 |
| `components/mail-designer.tsx` | 4 | 2 |
| `components/google-signin.tsx` | 4 | 0 |
| `app/developers/checkout-script/page.tsx` | 4 | 1 |
| `app/studio/path/page.tsx` | 4 | 0 |
| `components/feature-visuals.tsx` | 3 | 1 |
| `components/post-cover.tsx` | 2 | 0 |
| `components/short-links.tsx` | 2 | 0 |
| `components/share-panel.tsx` | 2 | 188 |
| `app/developers/page.tsx` | 2 | 12 |
| `app/blog/[slug]/opengraph-image.tsx` | 2 | 1 |

## 2. Proposed tokens, light and dark, with contrast

Each pair is the text or edge colour on the surface it sits on, measured by the WCAG formula: 7:1 for text (1.4.6), 3:1 for a component's edge or the focus ring (1.4.11). The dark values are a proposal, picked to pass; the light values are today's.

| Pair | Needs | Light today | Dark proposed |
| --- | ---: | ---: | ---: |
| `ink` on `paper` | 7:1 | 16.28:1 | 16.63:1 |
| `ink` on `card` | 7:1 | 17.74:1 | 14.22:1 |
| `ink` on `sand` | 7:1 | 15.04:1 | 15.22:1 |
| `ink-soft` on `paper` | 7:1 | 10.08:1 | 13.07:1 |
| `ink-soft` on `card` | 7:1 | 10.98:1 | 11.18:1 |
| `ink-soft` on `sand` | 7:1 | 9.31:1 | 11.97:1 |
| `ink-mute` on `paper` | 7:1 | 9.42:1 | 11.84:1 |
| `ink-mute` on `card` | 7:1 | 10.26:1 | 10.12:1 |
| `ink-mute` on `lilac` | 7:1 | 8.70:1 | 9.32:1 |
| `violet-deep` on `paper` | 7:1 | 8.95:1 | 10.85:1 |
| `violet-deep` on `card` | 7:1 | 9.75:1 | 9.28:1 |
| `danger-text` on `danger-soft` | 7:1 | 7.70:1 | 9.50:1 |
| `mint-text` on `mint-soft` | 7:1 | 7.89:1 | 11.48:1 |
| `amber` on `amber-soft` | 7:1 | 5.97:1 **below** | 10.75:1 |
| `line-strong` on `paper` | 3:1 | 1.58:1 **below** | 3.81:1 |
| `line-strong` on `card` | 3:1 | 1.72:1 **below** | 3.26:1 |
| `focus` on `paper` | 3:1 | 7.11:1 | 10.85:1 |
| `focus` on `card` | 3:1 | 7.75:1 | 9.28:1 |

Dark values proposed:

| Token | Dark |
| --- | --- |
| `--paper` | `#121418` |
| `--sand` | `#1a1d23` |
| `--card` | `#1f232a` |
| `--line` | `#3a404b` |
| `--line-strong` | `#6b7280` |
| `--ink` | `#f5f3ee` |
| `--ink-soft` | `#dcd9d1` |
| `--ink-mute` | `#d2cfc6` |
| `--violet-deep` | `#c4c1fa` |
| `--danger-text` | `#ffb4ab` |
| `--danger-soft` | `#3b1513` |
| `--mint-text` | `#9cf0cf` |
| `--mint-soft` | `#0f2a22` |
| `--amber` | `#ffcf8a` |
| `--amber-soft` | `#2e2210` |
| `--lilac` | `#26254a` |
| `--focus` | `#c4c1fa` |

Two light pairs are below their mark today and are worth checking on their own, dark mode or not:
- `--amber` on `--amber-soft`, 5.97:1: below 7:1 wherever amber words sit on the amber band (today the studio mostly uses Tailwind's `text-amber-900` on `bg-amber-50` instead; each use needs measuring).
- `--line-strong` on `--paper`, 1.58:1: below 3:1 where that edge is the only thing that shows a control (42 uses; fields use their own border and the focus bands).

## 3. The creators' stores

A store already has four themes, one of them dark (`night`), and the creator's own accent colour; `lib/store-look.ts` mixes the accent so its button words stay readable, and the store pages already follow the creator's theme, not the visitor's system. Two ways, for the owner to choose:
- **The store stays as its creator set it.** The visitor's dark setting changes the site and the studio, not a store. Simplest, and true to the creator's choice; a visitor who needs dark gets it only on stores whose creator picked `night`.
- **A store also follows the visitor's setting**, by showing `night` to a visitor who asked for dark. The accent must then pass 7:1 for its words and 3:1 for its edges on `night` as well, for every accent a creator can type (`HEX_PATTERN`): the same mixing `lib/store-look.ts` does for `night` today, applied to every store. The studio's preview would show both.

## 4. Order of work, in small units

1. The dark token values on `:root` under `@media (prefers-color-scheme: dark)` and a `data-theme` switch, with a test that measures every pair of section 2 in both themes. Nothing else changes, so nothing looks different in light.
2. `color-scheme: light dark` on `html`, so form fields, scroll bars and the browser's own controls follow.
3. The site's shared parts (header, footer, `.btn`, `.card`, `.field`, `.notice`): replace `bg-white` and the other fixed colours there with tokens (a `--card` token for white surfaces).
4. The studio, a few files at a time, starting with files no open pull request touches; then the public pages; the creator's store last, after the owner's decision in section 3.
5. Pictures and illustrations drawn for a light page (logos, `feature-visuals.tsx`): checked one by one; some need a dark version.
6. A browser test per unit that opens its pages in both themes and measures text and edges, beside the forced-colors tests already there.

## 5. What collides with open pull requests

`app/globals.css` was changed by 20 open pull requests on 13 November 2026, so step 1 adds new blocks without editing existing lines. Before each unit of step 4, check the file against the open pull requests (rules MV and PV); the counts in section 1 are a guide only.

## 6. Decisions for the owner

1. Is dark mode wanted now, given its size (step 4 touches most of the studio's 150-odd components)?
2. Do creators' stores follow the visitor's dark setting (section 3), or stay as the creator set them?
3. Is there a switch on the site (light, dark, as the system), or only the system's setting?
4. The light pairs below their mark (section 2): fix them now, apart from dark mode?
