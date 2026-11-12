import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

// Completeness audit, lot 8 (docs/completeness-audit/lot-08.json, PR #2718).
// The audit read main 6725b5c97 (05/11/2026 20h28 Fortaleza). The PRs below were
// still open then and were merged afterwards (read from the GitHub API on
// 07/11/2026). A current-state line, a proposed state correction or a complement
// must not call any of them open; the snapshot evidence may, but only when its
// item carries an `atualizacao` that names the PR with its merge commit.
type Item = {
  n: number;
  etiqueta: string;
  prova_do_estado: string;
  correcao_estado: string;
  pedidos: { prova: string }[];
  complemento: string;
  atualizacao?: string;
};
const lot = JSON.parse(readFileSync("docs/completeness-audit/lot-08.json", "utf8")) as { itens: Item[] };
const queue = readFileSync("docs/codex-queue.md", "utf8").split("\n");

const MERGED_AFTER_AUDIT: Record<number, string> = {
  1730: "8f73f9d31b1cc912bb127ce9259601d739732981",
  1821: "835b70a531c45271c2e8fc7517b53dc0df302f3d",
  1856: "7903ae96aa2b4218086d3250b2e44c0a43990426",
  1928: "c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92",
  1962: "6c8f5c40918311bd81a7e29344f080ddafb323c5",
  1963: "749dac81607b76156be9eea039e34eb1f733c081",
  1969: "0ade0faf3478ca554226b3f80e1866de82276ca9",
  1990: "9bca8b16b12721c07b6a21aea1b187ad9c384ccd",
  2565: "ba310cc2c9021032f745d801c1e2fee989f19c16",
  2581: "7760b146fa645849bfefa357dc4c17f7c76d8ea3",
  2627: "138eec869865a2f77159639cfc3dc4c53bd9848e",
  2629: "e48d114daaa25fe547e6a09c40ca1b259cd6bcb8",
  2686: "07c7a963132e56d21b6d2038edc522c314746d49",
  2696: "9d8abcc8b5987595d45785ddba9488cda67186c0",
  2704: "e3be1cd01bd3234727f13fa4a7cb3aef9559279c",
};

/** PRs of the table above that a sentence of `text` calls open. */
function calledOpen(text: string): number[] {
  const found = new Set<number>();
  for (const sentence of text.split(/;|\.\s+(?=[A-ZÀ-Ý"(])/)) {
    if (!/\babert[oa]s?\b|\bopen\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(/#(\d{4})\b/g)) {
      const pr = Number(match[1]);
      if (MERGED_AFTER_AUDIT[pr]) found.add(pr);
    }
  }
  return [...found].sort();
}

/** The queue lines from an item's numbered title (or, when it has none, the
 * "Etiqueta" line of its own section) to the next item or section. */
function block(item: Item): string[] {
  const titles = [new RegExp(`^${item.n}\\. \\[${item.etiqueta}\\]`), new RegExp(`^Etiqueta: \\[${item.etiqueta}\\], item ${item.n}\\.`)];
  const at = (title: RegExp) => queue.flatMap((line, i) => (title.test(line) ? [i] : []));
  const starts = at(titles[0]).length > 0 ? at(titles[0]) : at(titles[1]);
  if (starts.length !== 1) return [`(title of ${item.n} [${item.etiqueta}] found ${starts.length} times)`];
  const end = queue.findIndex((line, i) => i > starts[0] && /^(\d+\. \[|## |Etiqueta: \[)/.test(line));
  return queue.slice(starts[0], end < 0 ? undefined : end);
}

const STATE = "Estado atual (auditoria de completude, 05/11/2026, C4-20261105-1940-C5-4)";
const lines = new Map(lot.itens.map((item) => [item.n, block(item)]));
const lotLines = (item: Item) =>
  (lines.get(item.n) ?? []).filter((line) => line.startsWith(STATE) || (item.complemento !== "" && line === item.complemento));

part("Lot 8 is the 26 items it says it is");
is("26 items", lot.itens.length, 26);
is("every item title is found once in the queue", lot.itens.flatMap((item) => (lines.get(item.n) ?? []).filter((l) => l.startsWith("(title"))), []);

part("Every complement is byte-identical in its item of the queue");
is(
  "no complement is missing from its item",
  lot.itens.filter((item) => item.complemento !== "" && !(lines.get(item.n) ?? []).includes(item.complemento)).map((item) => item.n),
  [],
);

part("No current-state line, correction or complement calls a PR merged after the audit open");
is(
  "queue lines of lot 8",
  lot.itens.flatMap((item) => lotLines(item).flatMap((line) => calledOpen(line).map((pr) => `${item.n}: #${pr}`))),
  [],
);
is(
  "JSON correcao_estado and complemento",
  lot.itens.flatMap((item) => [item.correcao_estado, item.complemento].flatMap((t) => calledOpen(t).map((pr) => `${item.n}: #${pr}`))),
  [],
);

part("Snapshot evidence that calls such a PR open has an update naming its merge");
is(
  "every such PR is in its item's atualizacao, with the merge commit",
  lot.itens.flatMap((item) => {
    const said = calledOpen([item.prova_do_estado, ...item.pedidos.map((p) => p.prova)].join("; "));
    const note = item.atualizacao ?? "";
    return said.filter((pr) => !note.includes(`#${pr}`) || !note.includes(MERGED_AFTER_AUDIT[pr])).map((pr) => `${item.n}: #${pr}`);
  }),
  [],
);

part("619 [SZ3]: COPY_DOOR_OPEN is described as a gate still to build");
const sz3 = lot.itens.find((item) => item.n === 619) as Item;
const sz3Texts = [...lotLines(sz3), sz3.correcao_estado, sz3.complemento].filter((t) => t.includes("COPY_DOOR_OPEN"));
is("619 mentions COPY_DOOR_OPEN in the queue and the JSON", sz3Texts.length >= 3, true);
is(
  "no text says the door is built behind a tested gate",
  sz3Texts.filter((t) => /(?<!deve ser )constru[íi]da atr[áa]s|trava testada COPY_DOOR_OPEN/.test(t)),
  [],
);
is("every text says the gate does not exist in code yet", sz3Texts.filter((t) => !t.includes("ainda não existe no código")), []);

done();
