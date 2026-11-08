# Independent review evidence for PR #3152

Candidate: b97ee79137c91c8f296fbd0a31610fec6f3b1235. RED: 8e2f71f695c1243e0a930feeefbf9542658fdd91. Full 12-file diff read; no author branch modified.

No high/medium finding in the reviewed change. One LOW permanent-test coverage gap: the new six-test file renders four components, while BlockRewrite, PageCoach and TranslatePage are also changed. Reverting ONLY those three component files to RED in the test bundle leaves the author's 6/6 tests passing. The independent 18-assertion probe fails 6 assertions with 12 controls on RED and passes all 18 on the candidate. Please add permanent coverage for these controls, including an opened coach. This is a test gap, not an observed remaining product defect.

The probe renders real components and real dictionaries. PageCoach alone is compiled with its initial open state true, on BOTH sides, to expose the otherwise closed panel; all allowance/button/description logic is unchanged. This is a controlled SSR fixture, not browser interaction or a Next/server-rendering certification. No provider or real Redis request.

Results: author RED 3/6 pass, candidate 6/6; independent RED 12/18 pass, candidate 18/18; related 164 checks pass (11 rewrite +14 fill +8 posts +36 coach +11 FAQ +26 setup +42 US English +16 accessibility inventory). Selected-root TypeScript: nine roots, zero diagnostics. Lint and diff checks pass. Public-data scan is recorded separately after staging the evidence.

Caps before synthetic dispatch: MemoryRedis.run 20000 per child including nested calls; mock HTTP 100 per child. External sockets and unmocked fetch denied before module loading. Node child 512 MiB/120 seconds/256 KiB output; selected-root types 1024 MiB. The unknown premise uses the author's error-object Redis world (one GET inspection from aiLeft, no MemoryRedis dispatch); all renderer probes dispatch zero HTTP. Largest linked counts: 153 mock Redis /20000 (store setup) and 5 mock HTTP /100 (fill).

Boundaries: initial unknown state and static output, known/zero/off controls, unchanged server reservation guards inspected. Eight explicitly listed remaining callers are outside this PR, not claimed fixed. No browser, screen reader, focus/zoom/reflow, runtime cache, model usage or money-out certification. No CI result or merge claim.

Run: node docs/reviews/u-3152-runner.mjs ABSOLUTE_WORKTREE final TEST_NAME. The RED worktree must be at the public RED commit, with the identical independent probe copied into tests/. coverage-gap mode overlays only the three named old components into the author's test bundle; it never changes repository product files.

## Bounded logs (trailing whitespace normalized only)

### u-3152-coverage-gap-vr2-ai-left-unknown.test.ts.log

```text
  4/4 components say an unread allowance truthfully
  4 AI buttons checked
  8 call site(s) still turn an unknown allowance into 0; 0 outside the pending list
✔ premise: the lib says the balance is unknown (it throws), as rule 24 asks (3.51436ms)
✔ an unread allowance is said in words in every component that shows it, never as a count (18.505792ms)
✔ with an unread allowance the AI buttons that wait on it are off, and every AI button is tied to the sentence that says why (4.970721ms)
✔ control: a known allowance still shows its number and leaves the buttons on (11.439449ms)
✔ control: a spent allowance is still 0 left, with the buttons off (3.126335ms)
✔ no page reads an unknown allowance as 0 outside the pending list, and the list only shrinks (65.66324ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 117.890921
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 0 /20000

```

### u-3152-final-accessibility-inventory.test.ts.log

```text

Every source stays visible in the accessibility inventory; inventory is not a pass
  ok    all page templates mapped
  ok    all layout templates mapped
  ok    all error/loading/not-found boundaries mapped
  ok    all shared TSX components mapped
  ok    all API route sources mapped

Generated route templates retain gaps instead of claiming fixture coverage
  ok    generator keeps the checked inventory current
  ok    home route
  ok    dynamic course route
  ok    groups and parallel slots are not URL segments
  ok    catch-all route
  ok    optional catch-all route
  ok    ambiguous or non-page source is refused app/api/x/route.ts
  ok    ambiguous or non-page source is refused elsewhere/page.tsx
  ok    ambiguous or non-page source is refused app/(.)photo/page.tsx
  ok    ambiguous or non-page source is refused app/[[broken]/page.tsx
  ok    source generator never certifies untested pages

16 checks, all passing.
ADMITTED synthetic HTTP: 0 /100

```

### u-3152-final-ai-writing-faq.test.ts.log

```text

The editors and the rules
  ok    the buttons' and the panels' words, as the studio draws them
  ok    each way in drawn only while the writing help is available
  ok    off on the Store plan, without a plan and in a trial; none on the Store plan or in a trial

The answers, in both states
  ok    two questions
  ok    finding it: next to what it writes, paid-up Studio or Scale, its label, while available, the button, the panel and its press, the help box, not shown otherwise
  ok    trying: needs, never comes with; not in the trial; no promise past a paid-up plan; nothing the page's closing already says
  ok    one space between sentences, never two
  ok    no figure, no percent, no result promised

On the writing help page
  ok    first in the page's own Questions block
  ok    no question asked twice
  ok    no sentence of the answers said elsewhere on the page, or twice among them

11 checks, all passing.
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 0 /20000

```

### u-3152-final-block-fill.test.ts.log

```text

What it may write from nothing
  ok    benefits, who it is for, how it works, questions
  ok    guarantee: refused, the model never asked
  ok    bio: refused, the model never asked
  ok    bonuses: refused, the model never asked
  ok    inside: refused, the model never asked
  ok    not one question asked of the model for them

A first draft, in the block's own shape
  ok    told the language, the shape and to add nothing
  ok    its points, its own id and kind
  ok    the creator's heading and where it shows stay theirs
  ok    it counts as one of the month's jobs
  ok    the heading a new block starts with is the draft's, in the store's language

Never a new fact
  ok    a number nobody gave: thrown away, with its attempt still counted

Questions only with answers
  ok    a question the facts cannot answer is left out
  ok    and none at all is no draft

14 checks, all passing.
ADMITTED synthetic HTTP: 5 /100
ADMITTED synthetic Redis: 28 /20000

```

### u-3152-final-block-rewrite.test.ts.log

```text

Numbers, read the way a page writes them
  ok    1,200 and 1200 are one number
  ok    a number the block had is fine
  ok    one the page states is fine too
  ok    a new one is not

A rewrite, in the block's own shape
  ok    told the way, the language, and to add nothing
  ok    the words change, the picture beside them does not
  ok    it counts as one of the month's jobs

Never a new fact
  ok    a number nobody wrote: thrown away, with its attempt still counted

Lists never grow
  ok    two points stay two

Buttons, and blocks with nothing to rewrite
  ok    a price is taken off a button
  ok    an empty block, or one that is not words, is refused before the model is asked

11 checks, all passing.
ADMITTED synthetic HTTP: 4 /100
ADMITTED synthetic Redis: 26 /20000

```

### u-3152-final-page-coach.test.ts.log

```text

The score
  ok    an empty page scores nothing
  ok    and says so in a word
  ok    each missing part comes with the block that answers it
  ok    a complete page scores 100
  ok    a headline that is only the product's name is not one
  ok    a first button five blocks down is too far

Pictures a screen reader can say (98 [D2-COMPLIANCE-REVIEW] unit 3, AX274 Part A item 6)
  ok    only the product's picture at the top, described: asked and done
  ok    no picture on the page at all: not asked
  ok    a picture with no description: asked, not done, and it says how many
  ok    a picture beside words counts too
  ok    every picture described: done, and the page can still score 100
  ok    spaces are not a description
  ok    it never offers a block to add: the fix is the description, written by the creator
  ok    several without: said in plain words
  ok    the product's picture at the top, with no description: not done
  ok    and asked even when it is the only picture
  ok    a picture with no description in the second version counts
  ok    the editor sends the version not being edited as the second one, never the edited one twice
  ok    and the product picture's description

Never a reason to type a number
  ok    no number counted: the numbers check is not asked
  ok    one counted: it is

A free product's page
  ok    asks nothing about payment: no guarantee, buttons or headline test

Where readers stop
  ok    the steepest fall, and where
  ok    below thirty readers, nothing is said
  ok    a gentle slope is not a fall

The review
  ok    it is given the page and what is missing
  ok    told to write the page's words in the store's language
  ok    and held to the rules every draft is
  ok    only answers the page's facts give
  ok    empty items are dropped, and so is a headline that states a price
  ok    it is told never to put a price in a headline
  ok    a one-sided who-it-is-for is left out, not half shown
  ok    a question the page cannot answer keeps its empty answer
  ok    it counts as one of the month's jobs
  ok    an answer that cannot be read retains its started attempt

Comparison cells read as words for the model
  ok    a check is kept as the check character

36 checks, all passing.
ADMITTED synthetic HTTP: 2 /100
ADMITTED synthetic Redis: 22 /20000

```

### u-3152-final-platform-us-english.test.ts.log

```text

American English guard distinguishes prose from compatibility identifiers
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    displayed British sample is rejected
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    legacy technical syntax is preserved
  ok    existing non-English buyer copy is outside this policy
  ok    mixed buyer dictionaries retain other languages
  ok    separate foreign buyer declarations remain unchanged
  ok    American prose passes
  ok    single-word test title is also checked
  ok    test output titles are also platform-maintained text
  ok    test data can exercise a forbidden sample
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    each requested British form is rejected
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes
  ok    American counterpart passes

All current app, component, library and test-diagnostic sources
  ok    real source inventory is scanned
  ok    platform prose and diagnostic titles use American spelling

42 checks, all passing.
ADMITTED synthetic HTTP: 0 /100

```

### u-3152-final-product-posts-ai.test.ts.log

```text

What is asked
  ok    given what the page says
  ok    in the store's language, under every honesty rule, with no link of its own

What comes back
  ok    a link the model wrote is taken out
  ok    each kept to its length
  ok    the caption says the link is in the bio
  ok    one of the month's jobs

What changes nothing
  ok    an unusable response is refused but its started attempt is counted

Where the link comes from
  ok    the studio adds the address, tagged for where it goes

8 checks, all passing.
ADMITTED synthetic HTTP: 2 /100
ADMITTED synthetic Redis: 34 /20000

```

### u-3152-final-store-setup.test.ts.log

```text

The draft
  ok    lines once each
  ok    three products at most, prices only where the creator named them (the club's 7 was the model's guess)
  ok    told never to guess a price
  ok    answers whole, with no links
  ok    told to work from the creator's words only, and to invent nothing
  ok    nothing to work from, nothing asked

A price is the creator's, written as a price, or empty
  ok    written as a price in the store's currency, kept
  ok    a bare number, another currency or nothing: empty

At most three questions, to press, only when something is missing
  ok    questions with two to four distinct answers, none about a price or a number, three at most
  ok    never about money or a count
  ok    but a question about who is in charge, or what it is, may be asked
  ok    told to ask only for what is indispensable, and never for a price
  ok    the answers go back into the next draft, three at most, empty ones dropped
  ok    a draft with nothing to ask carries no questions

Questions held to their shape
  ok    one answered with numbers is dropped; a long one is cut to 100 and 40, four answers at most

What the creator keeps
  ok    the line, two drafts each with its page, the questions, and the one with no price refused by name
  ok    the line is under the name
  ok    every product a draft, not on sale
  ok    the club is monthly

Each draft product gets the sales page of its kind, with nothing invented
  ok    the planner's page opens on its own title and summary, then the download template
  ok    the club's page is the membership template
  ok    no sentence is written for the creator: no answer is filled in
  ok    each product is marked as having its page, so the editor and the product page find it, and removing it removes the page
  ok    and no AI was asked for it
  ok    the template follows the kind, and a free product gets the free one
  ok    questions already written are never replaced

26 checks, all passing.
ADMITTED synthetic HTTP: 4 /100
ADMITTED synthetic Redis: 153 /20000

```

### u-3152-final-u-review-3152-remaining.test.ts.log

```text

rewrite
  ok    rewrite: unknown sentence and no zero/null balance
  ok    rewrite: real job buttons are present and disabled
  ok    rewrite: every job button describes the actual unknown sentence
  ok    rewrite: known balance and enabled controls
  ok    rewrite: spent is still zero with disabled controls
  ok    rewrite: unavailable feature hides the job controls

coach
  ok    coach: unknown sentence and no zero/null balance
  ok    coach: real job buttons are present and disabled
  ok    coach: every job button describes the actual unknown sentence
  ok    coach: known balance and enabled controls
  ok    coach: spent is still zero with disabled controls
  ok    coach: unavailable feature hides the job controls

translate
  ok    translate: unknown sentence and no zero/null balance
  ok    translate: real job buttons are present and disabled
  ok    translate: every job button describes the actual unknown sentence
  ok    translate: known balance and enabled controls
  ok    translate: spent is still zero with disabled controls
  ok    translate: unavailable feature hides the job controls

18 checks, all passing.
ADMITTED synthetic HTTP: 0 /100

```

### u-3152-final-vr2-ai-left-unknown.test.ts.log

```text
  4/4 components say an unread allowance truthfully
  4 AI buttons checked
  8 call site(s) still turn an unknown allowance into 0; 0 outside the pending list
✔ premise: the lib says the balance is unknown (it throws), as rule 24 asks (2.93091ms)
✔ an unread allowance is said in words in every component that shows it, never as a count (17.083616ms)
✔ with an unread allowance the AI buttons that wait on it are off, and every AI button is tied to the sentence that says why (6.115421ms)
✔ control: a known allowance still shows its number and leaves the buttons on (10.216668ms)
✔ control: a spent allowance is still 0 left, with the buttons off (3.078629ms)
✔ no page reads an unknown allowance as 0 outside the pending list, and the list only shrinks (79.000627ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 128.18203
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 0 /20000

```

### u-3152-red-u-review-3152-remaining.test.ts.log

```text

rewrite
  FAIL  rewrite: unknown sentence and no zero/null balance
        expected [true,false]
        got      [false,true]
  ok    rewrite: real job buttons are present and disabled
  FAIL  rewrite: every job button describes the actual unknown sentence
        expected true
        got      false
  ok    rewrite: known balance and enabled controls
  ok    rewrite: spent is still zero with disabled controls
  ok    rewrite: unavailable feature hides the job controls

coach
  FAIL  coach: unknown sentence and no zero/null balance
        expected [true,false]
        got      [false,true]
  ok    coach: real job buttons are present and disabled
  FAIL  coach: every job button describes the actual unknown sentence
        expected true
        got      false
  ok    coach: known balance and enabled controls
  ok    coach: spent is still zero with disabled controls
  ok    coach: unavailable feature hides the job controls

translate
  FAIL  translate: unknown sentence and no zero/null balance
        expected [true,false]
        got      [false,true]
  ok    translate: real job buttons are present and disabled
  FAIL  translate: every job button describes the actual unknown sentence
        expected true
        got      false
  ok    translate: known balance and enabled controls
  ok    translate: spent is still zero with disabled controls
  ok    translate: unavailable feature hides the job controls

18 checks, 6 failing.
ADMITTED synthetic HTTP: 0 /100

```

### u-3152-red-vr2-ai-left-unknown.test.ts.log

```text
  0/4 components say an unread allowance truthfully
  10 call site(s) still turn an unknown allowance into 0; 2 outside the pending list
✔ premise: the lib says the balance is unknown (it throws), as rule 24 asks (2.753751ms)
✖ an unread allowance is said in words in every component that shows it, never as a count (19.724912ms)
✖ with an unread allowance the AI buttons that wait on it are off, and every AI button is tied to the sentence that says why (3.105478ms)
✔ control: a known allowance still shows its number and leaves the buttons on (7.051935ms)
✔ control: a spent allowance is still 0 left, with the buttons off (2.142808ms)
✖ no page reads an unknown allowance as 0 outside the pending list, and the list only shrinks (44.324544ms)
ℹ tests 6
ℹ suites 0
ℹ pass 3
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 90.539684

✖ failing tests:

test at ../../../../tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42056:27
✖ an unread allowance is said in words in every component that shows it, never as a count (19.724912ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

  + [
  +   'store setup: no "could not check" sentence',
  +   'store setup: says null left',
  +   'studio help: no "could not check" sentence',
  +   'studio help: says null AI jobs left',
  +   'writing help box: no "could not check" sentence',
  +   'writing help box: says 0 left',
  +   'social posts: no "could not check" sentence',
  +   'social posts: says 0 left'
  + ]
  - []

      at TestContext.<anonymous> (/tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42069:29)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [Array],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at ../../../../tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42071:27
✖ with an unread allowance the AI buttons that wait on it are off, and every AI button is tied to the sentence that says why (3.105478ms)
  AssertionError [ERR_ASSERTION]:  type="button" class="btn btn-secondary btn-sm" disabled="" aria-busy="false": not described by the sentence
      at TestContext.<anonymous> (/tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42079:33)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at ../../../../tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42126:27
✖ no page reads an unknown allowance as 0 outside the pending list, and the list only shrinks (44.324544ms)
  AssertionError [ERR_ASSERTION]: a page turns an unknown allowance into 0
  + actual - expected

  + [
  +   'app/studio/blog/page.tsx',
  +   'app/studio/reviews/page.tsx'
  + ]
  - []

      at TestContext.<anonymous> (/tmp/u-3152-red-vr2-ai-left-unknown.test.ts.cjs:42131:29)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [Array],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
ADMITTED synthetic HTTP: 0 /100
ADMITTED synthetic Redis: 0 /20000

```
