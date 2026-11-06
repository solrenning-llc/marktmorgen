import { broadcastAnswer } from "@/lib/broadcast-response";
import { done, is, part } from "./check";
const input = { subject: " Hello  readers ", body: " Body\r\nline ", who: "all", productId: "", notProductId: "", narrow: {minSpent:0,channel:"",quietDays:0} };
const record = {id:"1234567890abcdef12345678",status:"scheduled",createdAt:100,sendAt:100,total:3,sent:0,subject:"Hello readers",body:"Body\nline",who:"all",productId:null,notProductId:null,narrow:null,test:null};
const answer = (broadcast: unknown = record) => ({ok:true,broadcast});
const unknown = "broadcast_write_unconfirmed";
part("A created campaign needs a complete matching confirmation");
is("confirmed creation survives",broadcastAnswer(true,answer(),input).ok,true);
is("HTTP failure cannot confirm creation",broadcastAnswer(false,answer(),input).error,unknown);
for (const raw of [null,[],{}, {ok:true}, {ok:"true",broadcast:record},{ok:false,error:"server_error"},{ok:false,error:"new_error"},{ok:false,error:3}, {ok:false,error:"when",broadcast:record}, {ok:true,error:"when",broadcast:record}]) is("unknown outcome blocks retry " + JSON.stringify(raw),broadcastAnswer(true,raw,input).error,unknown);
for (const value of [null,[],"saved",{}, {...record,id:"short"},{...record,id:"1234567890abcdef1234567G"},{...record,status:"sent"},{...record,total:0},{...record,total:"3"},{...record,total:1.5},{...record,total:Number.MAX_SAFE_INTEGER+1},{...record,sent:1},{...record,createdAt:NaN},{...record,sendAt:99},{...record,sendAt:Infinity},{...record,subject:"Different"},{...record,body:"Other"},{...record,who:"buyers"},{...record,productId:"other"},{...record,notProductId:"other"},{...record,narrow:undefined}]) is("invalid or unrelated record " + JSON.stringify(value),broadcastAnswer(true,answer(value),input).error,unknown);
part("Audience and scheduling are retained");
const picked = {...input,who:"buyers",productId:"course",notProductId:"extra",narrow:{minSpent:2550,channel:"newsletter",quietDays:30},sendAt:200999};
const scheduled = {...record,who:"buyers",productId:"course",notProductId:"extra",narrow:picked.narrow,sendAt:200};
is("matching schedule is seconds on the server",broadcastAnswer(true,answer(scheduled),picked).ok,true);
is("a different schedule is not acknowledged",broadcastAnswer(true,answer({...scheduled,sendAt:201}),picked).error,unknown);
for(const narrow of [null,[],{...picked.narrow,minSpent:0},{...picked.narrow,channel:"direct"},{...picked.narrow,quietDays:0},{...picked.narrow,minSpent:"2550"}])is("changed audience cannot confirm",broadcastAnswer(true,answer({...scheduled,narrow}),picked).error,unknown);
// One group of buyers (270 [GR1], unit 3b): kept, confirmed; dropped or changed, never.
const grouped = {...picked,narrow:{...picked.narrow,group:"loyal"}};
is("a group kept is confirmed",broadcastAnswer(true,answer({...scheduled,narrow:grouped.narrow}),grouped).ok,true);
for(const narrow of [picked.narrow,{...picked.narrow,group:"best"},{...grouped.narrow,extra:1}])is("a group dropped, changed or with a field unknown cannot confirm",broadcastAnswer(true,answer({...scheduled,narrow}),grouped).error,unknown);
for(const sendAt of [NaN,Infinity,"200999"])is("invalid request schedule cannot confirm",broadcastAnswer(true,answer(scheduled),{...picked,sendAt}).error,unknown);
for(const error of ["subject","body","when","empty","allowance","plan","role","signed_out","placeholder"])is("explicit pre-write refusal remains actionable "+error,broadcastAnswer(false,{ok:false,error},input).error,error);
is("empty requested content cannot confirm",broadcastAnswer(true,answer(),{...input,body:" "}).error,unknown);
part("The chosen subject experiment is confirmed before clearing the composer");
const testedRecord = { ...record, total: 100 };
const testInput = { ...input, test: { subjectB: "  Another   subject ", share: 30, hours: 12, by: "sales" } };
const initialTest = { subjectB: "Another subject", share: 30, hours: 12, by: "sales", a: 0, b: 0, endsAt: 0, winner: "", visits: null, sales: null, why: "", skipped: false };
is("matching initial test is confirmed", broadcastAnswer(true, answer({ ...testedRecord, test: initialTest }), testInput).ok, true);
for (const test of [null, undefined, [], {}, { ...initialTest, subjectB: "Other" }, { ...initialTest, share: 50 }, { ...initialTest, hours: 4 }, { ...initialTest, by: "visits" }, { ...initialTest, a: 1 }, { ...initialTest, b: 1 }, { ...initialTest, endsAt: 100 }, { ...initialTest, winner: "a" }, { ...initialTest, visits: { a: 0, b: 0 } }, { ...initialTest, sales: { a: 0, b: 0 } }, { ...initialTest, why: "Chosen" }, { ...initialTest, skipped: true }, { ...initialTest, a: "0" }]) {
  is("missing, changed or already advanced test is uncertain", broadcastAnswer(true, answer({ ...testedRecord, test }), testInput).error, unknown);
}
for (const key of Object.keys(initialTest)) {
  const incomplete: Record<string, unknown> = { ...initialTest };
  delete incomplete[key];
  is("missing test field is uncertain: " + key, broadcastAnswer(true, answer({ ...testedRecord, test: incomplete }), testInput).error, unknown);
}
is("an unrequested experiment is uncertain", broadcastAnswer(true, answer({ ...testedRecord, test: initialTest }), input).error, unknown);
is("missing no-test confirmation is uncertain", broadcastAnswer(true, answer({ ...testedRecord, test: undefined }), input).error, unknown);
is("invalid requested second subject cannot be confirmed", broadcastAnswer(true, answer(), { ...input, test: { subjectB: "hello readers" } }).error, unknown);
is("server normalization defaults match", broadcastAnswer(true, answer({ ...testedRecord, test: { ...initialTest, share: 20, hours: 4, by: "visits" } }), { ...input, test: { subjectB: "Another subject", share: 33, hours: 7, by: "opens" } }).ok, true);
is("the second subject uses the server length limit", broadcastAnswer(true, answer({ ...testedRecord, test: { ...initialTest, subjectB: "x".repeat(150) } }), { ...testInput, test: { ...testInput.test, subjectB: "x".repeat(160) } }).ok, true);
is("cleanup warning does not erase a confirmed experiment", broadcastAnswer(true, { ...answer({ ...testedRecord, test: initialTest }), draftCleanupConfirmed: false }, testInput).ok, true);
is("a test below the minimum audience is uncertain", broadcastAnswer(true, answer({ ...testedRecord, total: 99, test: initialTest }), testInput).error, unknown);
done();
