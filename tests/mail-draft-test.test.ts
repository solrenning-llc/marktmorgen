import { readDraftSubjectTest, sameDraftSubjectTest } from "@/lib/mail-draft-test";
import { DraftReadUnavailable, listDraftsStrict, parseDraftList, saveDraft } from "@/lib/mail-drafts";
import { confirmedDraftId } from "@/lib/mail-response";
import { subjectTestPreview } from "@/lib/mail-test-preview";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const store = { listId: "draft-subject-test", catalog: { items: [] } } as unknown as Store;
  const key = "nl:mail:drafts:" + store.listId;
  const content = { subject: "First subject", body: "Content", productId: "" };
  let id = "", version: string | undefined;
  let last = { subjectB: "", share: 20, hours: 4, by: "visits" } as { subjectB: string; share: number; hours: number; by: "visits" | "sales" };
  part("Every available configuration survives save and reload, including incomplete writing");
  for (const subjectB of ["Second subject", ""]) for (const share of [20,30,50]) for (const hours of [2,4,12,24]) for (const by of ["visits","sales"] as const) {
    const subjectTest = { subjectB, share, hours, by };
    const saved = await saveDraft(store,"owner@example.com",{...content,id:id || undefined,expectedSavedAt:version,subjectTest});
    is("configuration can be saved",saved.ok,true);
    if (!saved.ok) throw Error("fixture save failed");
    id = saved.draft.id; version = saved.draft.savedAt; last = subjectTest;
    is("acknowledgement retains all settings",saved.draft.subjectTest,subjectTest);
    is("reload restores all settings",(await listDraftsStrict(store.listId))[0]?.subjectTest,subjectTest);
    is("matching configuration confirms saving",confirmedDraftId({ok:true,draft:saved.draft},id,undefined,content,subjectTest),id);
  }
  part("Incomplete work can be saved without becoming sendable");
  is("blank second subject still fails send preview",subjectTestPreview(content.subject,last,100).state,"subject");
  const legacyUpdate=await saveDraft(store,"owner@example.com",{...content,id});
  is("older update preserves the experiment",legacyUpdate.ok && legacyUpdate.draft.subjectTest,last);
  const disabled=await saveDraft(store,"owner@example.com",{...content,id,subjectTest:null});
  is("explicit disable is saved",disabled.ok && disabled.draft.subjectTest,null);
  is("disabled state survives reload",(await listDraftsStrict(store.listId))[0]?.subjectTest,null);
  is("disabled acknowledgement is confirmable",disabled.ok ? confirmedDraftId({ok:true,draft:disabled.draft},id,undefined,content,null):"fixture",id);
  const legacy=await saveDraft(store,"owner@example.com",content);
  is("legacy creation remains readable without a test field",legacy.ok && (await listDraftsStrict(store.listId)).find(d=>d.id===legacy.draft.id)?.subjectTest,undefined);
  is("missing field cannot confirm explicit disabling",legacy.ok ? confirmedDraftId({ok:true,draft:legacy.draft},legacy.draft.id,undefined,content,null):"fixture",null);
  part("Malformed options never silently change to defaults");
  const valid={subjectB:"Second subject",share:20,hours:4,by:"visits"};
  const invalid=[false,0,"",[],{}, {...valid,subjectB:null},{...valid,subjectB:"x".repeat(151)},{...valid,share:21},{...valid,share:"20"},{...valid,hours:-1},{...valid,by:"opens"}];
  const before=(await redis.pipeline([["HGETALL",key]]))[0];
  for(const subjectTest of invalid){
    is("parser rejects malformed settings",readDraftSubjectTest(subjectTest),undefined);
    is("save rejects before writing",await saveDraft(store,"owner@example.com",{...content,id,subjectTest}),{ok:false,reason:"draft_test"});
    const record={id,...content,productId:null,by:"owner@example.com",savedAt:"2026-10-15T00:00:00Z",subjectTest};
    is("malformed stored settings make list unavailable",parseDraftList([id,JSON.stringify(record)]),null);
    is("malformed settings cannot confirm save",confirmedDraftId({ok:true,draft:record},id),null);
  }
  is("rejected saves retain the entire draft collection",(await redis.pipeline([["HGETALL",key]]))[0],before);
  part("Changed or missing acknowledgements do not clear unsaved editor state");
  const response={id,...content,productId:null,by:"owner@example.com",savedAt:"2026-10-15T00:00:00Z",subjectTest:valid};
  for(const change of [{subjectB:"Other"},{share:30},{hours:12},{by:"sales"}]) is("different saved configuration remains unconfirmed",confirmedDraftId({ok:true,draft:{...response,subjectTest:{...valid,...change}}},id,undefined,content,valid),null);
  is("reordered fields are equivalent",sameDraftSubjectTest(valid,{by:"visits",hours:4,share:20,subjectB:"Second subject"}),true);
  is("disabled and absent are not equivalent",sameDraftSubjectTest(null,undefined),false);
  const original=redis.pipeline;let writes=0;
  redis.pipeline=async commands=>{writes+=commands.filter(c=>c[0]==="HSET"||(c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:draft-set-held:"))).length;if(commands.some(c=>c[0]==="HGET"))return [];return original.call(redis,commands);};
  try{let failed=false;try{await saveDraft(store,"owner@example.com",{...content,id});}catch(e){failed=e instanceof DraftReadUnavailable;}
    is("unreadable legacy record cannot discard the experiment",failed,true);is("no write after unavailable previous record",writes,0);
  }finally{redis.pipeline=original;}
  done();
}
void main();
