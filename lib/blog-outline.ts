/**
 * Ready outlines to start a blog post from (487 [IT4], item 5: no empty
 * screen without a ready example; added 2 November 2026). Each is the shape
 * of a kind of post, in the blog's own writing (lib/store-blog.ts: "## " for
 * a heading, "- " for a point), with every part the creator writes marked in
 * [brackets]. Nothing in them is a claim, a figure or a quotation: they say
 * what goes where, never what the creator thinks.
 *
 * A post is never published with one of these prompts still in it: the blog
 * route refuses it, and the editor says which to replace. It can be kept as a
 * draft. Only the exact prompts below are looked for, so the creator's own
 * words in brackets ("[Updated]") are never taken for one.
 */

export type BlogOutline = { id: string; name: string; body: string };

export const BLOG_OUTLINES: BlogOutline[] = [
  {
    id: "how-to",
    name: "How to do one thing",
    body: [
      "[In one or two sentences: what your reader will be able to do by the end.]",
      "",
      "## What you need first",
      "- [Something they need before starting]",
      "",
      "## The steps",
      "- [The first step, in one sentence]",
      "- [The next step]",
      "- [The last step]",
      "",
      "## What to do next",
      "[One sentence on where to go from here.]",
    ].join("\n"),
  },
  {
    id: "mistakes",
    name: "Mistakes to avoid",
    body: [
      "[In one or two sentences: who this is for, and what goes wrong for them.]",
      "",
      "## [The first mistake]",
      "[Why it happens, and what to do instead.]",
      "",
      "## [The second mistake]",
      "[Why it happens, and what to do instead.]",
      "",
      "## [The third mistake]",
      "[Why it happens, and what to do instead.]",
      "",
      "## In short",
      "[One sentence your reader should remember.]",
    ].join("\n"),
  },
  {
    id: "question",
    name: "Answer one question",
    body: [
      "[The question, as your readers ask it.]",
      "",
      "## The short answer",
      "[Your answer in two or three sentences.]",
      "",
      "## Why",
      "[What the answer depends on, and an example from your own work.]",
      "",
      "## When the answer is different",
      "[The case where you would say something else.]",
    ].join("\n"),
  },
];

/** Every prompt the outlines hold, each once: the parts in [brackets]. */
export const OUTLINE_PROMPTS: string[] = [...new Set(BLOG_OUTLINES.flatMap((outline) => outline.body.match(/\[[^\]\n]+\]/g) ?? []))];

/** The outlines' prompts still in a post's title or words, in the order they appear; empty when none is left. */
export function outlinePromptsLeft(title: string, body: string): string[] {
  const text = `${title}\n${body}`;
  return OUTLINE_PROMPTS.filter((prompt) => text.includes(prompt)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/** What the editor says when a post still holds a prompt. */
export const OUTLINE_LEFT_MESSAGE = "Replace each part in [brackets] from the outline with your own words before publishing. You can save it as a draft now.";
