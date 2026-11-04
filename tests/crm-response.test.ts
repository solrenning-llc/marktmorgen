import { crmAnswer } from "@/lib/crm-response";
import { done, is, part } from "./check";
const uncertain = { ok: false, error: "crm_write_unconfirmed" };
part("Only explicit successful HTTP confirms a CRM operation");
is("confirmed successful response",crmAnswer(true,{ok:true}),{ok:true});
is("result fields do not change the success contract",crmAnswer(true,{ok:true,deal:{id:"sample"}}),{ok:true});
for(const invalid of [null,undefined,[],{},true,"ok",{ok:"true"},{ok:1},{ok:null},{ok:false},{ok:true,error:null},{ok:true,error:undefined},{ok:false,error:"server_error"},{ok:false,error:"constructor"},{ok:false,error:"future_error"},Object.create({ok:true})]) is("malformed or uncertain result retains recovery",crmAnswer(true,invalid),uncertain);
is("HTTP failure overrides success flag",crmAnswer(false,{ok:true}),uncertain);
is("transport/JSON failure is uncertain",crmAnswer(false,null),uncertain);
part("Known prewrite refusals remain actionable without claiming rollback");
for(const error of ["title","followup","date","assignee","stage","full","unknown","fields","stages","value","invalid","role","origin","signed_out","locked","store_gone","none","unavailable","bad_request","forbidden"]){
  is("known refusal on failed HTTP "+error,crmAnswer(false,{ok:false,error}),{ok:false,error});
  is("known refusal on successful HTTP "+error,crmAnswer(true,{ok:false,error}),{ok:false,error});
}
for(const key of ["deal","fields","stages"]) {
  is("contradictory result cannot be treated as a prewrite refusal",crmAnswer(false,{ok:false,error:"title",[key]:{}}),uncertain);
  is("even an undefined result property stays contradictory",crmAnswer(false,{ok:false,error:"title",[key]:undefined}),uncertain);
}
is("inherited refusal is not accepted",crmAnswer(false,Object.create({ok:false,error:"title"})),uncertain);
part("An edit's conflict carries the deal as it is now (635 [GL3])");
const current = { deal: { id: "abcdefghij", title: "Six sessions", email: "dana@example.com", cents: 90000, stage: "lead00", note: "", assignee: "maya@example.com", nextAction: "Call back", dueDate: "2026-11-10", createdAt: 1, updatedAt: 2 }, version: "0123456789abcdef0123456789abcdef" };
is("crm_conflict with a well-formed current: a refusal holding it",crmAnswer(false,{ok:false,error:"crm_conflict",current}),{ok:false,error:"crm_conflict",current});
is("crm_conflict without current (pipelines changed): a plain refusal, as before",crmAnswer(false,{ok:false,error:"crm_conflict"}),{ok:false,error:"crm_conflict"});
for(const bad of [null,{},[],"x",{deal:current.deal},{version:current.version},{...current,version:"0123"},{...current,version:"0123456789ABCDEF0123456789ABCDEF"},{...current,deal:{...current.deal,id:"bad"}},{...current,deal:{...current.deal,title:7}},{...current,deal:{...current.deal,cents:-1}},{...current,deal:{...current.deal,assignee:null}},{...current,deal:[]}])
  is("a malformed current is never put in the editor",crmAnswer(false,{ok:false,error:"crm_conflict",current:bad}),uncertain);
is("current on another error stays uncertain",crmAnswer(false,{ok:false,error:"unknown",current}),uncertain);
is("a bare deal on a conflict stays uncertain, as before",crmAnswer(false,{ok:false,error:"crm_conflict",deal:current.deal}),uncertain);
is("a full data room is a refusal before any write, with its own words",crmAnswer(false,{ok:false,error:"store_full"}),{ok:false,error:"store_full"});
done();
