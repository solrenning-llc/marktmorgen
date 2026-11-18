/**
 * The AC section of AGENTS.md (anti-conflict rules, owner 14 and 15 November 2026) agrees with the rules it sits
 * beside (Claude 7 on #4578, 6893425594):
 *   - one record of the owner's request (Pedidos repetidos), with the 15/11 sentence that only the closed duplicate
 *     #4640 carried, and the two points where the versions differ left to the owner;
 *   - its limit is MV (b)'s own, counting only the PRs that depend on their author, with MV (b)'s exceptions;
 *   - it never tells an agent to add alias lines to tests/test-config.mjs, which that file forbids;
 *   - its push, conflict and queue rules keep MV (a)'s stop while the main-vermelho issue is open;
 *   - it finds colliding PRs with git, not one API call per PR (AV10 (3));
 *   - its scan rides the inbox watcher or the Codex's hourly task (AV9, AV11), with no reminder of a session's own.
 *   - it does not override the channel rules it sits beside (Claude 4 on #4578, 6900641796): enqueueing follows
 *     ALL-236 B's faucet, not a coordinator batch; (i) says it replaces ALL-236 A7; every push waits for the agent's
 *     minute and the traffic light (ALL-236 A3/A4); an old stack base is merged only on a conflict or a check that
 *     fails because of its age (MV (c)).
 * Reads the files as they are; no network.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const agents = readFileSync("AGENTS.md", "utf8");
const start = agents.indexOf("\n## AC — ");
const end = start < 0 ? -1 : agents.indexOf("\n## ", start + 1);
const ac = start < 0 ? "" : agents.slice(start, end < 0 ? undefined : end);
const rule = (letter: string): string => {
  const at = ac.indexOf(`\n(${letter}) **`);
  if (at < 0) return "";
  const next = ac.slice(at + 1).search(/\n(?:\([a-z]\) \*\*|\*\*)/);
  return next < 0 ? ac.slice(at) : ac.slice(at, at + 1 + next);
};
const config = readFileSync("tests/test-config.mjs", "utf8");

part("One record of the owner's request");
is("one AC section in AGENTS.md", (agents.match(/\n## AC — /g) ?? []).length, 1);
is("the 15/11 sentence is quoted", ac.includes('"faça regras para nao ocorrer mais conflitos" (dono, 15/11/2026)'), true);
is("the 23h29 words are the owner's, said to Claude 4", ac.includes("(dono, a Claude 4, 23h29)"), true);
is("the closed duplicate is named, and the differences are left to the owner", [ac.includes("#4640"), ac.includes("**Depende do dono**")], [true, true]);

part("The limit is MV (b)'s own");
const h = rule("h");
is("it counts only the PRs that depend on their author", h.includes("dependem do próprio autor"), true);
is("it does not count every PR outside the queue", h.includes("fora da fila"), false);
is("it keeps MV (b)'s exceptions", [h.includes("main vermelho"), h.includes("GRAVE ou ALTO")], [true, true]);

part("Aliases: only in tests/aliases, as tests/test-config.mjs says");
is("tests/test-config.mjs forbids new lines in its list", /add nothing here/.test(config) && /tests\/aliases\/<test file>\.json/.test(config), true);
is("AC does not list tests/test-config.mjs's aliases among the registries to add to", rule("d").includes("aliases de tests/test-config.mjs"), false);
is("AC sends aliases to tests/aliases", rule("d").includes("tests/aliases/<arquivo>.json"), true);

part("MV (a)'s stop while main is red");
for (const letter of ["a", "b", "k"]) is(`(${letter}) keeps it`, rule(letter).includes("main-vermelho") && rule(letter).includes("MV (a)"), true);

part("Collisions found with git, and the scan's clock");
is("(e) finds colliding PRs with git, once a sweep", rule("e").includes("git fetch origin '+refs/pull/*/head:refs/pr/*'"), true);
is("(c) rides the inbox watcher or the Codex's hourly task", rule("c").includes("AV11") && rule("c").includes("AV9"), true);
is("no term defined only in the channel", [ac.includes("ritmo de 1 push a cada 5 a 20 minutos"), ac.includes("duas revisões READY de famílias diferentes")], [false, false]);

part("The channel rules it sits beside (ALL-236 A3/A4, A7, B; MV (c))");
const k = rule("k");
is("(k) has no coordinator batch", [k.includes("o coordenador enfileira"), k.includes("antes de qualquer trabalho novo")], [false, false]);
is("(k) leaves enqueueing to ALL-236 B's faucet", k.includes("o enfileiramento segue a torneira em vigor (ALL-236 B)"), true);
is("(i) says it replaces ALL-236 A7", rule("i").includes("Substitui ALL-236 A7") && rule("i").includes("nesse ponto"), true);
for (const letter of ["a", "b"]) is(`(${letter}) pushes only at the agent's minute and with the traffic light`, rule(letter).includes("no seu minuto e com o semáforo (ALL-236 A3/A4"), true);
const j = rule("j");
is("(j) no longer merges main into every old base", j.includes("O autor junta o main na base e a base no PR, ou"), false);
is("(j) merges only on a conflict or a check failing for the base's age", [j.includes("só se o `git merge-tree` da base contra o main tiver conflito"), j.includes("reprovar por causa da idade da base")], [true, true]);
is("(j) does not merge a clean base (MV (c))", j.includes("com `git merge-tree` limpo e verificações verdes, não junta (MV (c))"), true);
is("(j) changes the base to main without merging when it is in or closed", j.includes("muda a base para `main`, sem juntar"), true);

done();
