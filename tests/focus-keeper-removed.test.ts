/**
 * The studio's focus keeper, second part (lib/focus-keeper.ts; AX274 Part A;
 * WCAG 2.2 2.4.3 Focus Order). Seen in Chromium on 11 November 2026 on
 * /studio, keyboard only, every button pressed in turn: about twenty buttons
 * that open an editor in their own place ("Add your profiles", "Change my
 * address", "Set a goal for the month", "Ship it…", "Offer a payment plan",
 * "Tell buyers about an update", "Make a cover"…) were taken off the page
 * under the focus, and "Move … up" / "Move … down" moved the section the
 * focus was in; each time the focus fell to the page's body.
 *
 * Now, when the focus is nowhere after the page changed: a control that was
 * only moved gets it back; a control that was taken away hands it to the
 * first control of the nearest part of the page still there, the editor that
 * took its place, but only inside the page's main content, never when the
 * page itself was replaced (a navigation). A focus somewhere else is never
 * taken, and a control left on purpose is never taken back.
 */
import { readFileSync } from "node:fs";
import { focusKeeper, type KeptElement } from "@/lib/focus-keeper";
import { done, is, part } from "./check";

type El = KeptElement & { name: string; focused: number; main?: boolean; first?: El | null };
const body = { name: "body" };
let active: unknown = body;
const el = (name: string, parent: El | null = null, extra: Partial<El> = {}): El => {
  const e: El = {
    name,
    disabled: false,
    isConnected: true,
    parentElement: parent,
    focused: 0,
    focus() {
      e.focused++;
      active = e;
    },
    ...extra,
  };
  return e;
};
const place = {
  inMain: (e: KeptElement) => {
    for (let at: KeptElement | null | undefined = e; at; at = at.parentElement) if ((at as El).main) return at !== e;
    return false;
  },
  firstControlIn: (e: KeptElement) => (e as El).first ?? null,
  contains: (outer: KeptElement, inner: KeptElement) => {
    for (let at: KeptElement | null | undefined = inner; at; at = at.parentElement) if (at === outer) return true;
    return false;
  },
};
const fresh = () => {
  active = body;
  return focusKeeper(() => active, body, place);
};

part("A control taken away under the focus");
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const opener = el("Add your profiles", card);
  const field = el("first field", card);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false; // the editor takes its place
  opener.parentElement = null;
  card.first = field;
  active = body;
  k.treeChanged();
  is("the focus goes to the first control of the nearest part still there", [field.focused, active === field], [1, true]);
}
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const section = el("section", main);
  const card = el("card", section);
  const opener = el("opener", card);
  const field = el("field", section);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  card.isConnected = false; // the whole card went too
  section.first = field;
  active = body;
  k.treeChanged();
  is("when its part went too, the next part up that is still there", field.focused, 1);
}
{
  const k = fresh();
  const shell = el("layout");
  const main = el("main", shell, { main: true });
  const link = el("a link", main);
  active = link;
  k.focusIn(link);
  link.isConnected = false;
  main.isConnected = false; // a navigation replaced the page
  shell.first = el("skip link", shell);
  active = body;
  k.treeChanged();
  is("never when the page itself was replaced", (shell.first as El).focused, 0);
}
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const opener = el("opener", main);
  main.first = el("first in main", main);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  active = body;
  k.treeChanged();
  is("nor when only the main region itself is left, which is the page changing", (main.first as El).focused, 0);
}

{
  // Seen in Chromium: blur and focusout reach the button while it is still on the page, a moment before React takes
  // it away. That is not a person leaving it.
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const opener = el("Change my address", card);
  const field = el("the address field", card);
  active = opener;
  k.focusIn(opener);
  k.focusOut(opener); // still connected here
  opener.isConnected = false;
  opener.parentElement = null;
  card.first = field;
  active = body;
  k.treeChanged();
  is("a blur just before it is taken away does not stop the focus going on", field.focused, 1);
}

{
  // Seen in Chromium on the product card: "Ship it" opened its editor further down the same card, after a waitlist box;
  // the card's first control was that box, not the editor that took the button's place.
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const waitlist = el("Coming soon, with a waitlist", card);
  const opener = el("Ship it", card);
  card.first = waitlist;
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  opener.parentElement = null;
  const editor = el("shipping editor", card);
  const price = el("Shipping price", editor);
  editor.first = price;
  active = body;
  k.treeChanged([editor]);
  is("what the change added in that part comes first: the editor that took its place", [price.focused, waitlist.focused], [1, 0]);
}

{
  // Seen in Chromium: "Set a goal for the month" sits in a row of its own; its form is added a level above, beside the
  // row, which is left with no control.
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("goal card", main);
  const row = el("title row", card);
  const opener = el("Set a goal for the month", row);
  card.first = el("a control earlier in the card", card);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  opener.parentElement = null;
  const form = el("goal form", card);
  const amount = el("Each month, in USD", form);
  form.first = amount;
  active = body;
  k.treeChanged([form]);
  is("the editor added a level up, beside the button's own row, gets the focus", [amount.focused, (card.first as El).focused], [1, 0]);
}
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const page = el("page column", main);
  const a = el("a", page);
  const b = el("b", a);
  const c = el("c", b);
  const d = el("d", c);
  const notice = el("notice", d);
  const dismiss = el("Dismiss", notice);
  page.first = el("the page's first control", page);
  active = dismiss;
  k.focusIn(dismiss);
  dismiss.isConnected = false;
  notice.isConnected = false; // taken away with nothing in its place
  active = body;
  k.treeChanged([]);
  is("with nothing added, it does not climb far to an unrelated control at the top", (page.first as El).focused, 0);
}

part("A control moved under the focus");
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const move = el("Move Contact form down", main);
  active = move;
  k.focusIn(move);
  move.isConnected = false; // out of the page while it is moved
  k.focusOut(move); // a browser may blur it then
  move.isConnected = true; // back in its new place
  active = body;
  k.treeChanged();
  is("it gets the focus back", [move.focused, active === move], [1, true]);
}

part("A click on the control itself");
{
  // Claude 3 (cloud C)'s LOW on this PR: clicking the Save that already has the focus brings a pointerdown but no
  // focusin, so it must not count as leaving it.
  const k = fresh();
  const main = el("main", null, { main: true });
  const save = el("Save", main);
  const icon = el("Save's icon", save);
  active = save;
  k.focusIn(save);
  k.pointerDown(icon); // a click on its icon, inside it
  save.disabled = true;
  k.disabledChanged(save);
  active = body;
  save.disabled = false;
  k.disabledChanged(save);
  is("a click on the focused control, or inside it, is not leaving it", save.focused, 1);
}
{
  // Revisor 1's LOW: the click lands on the icon's <svg> or <path>, which the studio wiring must pass on as well.
  const wiring = readFileSync("components/studio-app.tsx", "utf8");
  is("the studio passes any element clicked, an icon's SVG included, not only HTML elements", /const onPointer = \(event: PointerEvent\) => keeper\.pointerDown\(event\.target instanceof Element \? \(event\.target as Element & KeptElement\) : null\);/.test(wiring), true);
}

part("It never takes the focus from anything else");
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const opener = el("opener", card);
  card.first = el("field", card);
  const other = el("other", main);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  active = other; // focus already went somewhere
  k.treeChanged();
  is("a focus somewhere is left there", (card.first as El).focused, 0);
}
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const button = el("button", card);
  card.first = el("field", card);
  active = button;
  k.focusIn(button);
  k.pointerDown(); // left on purpose: a click elsewhere on the page
  k.focusOut(button);
  active = body;
  button.isConnected = false;
  k.treeChanged();
  is("a control left on purpose is never taken back or replaced", [button.focused, (card.first as El).focused], [0, 0]);
}
{
  const k = focusKeeper(() => active, body);
  const main = el("main", null, { main: true });
  const opener = el("opener", main);
  active = opener;
  k.focusIn(opener);
  opener.isConnected = false;
  active = body;
  k.treeChanged();
  is("without a page to look in, nothing is moved", opener.focused, 0);
}
{
  const k = fresh();
  const main = el("main", null, { main: true });
  const card = el("card", main);
  const save = el("save", card);
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  active = body;
  k.treeChanged();
  is("a control only turned off waits to be on again (the first part)", save.focused, 0);
  save.disabled = false;
  k.disabledChanged(save);
  is("and gets it back then", save.focused, 1);
}

done();
