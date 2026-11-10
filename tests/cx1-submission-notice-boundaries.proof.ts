import { tellBuyerOfReply, type NoticeMessage } from "@/lib/submission-notice";
import { suppressCommand } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import type { KeptSubmission } from "@/lib/submission-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const folder = "a".repeat(32), id = "b".repeat(32), buyer = "cx1-buyer@example.com";
const store = { handle: "cx1course", name: "CX1 Course", sid: "cx1-course", statsId: folder, listId: "cx1-list", language: "en" } as unknown as Store;
const submission = { id, folder, buyer, state: "reviewed", target: { kind: "lesson", courseId: "cx1course0001", lessonId: "cx1lesson001" }, reply: { text: "This is your private review.", file: null, at: 1 }, file: { name: "example.pdf", bytes: 1, type: "application/pdf" } } as unknown as KeptSubmission;
const input = { store, productId: "cx1product01", productTitle: "Course", lessonTitle: "Lesson", submission };
const real = redis.pipeline.bind(redis);
async function main() {
  part("CX1: uncertainty after dispatch is not a proven non-send");
  redis.clear();
  let accepted = 0;
  const lost = async (_message: NoticeMessage) => { accepted++; throw new Error("synthetic receipt lost after acceptance"); };
  const result = await tellBuyerOfReply(input, lost);
  is("the synthetic sender accepted before the receipt was lost", accepted, 1);
  is("uncertain acceptance remains unknown", result, "unknown");
  is("a retry never dispatches a second copy", await tellBuyerOfReply(input, lost), "already");
  is("still one synthetic acceptance", accepted, 1);

  part("CX1: deletion confirmed while claiming the mark must fence dispatch");
  redis.clear();
  let erased = false, sentAfterErase = 0;
  redis.pipeline = async commands => {
    const reply = await real(commands);
    if (commands.some(c => c[0] === "SET" && String(c[1]).startsWith("nl:sub:told:")) && !erased) {
      await real([suppressCommand(store.listId!, buyer, 1)]);
      erased = true;
    }
    return reply;
  };
  try {
    await tellBuyerOfReply(input, async () => { if (erased) sentAfterErase++; return true; });
  } finally { redis.pipeline = real; }
  is("the real erasure-print writer ran before dispatch", erased, true);
  is("no dispatch after the erasure print", sentAfterErase, 0);
  done();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
