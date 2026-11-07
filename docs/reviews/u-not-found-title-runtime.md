# Codex U: not-found title runtime evidence

Subject is the unchanged queued product candidate `4fd64c0f6318c32cc015e98f8ccf86e067500cb5` of PR #2643. This evidence branch is not a product candidate and has no PR. It addresses the reported coverage gap of the original source-string checks without moving the queued product head. It does not close the LOW in the permanent product test suite until independently reviewed and adopted through a legitimate follow-up.

Channel reservation: 680620462a3643fdc6453d5d20ae1aba7d842438, before proof/source work. Only two new test/runner files plus this report are written. Product modules and original tests are byte unchanged.

## Result and limits

The proof invokes the actual route's generateMetadata and default async component; ReactDOM renderToStaticMarkup renders that returned component. Actual speech and seven dictionaries are bundled. Exact independently written title literals, h1 text and wrapper lang, robots and four fallback cases are checked. Portuguese remains pt-PT. All 34 checks pass. The same 34 assertions under a bundle-only mutation replacing localized metadata with the fixed English fallback produce seven failures and 27 passing controls. This is sensitivity evidence, NOT historical product RED, not a new defect, and not a code correction. No test expectation changes between modes.

Fixtures replace store/header adapters, visual style helper, Link, and site-level fallback component. The route's locale selection, dictionary selection, metadata function and known-store markup are real. Unknown store, suspended store, thrown store read and missing header select the site fallback; missing header dispatches no store read. This does not execute production Redis, proxy/header authentication, actual store shape validation, site fallback internals, Next metadata delivery, browser hydration, head tags, request-wide cache deduplication, global html language, accessibility or full SSR deployment. React cache is the normal bundled React export outside a Next request context; no assertion of single shared request read is made.

Per child before dispatch: hard 100 store-adapter and 100 header reads across all cases, external fetch and socket connect denied before graph, 120 s / 512 MiB heap / 256 KiB captured output. Both final and mutant measure 23 store reads and 26 header reads. Those are synthetic adapters, NOT Redis commands or paid calls. No provider IO; no native Redis/Lua/browser. Types cap 1024 MiB. An initial final-only run passed before cumulative adapter counters were added to the launcher; it was not the final bounded measurement. The final run was repeated only after that launcher correction. No product file was mutated on disk: mutation exists only in esbuild onLoad output.

Selected actual-tsconfig types (one proof root, which imports the route): zero diagnostics, no emit. ESLint proof+runner: exit0, no output. Scanner after staging the two new paths: 4160 tracked files, zero corrections. Staged diff --check: exit0. Scanner covers the frozen subject and the two new staged paths, not latest main. Main-read audit during this unit was 171a45349e9aa581fe0d2bcf7dfabd8f5f5df375; only docs/codex-queue.md differs in the normative set versus 180d, and its completeness/history delta was read. No price, policy, limit, flag or customer copy changed.

## Reproduction

Run on this frozen product subject, copying just the two evidence files (do not merge the evidence tree):

```sh
node tests/u-not-found-title-runtime-run.mjs "$PWD" mutant
node tests/u-not-found-title-runtime-run.mjs "$PWD" final
node --max-old-space-size=1024 /tmp/codex-u-verify.mjs "$PWD" types tests/u-not-found-title-runtime.proof.ts
node node_modules/eslint/bin/eslint.js tests/u-not-found-title-runtime.proof.ts tests/u-not-found-title-runtime-run.mjs
python3 scripts/check_public_data.py
git diff --cached --check
```

The selected-root types launcher is the previously preserved U launcher: it uses TypeScript readConfigFile/parseJsonConfigFileContent/createProgram with actual parsed options, noEmit true, incremental false, and reports all pre-emit diagnostics without filtering. It is not a global type check.

## Raw final output

```text

Real route metadata and React static markup use the seven actual dictionaries
  ok    en: exact generated tab title
  ok    en: real heading and wrapper language
  ok    en: metadata robots preserved
  ok    es: exact generated tab title
  ok    es: real heading and wrapper language
  ok    es: metadata robots preserved
  ok    fr: exact generated tab title
  ok    fr: real heading and wrapper language
  ok    fr: metadata robots preserved
  ok    de: exact generated tab title
  ok    de: real heading and wrapper language
  ok    de: metadata robots preserved
  ok    it: exact generated tab title
  ok    it: real heading and wrapper language
  ok    it: metadata robots preserved
  ok    nl: exact generated tab title
  ok    nl: real heading and wrapper language
  ok    nl: metadata robots preserved
  ok    pt: exact generated tab title
  ok    pt: real heading and wrapper language
  ok    pt: metadata robots preserved
  ok    missing: site fallback tab
  ok    missing: site fallback component
  ok    missing: fallback robots
  ok    suspended: site fallback tab
  ok    suspended: site fallback component
  ok    suspended: fallback robots
  ok    error: site fallback tab
  ok    error: site fallback component
  ok    error: fallback robots
  ok    no-header: site fallback tab
  ok    no-header: site fallback component
  ok    no-header: fallback robots
  ok    no header performs no store read

34 checks, all passing.
ADMITTED {"reads":23,"headers":26}

```

## Raw mutation output

```text

Real route metadata and React static markup use the seven actual dictionaries
  FAIL  en: exact generated tab title
        expected "This page isn't here — Sample Store"
        got      "Not here — Marktmorgen"
  ok    en: real heading and wrapper language
  ok    en: metadata robots preserved
  FAIL  es: exact generated tab title
        expected "Esta página no está aquí — Sample Store"
        got      "Not here — Marktmorgen"
  ok    es: real heading and wrapper language
  ok    es: metadata robots preserved
  FAIL  fr: exact generated tab title
        expected "Cette page n'est pas ici — Sample Store"
        got      "Not here — Marktmorgen"
  ok    fr: real heading and wrapper language
  ok    fr: metadata robots preserved
  FAIL  de: exact generated tab title
        expected "Diese Seite gibt es hier nicht — Sample Store"
        got      "Not here — Marktmorgen"
  ok    de: real heading and wrapper language
  ok    de: metadata robots preserved
  FAIL  it: exact generated tab title
        expected "Questa pagina non è qui — Sample Store"
        got      "Not here — Marktmorgen"
  ok    it: real heading and wrapper language
  ok    it: metadata robots preserved
  FAIL  nl: exact generated tab title
        expected "Deze pagina is er niet — Sample Store"
        got      "Not here — Marktmorgen"
  ok    nl: real heading and wrapper language
  ok    nl: metadata robots preserved
  FAIL  pt: exact generated tab title
        expected "Esta página não está aqui — Sample Store"
        got      "Not here — Marktmorgen"
  ok    pt: real heading and wrapper language
  ok    pt: metadata robots preserved
  ok    missing: site fallback tab
  ok    missing: site fallback component
  ok    missing: fallback robots
  ok    suspended: site fallback tab
  ok    suspended: site fallback component
  ok    suspended: fallback robots
  ok    error: site fallback tab
  ok    error: site fallback component
  ok    error: fallback robots
  ok    no-header: site fallback tab
  ok    no-header: site fallback component
  ok    no-header: fallback robots
  ok    no header performs no store read

34 checks, 7 failing.
ADMITTED {"reads":23,"headers":26}

```
