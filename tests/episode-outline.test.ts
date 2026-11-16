/**
 * 487 [IT4], item 5 (no empty screen without a ready example), podcast episodes: "Start the notes from an outline".
 *
 * The audit (docs/ease-patterns-audit.md, Pattern 5) found that a private podcast's screen had a sentence and a
 * button but no ready example. A new episode's notes can now start from an outline (lib/episode-outline.ts) that
 * sets out what a listener looks for, with every part the creator writes in [brackets]. It holds nothing but those
 * prompts and the points' dashes, so no word in it is a claim, a figure or a word in another language than the
 * store's once the creator has written theirs.
 *
 * An episode goes out the moment it is put out (no draft), so it is never put out or changed with one of those
 * prompts still in its title or notes: lib/podcast.ts refuses it (the route returns that reason), and the editor
 * refuses it before the audio is uploaded, so no upload room is spent on a refusal. Only the exact prompts are
 * looked for, so the creator's own brackets are never taken for one.
 */
import { readFileSync } from "node:fs";
import { EPISODE_OUTLINE, EPISODE_OUTLINE_LEFT, EPISODE_OUTLINE_PROMPTS, episodePromptsLeft } from "@/lib/episode-outline";
import { editPodcast } from "@/lib/podcast";
import { MAX_EPISODE_NOTES } from "@/lib/podcast-rules";
import type { Podcast } from "@/lib/podcast-rules";
import { done, is, part } from "./check";

part("The outline");
const lines = EPISODE_OUTLINE.split("\n");
is("holds only prompts in [brackets], points that are prompts, and blank lines", lines.every((line) => line === "" || /^(- )?\[[^\]\n]+\]$/.test(line)), true);
is("four prompts or more, each once", [EPISODE_OUTLINE_PROMPTS.length >= 4, new Set(EPISODE_OUTLINE_PROMPTS).size === EPISODE_OUTLINE_PROMPTS.length], [true, true]);
is("no figure in it", /\d/.test(EPISODE_OUTLINE), false);
is("fits the notes", EPISODE_OUTLINE.length <= MAX_EPISODE_NOTES, true);
is("starts with what the episode is about", EPISODE_OUTLINE_PROMPTS[0]?.toLowerCase().includes("what this episode is about"), true);

part("A prompt left is found");
is("none in the creator's own words", episodePromptsLeft("Episode 4: Sourdough", "We talk about starters.\n- [Updated] the timings"), []);
is("in the notes, in the order they appear", episodePromptsLeft("Episode 4", EPISODE_OUTLINE), EPISODE_OUTLINE_PROMPTS);
const one = EPISODE_OUTLINE_PROMPTS[2] ?? "";
is("one left among the creator's words", episodePromptsLeft("Episode 4", `We talk about starters.\n${one}`), [one]);
is("in the title too", episodePromptsLeft(`Episode 4 ${one}`, ""), [one]);
is("a prompt edited inside its brackets is no longer one", episodePromptsLeft("Episode 4", EPISODE_OUTLINE.replace(one, "[The starter, fed twice a day]")).includes(one), false);
is("what the editor says names the brackets and that it goes out at once", /\[brackets\]/.test(EPISODE_OUTLINE_LEFT) && /goes out at once/.test(EPISODE_OUTLINE_LEFT), true);

part("An episode is never put out or changed with one left");
const podcast: Podcast = { id: "pod1", episodes: [] };
const add = (title: string, notes: string) => editPodcast(podcast, { op: "add", pathname: "stores/s/p/ep.mp3", bytes: 1_000, contentType: "audio/mpeg", title, notes, at: 1_900_000_000 });
is("put out with the outline still in its notes: refused", add("Episode 1", EPISODE_OUTLINE), { ok: false, reason: "outline_left" });
is("put out with one prompt left: refused", add("Episode 1", `Starters.\n${one}`), { ok: false, reason: "outline_left" });
const fine = add("Episode 1", "Starters, and how often to feed them.\n- [Updated] the timings");
is("put out with the creator's own words, brackets of their own included: out", fine.ok, true);
const out = fine.ok ? fine.podcast : podcast;
const id = out.episodes[0]?.id ?? "";
is("changed to hold a prompt: refused", editPodcast(out, { op: "edit", id, title: "Episode 1", notes: EPISODE_OUTLINE }), { ok: false, reason: "outline_left" });
is("changed with the creator's own words: saved", editPodcast(out, { op: "edit", id, title: "Episode 1", notes: "Feeding a starter." }).ok, true);
is("removing one is never refused for it", editPodcast(out, { op: "remove", id }).ok, true);
is("a title still checked first: an empty one says so", add("", EPISODE_OUTLINE), { ok: false, reason: "title" });

part("The editor");
const editor = readFileSync("components/podcast-editor.tsx", "utf8");
is("offers the outline under the new episode's notes, explained by its help", editor.includes("Start the notes from an outline") && /aria-describedby=\{`episode-outline-help-\$\{id\}`\}/.test(editor) && editor.includes('id={`episode-outline-help-${id}`}'), true);
is("only into empty notes: nothing typed is replaced", /if \(notes\.trim\(\)\) return;\s*setNotes\(EPISODE_OUTLINE\);/.test(editor), true);
is("the focus goes to the notes, the first part selected", editor.includes("field.setSelectionRange(start, EPISODE_OUTLINE.indexOf(\"]\", start) + 1);"), true);
is("the notes have a visible label tied to them", editor.includes('htmlFor={`episode-notes-${id}`}') && editor.includes('id={`episode-notes-${id}`}'), true);
const publish = editor.slice(editor.indexOf("async function publish()"), editor.indexOf("const newest"));
is("refused before the upload, so no upload room is spent", publish.indexOf("episodePromptsLeft(title, notes).length") > -1 && publish.indexOf("episodePromptsLeft(title, notes).length") < publish.indexOf("uploadSoldFile("), true);
is("the route's refusal has its words", /outline_left: EPISODE_OUTLINE_LEFT/.test(editor), true);
const route = readFileSync("app/api/store/podcast/route.ts", "utf8");
is("the route returns editPodcast's own reason", route.includes("const result = editPodcast(podcast, edit);") && route.includes("return fail(result.reason);"), true);

done();
