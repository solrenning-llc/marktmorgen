import { ID_PATTERN } from "@/lib/agreement-rules";
export type AgreementAction = "create" | "revise" | "read" | "resend" | "copy" | "withdraw" | "delete";
export type AgreementReply = Record<string, unknown> & { ok: boolean; message?: string; sent?: boolean };
/** Only a complete receipt on a successful HTTP response confirms an action.
 * A read's version payload still needs its separate editor validation.
 */
export function agreementReply(httpOk: boolean, value: unknown, action: AgreementAction): AgreementReply {
 if (!value || typeof value !== "object" || Array.isArray(value)) return {ok:false};
 const data=value as Record<string,unknown>, own=(key:string)=>Object.prototype.hasOwnProperty.call(data,key);
 const message=own("message")&&typeof data.message==="string"&&data.message.trim()?data.message.trim().slice(0,600):undefined;
 if (!httpOk || !own("ok") || data.ok!==true) return message?{ok:false,message}:{ok:false};
 if ((action==="create"||action==="revise")&&(!own("id")||typeof data.id!=="string"||!ID_PATTERN.test(data.id))) return {ok:false};
 if (["create","revise","resend","copy"].includes(action)&&(!own("sent")||typeof data.sent!=="boolean")) return {ok:false};
 // `uncertain` (its email's send not known, lib/agreements.ts) only when own and true.
 return {...data,ok:true,message,sent:typeof data.sent==="boolean"?data.sent:undefined,uncertain:own("uncertain")&&data.uncertain===true&&data.sent===false?true:undefined};
}
