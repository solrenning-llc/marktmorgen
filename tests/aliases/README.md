# Test aliases, one file per test

A test that needs aliases (a world file in place of a module, a stub for `next/headers`, and so on) declares them here, in `tests/aliases/<test file>.json`, for example `tests/aliases/notify-prefs-page.test.ts.json`. Do not add a line to the list in `tests/test-config.mjs`: every pull request appended one at the same place, and two of them conflicted.

The file is one object from alias to target, read after the list in `tests/test-config.mjs`:

```json
{
  "next/headers": "security/next-headers.ts",
  "@/lib/studio-route": "my-page-world.ts",
  "@/lib/redis": "@/lib/redis.ts",
  "@/lib/resend-fallback-transport": null
}
```

- A target is a path under `tests/`, or under the repository root when it starts with `@/`.
- `null` takes a default of the central list away for that test only.
- A target that does not exist, or a file that is not one such object, fails the test, by name.

`tests/test-alias-sidecars.test.ts` holds these rules.
