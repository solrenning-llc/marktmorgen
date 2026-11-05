import { keepOwnLinks, readDraftedSteps } from "@/lib/sequence-draft";
import { done, is, part } from "./check";

const own = ["https://own.example/p"];

part("Protocol-relative userinfo cannot hide a foreign host");
for (const address of [
  "//own.example@evil.test/path",
  "//reader:secret@evil.test/path",
]) {
  is(`${address}: remove the foreign line`, keepOwnLinks(`Keep this.\nRead ${address} now.`, own), "Keep this.");
  is(`${address}: omit a foreign-only draft`, readDraftedSteps([{ subject: "Draft", body: address, waitDays: 0 }], 1, own), []);
}

part("Existing boundary controls stay intact");
is("plain protocol-relative foreign host is removed", keepOwnLinks("//evil.test/path", own), "");
is("an address-like local email fragment is not treated as a web destination", keepOwnLinks("member@evil.test/path", own), "member@evil.test/path");

done();
