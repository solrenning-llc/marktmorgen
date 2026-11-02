# Ease patterns audit (487 [IT4])

The screen-by-screen audit that 487 [IT4] asks for: what was checked, what was found, and what was fixed. Each section names its date and method. A pattern not yet audited is listed as not audited, never as passing.

## Pattern 2: the right keyboard on a phone (1 November 2026)

**Method.** Every `<input>` and `<EmailField>` in `app/` and `components/` was read by a script (type, `inputMode`, `autoComplete`, and the field's id, name, placeholder and label). Each flagged field was then read by hand. An independent review re-counted them with a parser that respects braces.

**Found.**
- **Email fields:** 25 `<input>` fields (23 with `type="email"` written out, 2 with the type chosen in code; those 2 already set `autoComplete`), plus 17 `<EmailField>` uses, each already naming its `autoComplete`. Four `<input>` fields had none, and all four hold someone else's address:
  - who a store moves to ("Move to", `app/studio/page.tsx`);
  - a deal's contact (`components/deals-board.tsx`, `components/form-response-deal.tsx`);
  - someone on the list (`components/workflow-tools.tsx`).

  Without `autoComplete="off"`, a browser is asked to offer the creator's own address there. "off" asks it not to; some browsers may still offer it, so this reduces the mistake rather than ruling it out.
- **Number fields:** about thirty `type="number"` fields. Most hold counts (days, percent, people, keys). The monthly goal in `components/path-onboarding.tsx` is an amount, and the dynamic fields in `components/person-fields.tsx` and `components/email-studio.tsx` hold the creator's own numbers. All of them already open the number keyboard, and the amount already sets its `inputMode`. Nothing changed.
- **Phone fields:** the app has none.
- **Money fields:** the text fields whose names mention a price are headings or sentences ("The launch price ends in", "What is compared"), not amounts. The amounts already use `inputMode="decimal"`, or `numeric` for JPY, as the discount editor does.

**Fixed.**
- The three email fields in `components/` take `autoComplete="off"`, as the other fields for someone else's address already do (for example the gift recipient in `components/store-product.tsx`).
- "Move to" in `app/studio/page.tsx` takes `autoComplete="off"` too, now that the file is no longer held by an open PR. Nothing waits any more.
- The test fails if any email field in the app, `<input>` or `<EmailField>`, gives no `autocomplete`. It extracts whole tags and recognizes a type chosen in code.

## Pattern 4: a label always visible (1 November 2026, first pass)

**Method.** The same script listed every text field with no `<label>` around it and no `htmlFor` pointing at it. Each one was read by hand. Fields whose `id` is computed, and whose label points at it, were false alarms.

**Found.** Two kinds of field had no visible label:
- **Placeholder only, or a label for screen readers only:**
  - the store address field on the home page (`components/home-claim.tsx`): its label is screen-reader only, and the visible text is the `marktmorgen.com/@` prefix and the example;
  - the podcast episode's title and notes (`components/podcast-editor.tsx`): an `aria-label` only.
- **`aria-label` only: 21 fields.** Read so far:
  - **A field in a visibly named list,** with the list's name shown above it and the label giving its position: the deal stages ("Stages, in order"), the quiz answers ("Answers — check the right…"), the creator's own leaving reasons. The deal stages' "What stage N means" `<select>` also has only an `aria-label`. Its list name is a paragraph, not a legend, so it is counted with the six still to read.
  - **Read-only text to copy,** under its visible name or heading: the funnel's launch checklist, a short link, the campaign link, the store's share link.
  - **Read in the second pass:**
    - The email designer's blocks have a visible type ("Heading", "Text") above each field, and the spoken name starts with it.
    - The opening hours of a call, and of a team event's hosts, are named by the day and the word "to" shown beside them, and the spoken name starts with them.
    - Four lists were named only by a placeholder that goes when typing starts: the quiz scoring categories, the form options, the pipeline stages and the deal custom fields. The custom fields' list also had a legend only a screen reader hears.

**Fixed.**
- The podcast episode's title and notes now have visible labels, "Episode title" and "Episode notes".
- The home page field changes the hero's look, so it waits for the home page work under 571 [VS1].
- Second pass: each row of those four lists now has a visible name of its own, "Category 1", "Option 1", "Stage 1" or "Field 1", tied to its field. The custom fields' list is named by its visible heading, "Your fields".
- The selects beside those rows now show a visible word that starts their spoken name, as "Points" already did:
  - "Category", "Result" and "Next" beside a form option;
  - "Counts as" beside a pipeline stage;
  - "Kind" and "Choices, separated by commas" on a custom field.

  On a phone, a long choice ("Then skip to question 12: …") now shrinks inside its row instead of making the page scroll sideways.

## Pattern 3: the common value filled in, never the dearest (1 November 2026)

**Method.** Every pre-chosen control in `app/` and `components/` was read: `defaultChecked`, checked radios, and the first state of each choice.

**Found.**
- **Buyer's checkout choices:**
  - "Pay in full" is chosen before a payment plan;
  - monthly is chosen before yearly on a membership;
  - no paid add-on box is checked before the buyer checks it.
- **The pricing page:** it opens on monthly (`components/pricing-cycle-controls.tsx`).
- **A product with several prices:** the option the creator marks "Recommended" is chosen first (`startingOption` in `lib/product-option.ts`), and otherwise the first option. When the creator marks the dearest one, the dearest is chosen first. It is labeled "Recommended" in plain sight, but the item's own words say never the dearest. Whether a creator's explicit recommendation is an exception is the owner's to decide. It is recorded under "Depende do dono" in the queue, and nothing was changed.

## Pattern 6: drafts saved by themselves, nothing lost (1 November 2026, first pass)

**Method.** Each studio editor was searched for saving on its own (a timer or a save on leaving a field) and for the leave guard (`components/leave-guard.ts`), which asks before a page with unsaved changes is left.

**Found.**
- **Saves on its own:** none of the editors read.
- **Asks before leaving with unsaved changes:** the page editor, the email studio, the funnel editors and the forms editor.
- **Neither:** the product editor, the blog editor, the course editor, the email designer, the quiz editor and the FAQ editor. Unsaved text in them is lost to one click away.

**Fixed.**
- The blog editor asks before leaving with an unsaved post. A post can be long, and nothing else kept it. Once saved, its changes are guarded again.
- The FAQ editor asks too, using its own measure of unsaved answers, which includes answers drafted by the writing help.

- The quiz editor asks while a quiz is open and differs from what was opened. A quiz opened and left untouched never asks. The assignment editor beside it asks the same way.
- After a confirmed save, the blog and FAQ editors compare against what was saved until the page brings it back, so nothing saved reads as unsaved, and anything typed after the save is still guarded and kept.
- The product form asks the same way, when adding or editing. A long description that is read after the form opens counts as part of what was opened.
- In the course editor, a module asks when its name or its days changed. A lesson asks when its name, link, preview or text changed, and while a video or file is still uploading. After a save, both take back what the server kept, so a name it tidied never reads as unsaved, except a field typed in while it was saving, which keeps what was typed. They also ask while a save is still going, since the course shares one busy state.
- The email designer needed nothing of its own. Every change in it goes into the email it sits in, and both of those (the email composer and a sequence step) already ask before leaving.

**Still to do.**
- Saving by itself with "Saving…" and "Saved" shown. That writes to the server on its own, so it needs its own request ceiling per plan first.

### Saving by itself: the rules first (1 November 2026)

`lib/autosave-rules.ts` decides when an editor may save by itself. No editor uses it yet, and it writes nothing.

- **Where it may.** Only where a save changes nothing anyone else sees and loses nothing: a draft or a hidden item, on a store that pays for its plan. Never where Save puts the change live (a page that is on, a published product or post), moves the five versions a sales page keeps to undo with, deletes a file, or restarts an A/B test. There the creator presses Save, as today. Each editor that takes it up says which of its saves are of the first kind.
- **What it costs.** A save is one studio request, priced at its own shape (twenty commands and fifty kilobytes) and counted at every plan's full figure. A heavier save is not inside that price, so it never saves by itself. Examples are a sales page of hundreds of kilobytes, one that checks pictures in the file store, and one that reindexes a course. Only a draft of at most 20,000 bytes does.
- **Its own ceiling, on the server.** Saves by itself may use at most a quarter of the window's studio figure, counted on the server. That count is not kept yet. It is the next unit, registered in `tests/store-data-registry.ts` first, which an open PR holds. Until then, nothing saves by itself: unknown is never room.
- **What it does not promise.** When the whole window is used, the studio rests for every request, pressed saves included. Saves by itself never take more than their quarter of it.
- **In the browser, besides.** It saves only after the typing has stopped for 4 seconds, at most once a minute, and at most 60 times while one editor stays open. A draft its route refused is not tried again until it changes. These bound one tab, not the store: reloading or a second tab starts them again, which is why the quarter is counted on the server. Run on a virtual clock for an hour of typing, it saves at most 60 times, never two within a minute.
- **Unknown is never room.** Any input that is not a plain figure stops it.
- **The words beside Save:** "Saving…", "Saved at 3:04 PM.", "Not saved yet.", and, where it does not save by itself, "Not saved yet: press Save.".
- **Next:** the server count of saves by itself, kept with the window. Then `studioAccess` sends back the window's figure and that count (today `takeAllowance` returns what is left, and `countStudio` drops it). Then each editor, one by one, with its saves sorted into the two kinds.

## Pattern 1: checked when the person leaves the field (1 November 2026, first pass)

**Method.** Every `onBlur` in `components/` was read, and every `type="url"` field was listed.

**Found.**
- **Already checked on leaving:** email fields (`components/email-field.tsx`, the "Did you mean …?" line, 17 uses) and the sign-in field (`components/signin-form.tsx`). A custom field (`components/person-fields.tsx`) saves when it is left. A page's address (`components/site-pages-editor.tsx`) is tidied when it is left.
- **Web addresses:** 13 files have `type="url"` fields. All of them are checked only when the form is sent, so a missing `https://` shows up only after pressing Save.

**Fixed.**
- `components/url-field.tsx` checks a web address when the person leaves the field, never while they are typing, using the server's own reading (`readLink` in `lib/product-link.ts`). If the address only lacks `https://`, or has `http://`, it offers the corrected address in one press. Anything else gets the server's own words. It is also said when the form is sent. While the person types, a message only goes away, once the address is right; a new one waits for the next leave, so nothing is announced at every key. After the one-press fix, the focus goes back to the field. An address too long is said, never cut. The message carries an icon beside its words, so it is not told by color alone, and it is tied to the field for screen readers.
- The lesson link in the course editor uses it, with its label now tied to the field by id, so does the link a product sends its buyer to, and so does a store link, each with its help tied to it. All three routes now refuse a link that is too long instead of cutting it.
- The field takes the reading of its own server. A call's two meeting links and a community event's link use `cleanRoom` (`lib/call-setup.ts`). That reading cuts a link over 500 characters, and it also reads the links already stored, so it is left as it is; the field says a link is too long before the cut happens, measured as it would be stored. Found on the way, not changed: a link of 500 characters or fewer can be stored longer once its letters are written out (an é takes 6), and is then cut when it is read back. The field now warns about it before the save.

**Still to do.**
- The tracking link (mark shipped), whose files are held by an open PR. The page editor's quote link already had its own check tied to the field (`badLink`, `noLink`), so it is left as it is. Each is read first: their routes do not use the product-link reading, so each needs the reading its own server applies. The webhook editor and both calendar editors are read by `checkUrl` in `lib/safe-fetch.ts`, which guards every request the server sends out and uses the server's own address reading. It is left untouched. Their fields use `lib/fetch-url-check.ts`, a part of that guard written for the browser: it never refuses an address the server keeps, refuses only in the server's words, and leaves an address written as a number (an IP) to the server, which alone says whether it is private. The fields keep `autocomplete="off"`, because a calendar's private address and a webhook endpoint are secrets. A fix is never offered for an address written as a number, nor one that grows too long once its letters are written out; the webhook field refuses webcal:// as its server does; each field says "too long" in its own server's words. A host's calendar address is now sent trimmed, as the field checks it. The report form's page address uses the field too, by the pattern its notice is held to (`lib/takedown-rules.ts`), which takes http:// as well. The chat summary's webhook address uses it too, by the very function the server posts with (`chatKind`, now in the browser-safe `lib/chat-kind.ts`). Its form no longer sends an empty address, which would have stopped the posting: only "Stop posting" does that. The public review page (reviews) uses it, by the reading its server keeps (`parseReviewElsewhere`). A form whose address the field refuses is not sent (chat summary, report form), so a refused try never uses the hour's allowance, and a refused review page is said once, beside the field. The report notice now refuses an address longer than 500 characters instead of cutting it. The tracking link (mark shipped) waits: its files are held by an open PR. The chat summary, report form, page editor and review studio are read next, one by one.

## Pattern 5: no empty screen without a sentence, a button and a ready example (1 November 2026, first pass)

**Method.** The empty states of 26 studio screens in `components/` and `app/studio/` were read. Each was checked for (a) a sentence saying what to do, (b) a button for the action, and (c) a ready template or example.

**Found.**
- **All three:**
  - the email body (`MAIL_TEMPLATES`);
  - sequences (two written for you);
  - site pages (starter pages);
  - course outlines (drafted by the writing help);
  - course templates (540 [CU1]).
- **A sentence and a button, no ready example:**
  - products;
  - after-purchase offers;
  - blog posts;
  - forms;
  - community setup;
  - discount codes;
  - bundles;
  - store links;
  - podcast episodes;
  - waitlist;
  - affiliates;
  - page funnels: an example in words only.
- **Missing a sentence or a button:**
  - the email history (its only button was "Reload");
  - community events ("Nothing scheduled.");
  - reviews (no action);
  - contacts (no action);
  - the deals board (empty columns with no sentence);
  - short links, webhooks and calendar feeds: an introduction and a form, no empty line.

**Fixed.**
- The email history says where the first email comes from: the editor above it.
- Community events say what an event can be and where to start one.
- With no review at all, on either tab, the reviews page offers "Ask buyers for a review" to a role that can switch the requests on. It leads to the setting's heading on the same page and moves the focus there.
- An empty deals board says what it is for and names its "New deal" button.
- Each sentence names a button only where that role sees it: a role that cannot send email or schedule events reads who does it instead.

**Still to do.**
- A ready example for products, blog posts, forms, after-purchase offers and community setup. Each is new content, written once, and gets its own unit: nothing a creator sees is made up.
- Not applicable, with the reason: the contacts page's empty "Your latest buyers" is a lookup of who bought, not a screen to make something. There is no buyer to "add", and its one next step, earlier purchases in the Stripe dashboard, is already said. A button there would be one that does nothing new.

## Pattern 8: a "Check answers" summary before publishing or sending (1 November 2026, first pass)

**Method.** Every studio action that publishes something to buyers or sends something to people was read for what the creator sees right before it takes effect.

**Found.**
- No action had a summary with "Change" on each item.
- Three asked before acting:
  - the email broadcast, whose review listed the facts in one paragraph;
  - the waitlist's "Put it on sale and tell the waitlist", a second press with no price shown;
  - switching a sequence on, a preview of one person's path.
- Everything else happens on one press:
  - adding or publishing a product, and changing a published price;
  - emailing buyers about an update;
  - a payment request;
  - a signature request;
  - a community announcement;
  - a sale;
  - a blog post;
  - a page;
  - the funnels;
  - switching the community on;
  - the podcast.

**Fixed.**
- The email broadcast, the one that cannot be taken back once sent, now reviews as a summary list: the subject, who gets it (the number and the audience's criteria), and when. Each row has a "Change" button that names what it changes, closes the review and puts the focus on that field. The send button still names how many people, and the audience is still checked again when sending starts. The review is not a live region (it would be read again at every key typed in the subject): its heading takes the focus when it opens, and on a phone each answer takes its own line.
- The waitlist's "Put it on sale and tell the waitlist" now shows, before the second press, what will happen:
  - when it goes on sale;
  - the price the email carries;
  - how many emails go out;
  - the note;
  - the postal address.

  The note and the address each have a "Change". The price says it is changed in the product's details. Changing the note or the address closes the review, so nothing is sent unread. Without a postal address, the second press is not offered and the review says why.
- "Tell buyers about an update" no longer sends on its first press, which now reads "Check before sending". It shows the product, who gets it and the note (with a "Change"), and only "Yes, email every buyer" sends. How many get it is not shown, because it is counted from the store's Stripe account when it is sent. Showing it sooner would need a new read from Stripe, with its own ceiling.
- Saving a new price on a product buyers can see, bought once at one price, now asks first. It shows the old price and the new one, with a "Change" that goes back to the price field, and ends on its own "Yes, save the new price". Amounts are compared, not text, so "29" and "29.00" are not a change. Changing the price again closes the review. A price that cannot be read is not reviewed: the save says what is wrong with it. Memberships, pay what you want and products with several prices are not covered yet: their field is not simply what every buyer pays, so the review's words would need to say more.
- A payment request and an agreement (or a new version of one) are reviewed before their email goes, each with a "Change" on every answer and its own "Yes, send …" button. The review opens only when the server's own reading (`readDraft`) takes the form, and shows what it read: the email as it will be kept, and each line with its quantity, amount and subtotal. Whatever the reading refuses is said, with the focus on that field. The review holds only while the form is what was reviewed: any edit closes it. A failed send is said beside its button, and nothing can be changed while it sends.

**Still to do, in this order, since a mistake there is public or costs money:**
- the prices of memberships, pay what you want and products with several options;
- the community announcement email. Its composer is on the community page, in the buyer's language, with its words in `lib/buyer-words` in seven languages. A review there needs its new sentences written in each of them, so it gets a unit of its own, under the rules for buyer languages.

## Pattern 7: a live preview at phone width beside each editor (1 November 2026, first pass)

**Method.** Each studio editor was read for a preview of what the buyer or reader gets, at phone width, that updates as the creator types.

**Found.**
- **Already met:** the page editor, which site pages also use. Its preview is live and 390 px wide, beside the blocks on wide screens, and in a Build or Preview tab with a Phone or Wide choice.
- **Only half met:** the email editor. It had a live preview only in Design mode, never in Write (the default), and never at phone width.
- **No preview at all:**
  - the product editor;
  - checkout settings;
  - the blog editor;
  - the community composer;
  - the course lesson editor;
  - the funnel editors (their page steps get one through the page editor).

**Fixed.**
- The email editor now shows "As it is sent" in Write as well as in Design, as the creator types. The email composer and every sequence step get it, as both use this editor. It starts at phone width (390 px, as the page editor), with a Phone or Wide choice that says which is on. It is drawn by the same function that draws the email, so it cannot show something the email does not. An empty preview's words are now 7.6:1 on white, up from 4.8:1. The preview is inert: its headings stay out of the page's outline, and its links and buttons stay out of the Tab order and out of reach of a click that would leave the page and the draft. It says that it shows the editor's own words. On a narrow screen, in Write, it is folded under "See it as it is sent", so a sequence of several emails is not one long scroll.

- The blog editor now shows "As it is published" beside the text on a wide screen, folded on a narrow one. It is drawn by the blog page's own drawing (`PostBody`), in the store's look, from what is typed now. It starts at phone width with a Phone or Wide choice, and is inert, like the email's preview. Wide is the published page's own width (672 px), and the title its size.
- A course lesson's text now shows "As students see it" beside it on a wide screen, folded on a narrow one. It is drawn by the lesson page's own drawing (`LessonText`), in the store's look and its text color, inside the same card the lesson page puts behind the words, from what is typed now. It starts at phone width with a Phone or Wide choice, and is inert, like the others.

**Found on the way, not changed here.** The store's muted text on the "sand" theme is 6.51:1 (#5c5244 on #f3ece0, `lib/store-look.ts`), below the 7:1 AAA asks for small text. It is used on published store pages too, so it is the theme's to fix, in its own unit, with every page that uses it checked. The "light" (8.70:1) and "night" (10.14:1) themes pass.

**Still to do, most used first, each with what it needs:**
- **The product editor, its price and buy box.** The product form now previews the product's own words ("As buyers see it"): its name, its summary, and its full description. The description is drawn by `ProductAbout` (`components/product-about-view.tsx`), now shared with the product page, so the two cannot draw it differently. The preview is beside the description on a wide screen, folded on a narrow one, starts at phone width, and is inert. The price and the buy box are not in it: the page draws them from server-only code (`lib/store-checkout.ts`, the sale, the visitor's country), and a preview that guessed them could show a price the page does not. It says so.
- **Checkout settings.** The checkout is Stripe's own hosted page, so it cannot be drawn here faithfully. A preview there would be a guess, so none is shown. The honest way to see it is a test checkout in the creator's Stripe test mode.
- **The community composer.** Its words are in the buyer's language, in seven languages, so a preview's sentences need writing in each of them under the rules for buyer languages.

## Where each pattern stands

Numbered as in 487 [IT4]:
1. Checked when the field is left: first pass done for every web address field (see pattern 1), except the tracking link, held by an open PR. Other kinds of field not yet audited.
2. The right keyboard on a phone: done (see pattern 2); "Move to" in its own PR, now that its file is free.
3. The common value filled in, never the dearest: audited (see pattern 3). The "Recommended" price option waits on the owner.
4. A label always visible: two passes done (see pattern 4). The home page field remains.
5. Empty screens with a sentence, a button and a ready example: first pass done (see pattern 5). Four screens fixed; ready examples for five screens still to write.
6. Drafts never lost: done for the editors read (see pattern 6). Saving by itself, with "Saving…" and "Saved", has its rules (`lib/autosave-rules.ts`, below); no editor uses them yet, and none can until its server count exists.
7. A live phone preview beside each editor: first pass done (see pattern 7). The page, email, blog and lesson editors have it, and the product form for its own words; checkout and community are listed.
8. A "Check answers" summary with "Change" on each item before publishing or sending: first pass done (see pattern 8); the email broadcast, the waitlist's sale, the update email and a published price change have it; the rest listed.
