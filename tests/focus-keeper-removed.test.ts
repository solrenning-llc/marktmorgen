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
  k.focusOut(button); // left on purpose, still on the page
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
