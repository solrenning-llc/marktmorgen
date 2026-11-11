/**
 * The studio's start page draws, on each product card and around it, controls
 * that look like underlined words: "Ship it: a physical product, sent by you",
 * "Give each buyer a unique license key", "Sell this as a private podcast",
 * "Sell this as a bundle of your products", "Set a goal for the month" and the
 * "Already done" list. Each stands alone on its line, not inside a sentence,
 * so WCAG 2.2 2.5.5 Target Size (Enhanced, AAA; AX274 Part A item 4) asks for
 * 44 × 44 px. Measured in Chromium at 390 and 1280 px they were 18–20 px tall.
 * Each one now takes min-h-11 (44px) with its words centered on that height.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const read = (path: string) => readFileSync(path, "utf8");
const tall = (c: string) => /\bmin-h-11\b/.test(c) && /\b(inline-)?flex\b/.test(c) && /\bitems-center\b/.test(c);
/** The className of the element whose text or class name constant is given. */
const constant = (src: string, name: string) => new RegExp(`const ${name} = "([^"]*)"`).exec(src)?.[1] ?? "";
/** The className of the JSX element that opens just before the given words. */
const before = (src: string, words: string) => {
  const at = src.indexOf(words);
  if (at < 0) return "";
  const open = src.lastIndexOf("<", at);
  return /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{(\w+)\})/.exec(src.slice(open, at))?.slice(1).find(Boolean) ?? "";
};

const shipping = read("components/shipping-editor.tsx");
is("shipping: its quiet link style is a 44px target", tall(constant(shipping, "link")), true);
is("shipping: the opener on a line of its own is not forced back to a plain block", shipping.includes("className={`block ${link}`}"), false);

const keys = read("components/licence-key-editor.tsx");
is("license keys: its quiet button style is a 44px target", tall(constant(keys, "quiet")), true);

is("private podcast: the opener is a 44px target", tall(before(read("components/podcast-toggle.tsx"), "Sell this as a private podcast")), true);
is("bundle: the opener is a 44px target", tall(before(read("components/bundle-toggle.tsx"), "Sell this as a bundle of your products")), true);

const goal = read("components/sales-goal-card.tsx");
const goalButton = /<button type="button" className="([^"]*)" onClick=\{\(\) => setEditing\(true\)\}>/.exec(goal)?.[1] ?? "";
is("sales goal: the set or change button is a 44px target", tall(goalButton), true);

const coach = read("components/store-coach.tsx");
const summary = /<summary className="([^"]*)">\{`Already done/.exec(coach)?.[1] ?? "";
// A summary keeps its own display, so its open/closed triangle stays: 12px + a 20px line + 12px = 44px.
is("store coach: the \"Already done\" summary is a 44px target", /\bmin-h-11\b/.test(summary) && /\bpy-3\b/.test(summary), true);
is("and its open/closed marker stays visible (not turned into a flex box, no list-none)", /\b(inline-)?flex\b|\blist-none\b/.test(summary), false);

done();
