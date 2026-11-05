import {buyerSignInOptions,buyerSignInTarget,type BuyerProvider} from "@/lib/buyer-provider-signin-rules";
import {providerSignInWords} from "@/lib/buyer-words/provider-signin";
/** Server page must supply only providers approved for this host and buyer flow. */
export function BuyerProviderSignIn({target,language,providers=[]}:{target:string;language?:unknown;providers?:readonly BuyerProvider[]}) {
 const destination=buyerSignInTarget(target),available=buyerSignInOptions(providers);
 if(!destination || available.length===0)return null;
 const w=providerSignInWords(language);
 return <div className="mt-6 border-t border-line pt-6">
  <p className="mb-3 text-sm text-ink-soft">{w.purchase}</p>
  {available.map(provider=><form key={provider} method="post" action={`/api/buyer/auth/${provider}`} className="mt-3">
   <input type="hidden" name="target" value={target}/>
   <button type="submit" className="btn btn-secondary btn-block">{w[provider]}</button>
  </form>)}
  {available.includes("apple") ? <p className="mt-3 text-sm text-ink-soft">{w.relay}</p> : null}
 </div>;
}
