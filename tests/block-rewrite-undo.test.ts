/**
 * "Improve with AI" under a sales-page block (components/block-rewrite.tsx) never loses what the creator typed.
 *
 * 1. Typed while a rewrite runs: the rewrite that comes back must not overwrite those words.
 * 2. Typed after a rewrite: Undo must not throw those words away by putting back the copy from before the rewrite.
 *
 * The real component runs under a small hook dispatcher (useState, useId, useContext, useRef), re-rendered with the
 * block its editor holds now, as the page editor re-renders it on every keystroke.
 */
import * as React from "react";
import { BlockRewrite } from "@/components/block-rewrite";
import type { PageBlock, SalesPage } from "@/lib/sales-page";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function harness(initial: PageBlock) {
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
  };
  function render(): void {
    index = 0;
    const before = internals.H;
    internals.H = dispatcher;
    try {
      tree = BlockRewrite({ productId: "prod000001", block, page: () => ({ blocks: [block] }) as unknown as SalesPage, onChange: (next: PageBlock) => { block = next; render(); } });
    } finally {
      internals.H = before;
    }
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

  part("Undo after more typing does not throw the new words away");
  {
    const h = harness(original);
    h.press(/Shorter|Clearer|Warmer|Simpler|Punchier/);
    answer!();
    await settle(); await settle();
    is("the rewrite is in", h.block, rewritten);
    is("Undo is offered right after it", h.has(/Undo/), true);
    const edited = { ...rewritten, body: (rewritten as { body: string }).body + " Every Saturday." } as PageBlock;
    h.type(edited);
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
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
