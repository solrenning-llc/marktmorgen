# Studio email editor accessibility proof

Scope: `app/studio/email/page.tsx`, `components/email-studio.tsx`, and
`components/mail-designer.tsx`, read-only while pull request #1927 owns the
email studio component.

## Durable RED

Run:

```sh
node tests/e2e/p-email-studio-accessibility.mjs --source-red
```

The current product has three focus-order failures:

1. Opening a saved draft remounts the composer and scrolls it into view, but
   leaves focus on the `Open` button below it.
2. Opening a new or saved sequence inserts a long editor without moving focus
   to its first field.
3. Closing that editor removes the focused button without restoring focus to
   the `New sequence` or `Edit` button that opened it.

The RED mode has no dependency or network IO. It reads one bounded local source
file and records the three absent focus contracts before any product repair.

## Browser contract after the owning PR clears

The default mode is a focused synthetic Chromium journey. It uses the local
stand-in Redis and provider services, one 390 by 900 viewport, and no real
account, provider, email, payment, or personal data. It must verify:

- the initial email studio and the open sequence editor have no axe-core
  WCAG 2.2 A/AA violations;
- a real keyboard activation of `Open` moves visible focus to the subject;
- a real keyboard activation of `New sequence` moves visible focus to the
  first field;
- Tab follows to `Starts when`;
- keyboard activation of `Close` restores visible focus to its opener; and
- no request reaches a foreign origin.

This proof does not claim screen-reader, real-device, forced-colors, zoom,
Firefox, WebKit, or whole-product conformance. The product correction and the
browser GREEN remain blocked until #1927 is merged or Claude 4 explicitly
resolves the overlapping file ownership.
