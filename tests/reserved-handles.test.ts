/**
 * 568 [GD2] (j), unit 1: a store's address can never pass for Marktmorgen's own:
 * "official", "security", "billing", "staff", "verified" and the like, and any
 * address that contains "marktmorgen" or "solrenning", cannot be claimed or
 * taken in a rename (lib/store.ts, newAddressProblem). An address a store already
 * holds keeps working: only taking one is refused (storeForHandle reads
 * handleProblem, unchanged), so no creator's store goes dark.
 *
 * What fails here: one of these addresses claimed or renamed to; an ordinary
 * address refused ("billing-flow-shop", "securitystudio" stay free); an existing
 * store under one of the new words no longer found.
 */
import { claimHandle, newAddressProblem, handleProblem, renameHandle, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Addresses that could pass for Marktmorgen's own");
  for (const handle of ["official", "security", "billing", "staff", "team", "moderator", "payments", "verify", "verified", "trust", "safety", "abuse", "press", "status", "noreply", "no-reply", "helpdesk", "checkout", "secure", "marktmorgen.help", "realmarktmorgen", "marktmorgen-official", "solrenning-llc", "support", "admin", "help"]) {
    is(`refused: ${handle}`, newAddressProblem(handle), "reserved");
  }
  for (const handle of ["billing-flow-shop", "securitystudio", "teamcakes", "janesbakery", "official.jane"]) is(`free: ${handle}`, newAddressProblem(handle), null);
  is("a shape problem is still a shape problem", newAddressProblem("A"), "shape");

  part("Claiming and renaming refuse them; a store already there keeps working");
  redis.clear();
  const claimed = await claimHandle("a@example.com", "official", "Official", "");
  is("claiming \"official\" is refused", [claimed.ok, claimed.ok ? "" : claimed.reason], [false, "reserved"]);
  await claimHandle("b@example.com", "janesbakery", "Jane's Bakery", "");
  is("renaming to \"marktmorgen-support\" is refused", (await renameHandle("b@example.com", "marktmorgen-support")).ok, false);
  is("the store keeps its own address", (await storeForEmail("b@example.com"))?.handle, "janesbakery");
  // A store that took one of the new words before this rule keeps working: reading an address is not taking one.
  is("reading an address still uses the old rule", [handleProblem("official"), handleProblem("security")], [null, null]);
  await claimHandle("legacy@example.com", "legacyshop", "Legacy", "");
  await redis.pipeline([["SET", "nl:store:handle:official", "legacy@example.com"]]);
  is("an existing store at a newly reserved word is still found at it", (await storeForHandle("official"))?.handle !== undefined, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
