/**
 * "Improve with AI" under a sales-page block (components/block-rewrite.tsx) never loses what the creator typed.
 *
 * 1. Typed while a rewrite runs: the rewrite that comes back must not overwrite those words.
 * 2. Typed after a rewrite: Undo must not throw those words away by putting back the copy from before the rewrite.
 *
 * The real component runs under a small hook dispatcher (useState, useId, useContext, useRef, useEffect, useLayoutEffect),
 * re-rendered with the block its editor holds now, as the page editor re-renders it on every keystroke. As in React, a
 * layout effect runs inside the commit, before anything else can happen; a passive effect (useEffect) may run later,
 * after the browser has already settled a fetch, so the harness can hold passive effects back to reproduce that.
 */
import * as React from "react";
import { BlockRewrite } from "@/components/block-rewrite";
import type { PageBlock, SalesPage } from "@/lib/sales-page";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function harness(initial: PageBlock, { holdPassive = false }: { holdPassive?: boolean } = {}) {
  const slots: unknown[] = [];
  let index = 0;
  let block = initial;
  let tree: unknown = null;
  const dispatcher = {
    useState(init: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(slots[i]) : next; render(); }];
    },
    useRef(init: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useId() { index++; return "id"; },
    useContext() { return { on: true, left: 10 }; },
    // As React does: an effect runs after the render that asked for it, again whenever one of its deps changed.
    useEffect(effect: () => void, deps?: unknown[]) {
      const i = index++;
      const prev = slots[i] as unknown[] | undefined;
      if (!deps || !prev || deps.some((d, n) => !Object.is(d, prev[n]))) {
        slots[i] = deps;
        effects.push(effect);
      }
    },
    // Runs inside the commit itself: nothing (no settled fetch) can come between the render and it.
    useLayoutEffect(effect: () => void, deps?: unknown[]) {
      const i = index++;
      const prev = slots[i] as unknown[] | undefined;
      if (!deps || !prev || deps.some((d, n) => !Object.is(d, prev[n]))) {
        slots[i] = deps;
        layoutEffects.push(effect);
      }
    },
  };
  const effects: (() => void)[] = [];
  const layoutEffects: (() => void)[] = [];
  function render(): void {
    index = 0;
    const before = internals.H;
    internals.H = dispatcher;
    try {
      tree = BlockRewrite({ productId: "prod000001", block, page: () => ({ blocks: [block] }) as unknown as SalesPage, onChange: (next: PageBlock) => { block = next; render(); } });
    } finally {
      internals.H = before;
    }
    for (const effect of layoutEffects.splice(0)) effect();
    if (!holdPassive) for (const effect of effects.splice(0)) effect();
  }
  render();
  const buttons = (): Node[] => {
    const out: Node[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const node = n as Node;
      if (node.type === "button") out.push(node);
      walk(node.props?.children);
    };
    walk(tree);
    return out;
  };
  const label = (n: Node) => JSON.stringify(n.props?.children);
  return {
    get block() { return block; },
    /** The creator types in the block's own fields (not this component). */
    type(next: PageBlock) { block = next; render(); },
    press(match: RegExp) {
      const b = buttons().find((n) => match.test(label(n)) && !n.props?.disabled);
      if (!b) return false;
      (b.props!.onClick as () => void)();
      return true;
    },
    has(match: RegExp) { return buttons().some((n) => match.test(label(n))); },
    /** Every string rendered anywhere in the tree, buttons or not. */
    text() {
      const out: string[] = [];
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n === "string") return void out.push(n);
        if (!n || typeof n !== "object") return;
        walk((n as Node).props?.children);
      };
      walk(tree);
      return out.join(" ");
    },
  };
}

const original: PageBlock = { id: "b1", kind: "text", heading: "Bread", body: "Learn to bake bread at home." } as PageBlock;
const rewritten: PageBlock = { id: "b1", kind: "text", heading: "Bread", body: "Bake real bread in your own kitchen." } as PageBlock;
const typed: PageBlock = { id: "b1", kind: "text", heading: "Bread", body: "Learn to bake sourdough at home, step by step." } as PageBlock;

let answer: (() => void) | null = null;
globalThis.fetch = (() => new Promise<Response>((resolve) => {
  answer = () => resolve(new Response(JSON.stringify({ ok: true, value: rewritten, left: 9 }), { status: 200 }));
})) as typeof fetch;
const settle = () => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  part("Words typed while a rewrite runs are kept");
  {
    const h = harness(original);
    is("a rewrite button is there", h.press(/Shorter|Clearer|Warmer|Simpler|Punchier/), true);
    h.type(typed);
    answer!();
    await settle(); await settle();
    is("the block still holds what was typed", h.block, typed);
  }

  part("Words typed while a rewrite runs are kept even when the answer lands before passive effects run");
  {
    // The fetch settles after the editor committed the typed block but before React flushed passive effects.
    const h = harness(original, { holdPassive: true });
    is("a rewrite button is there", h.press(/Shorter|Clearer|Warmer|Simpler|Punchier/), true);
    h.type(typed);
    answer!();
    await settle(); await settle();
    is("the block still holds what was typed", h.block, typed);
  }

  part("Undo after more typing does not throw the new words away");
  {
    const h = harness(original);
    h.press(/Shorter|Clearer|Warmer|Simpler|Punchier/);
    answer!();
    await settle(); await settle();
    is("the rewrite is in", h.block, rewritten);
    is("Undo is offered right after it", h.has(/Undo/), true);
    is("the status line names Undo while the button is there", /Undo puts it back/.test(h.text()), true);
    const edited = { ...rewritten, body: (rewritten as { body: string }).body + " Every Saturday." } as PageBlock;
    h.type(edited);
    // Claude 1 rev-odd's MEDIUM on #3871: once Undo is hidden, no line may still tell the creator to use it.
    is("Undo is hidden after more typing", h.has(/Undo/), false);
    is("no status line mentions an Undo that is not there", /Undo/.test(h.text()), false);
    h.press(/Undo/);
    is("the edit made after the rewrite is still there", h.block, edited);
  }

  part("Undo straight after a rewrite still puts the words back");
  {
    const h = harness(original);
    h.press(/Shorter|Clearer|Warmer|Simpler|Punchier/);
    answer!();
    await settle(); await settle();
    is("Undo pressed", h.press(/Undo/), true);
    is("the block is as before the rewrite", h.block, original);
  }

  // Claude 1's MEDIUM on #3871: the page editor's onChange is kept from the render where the button was pressed. Written
  // by position, a rewrite that comes back after the blocks were reordered (or the page replaced) lands on whatever
  // block now sits there and its words are lost. Written by the block's own id, it reaches only that block.
  part("The page editor writes a rewrite into the block it was asked for, by id, never by position");
  {
    const editor = readFileSync("components/page-editor.tsx", "utf8");
    const at = editor.indexOf("<BlockRewrite");
    const tag = editor.slice(at, editor.indexOf("/>", at));
    const onChange = /onChange=\{([^\n]*)\}/.exec(tag)?.[1] ?? "";
    is("the BlockRewrite's onChange is found", onChange.length > 0, true);
    is("it matches the draft by the block's id", /\.block\.id === block\.id/.test(onChange), true);
    is("it never matches by the draft's index", /\bi === index\b/.test(onChange), false);
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
