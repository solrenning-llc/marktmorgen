/**
 * The studio's focus keeper (lib/focus-keeper.ts, wired in
 * components/studio-app.tsx; AX274 Part A; WCAG 2.2 2.4.3 Focus Order).
 *
 * Seen in Chromium on 11 November 2026, /studio/email, keyboard only: Enter on
 * Save set disabled={busy} on the button that had the focus, the browser moved
 * the focus to the page's body, and when the save ended the button came back
 * on but the focus did not: the next Tab started again from the top of the
 * page. The same disabled={busy} is on 232 controls in 93 studio components.
 *
 * The keeper puts the focus back on the control that was turned off under it,
 * once it is turned on again, if the focus is still nowhere (the body) and the
 * person has not gone somewhere else meanwhile. It never takes the focus from
 * anything else, and never moves it to a control that has left the page.
 */
import { focusKeeper, type KeptElement } from "@/lib/focus-keeper";
import { done, is, part } from "./check";

const body = { name: "body" };
let active: unknown = body;
const make = (name: string) => {
  const el: KeptElement & { name: string; focused: number } = {
    name,
    disabled: false,
    isConnected: true,
    focused: 0,
    focus() {
      el.focused++;
      active = el;
    },
  };
  return el;
};
const fresh = () => {
  active = body;
  return focusKeeper(() => active, body);
};

part("A control turned off under the focus, then on again");
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  k.focusOut(save); // the browser blurs it because it is off
  active = body;
  save.disabled = false;
  k.disabledChanged(save);
  is("the focus goes back to it", [save.focused, active === save], [1, true]);
  save.disabled = true;
  k.disabledChanged(save);
  save.disabled = false;
  active = body;
  k.disabledChanged(save);
  is("and again the next time it is busy", save.focused, 2);
}
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  active = body;
  save.disabled = false;
  k.disabledChanged(save);
  is("also when the browser sends no focusout", save.focused, 1);
}

part("It never takes the focus from anything else");
{
  const k = fresh();
  const save = make("save");
  const field = make("field");
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  active = field;
  k.focusIn(field); // the person moved on while it saved
  save.disabled = false;
  k.disabledChanged(save);
  is("a person who moved on keeps their place", [save.focused, active === field], [0, true]);
}
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  const other = { name: "other" };
  active = other; // focus went somewhere the keeper did not hear of
  save.disabled = false;
  k.disabledChanged(save);
  is("the focus that is somewhere is left there", save.focused, 0);
}
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  k.focusOut(save); // a click on the page's background: left while still on
  active = body;
  save.disabled = true;
  k.disabledChanged(save);
  save.disabled = false;
  k.disabledChanged(save);
  is("a control left on purpose before it was turned off is not taken back", save.focused, 0);
}
{
  const k = fresh();
  const save = make("save");
  const other = make("other");
  active = save;
  k.focusIn(save);
  other.disabled = true;
  k.disabledChanged(other);
  other.disabled = false;
  active = body;
  k.disabledChanged(other);
  is("another control turned off and on is not focused", other.focused, 0);
}
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  active = body;
  save.isConnected = false;
  save.disabled = false;
  k.disabledChanged(save);
  is("a control that has left the page is not focused", save.focused, 0);
}
{
  const k = fresh();
  const save = make("save");
  active = save;
  k.focusIn(save);
  save.disabled = false;
  active = body;
  k.disabledChanged(save);
  is("a change that did not turn it off first does nothing", save.focused, 0);
}
{
  const k = fresh();
  const save = make("save");
  active = null;
  k.focusIn(save);
  save.disabled = true;
  k.disabledChanged(save);
  active = null;
  save.disabled = false;
  k.disabledChanged(save);
  is("a document with no active element counts as nowhere", save.focused, 1);
}

done();
