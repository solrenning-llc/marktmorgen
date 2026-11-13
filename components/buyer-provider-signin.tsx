import {buyerSignInOptions,buyerSignInTarget,type BuyerProvider} from "@/lib/buyer-provider-signin-rules";
import {providerSignInWords} from "@/lib/buyer-words/provider-signin";
import {googleSignInShown} from "@/lib/google-signin";
import {appleSignInShown} from "@/lib/apple-signin";
import {discordSignInShown} from "@/lib/discord-signin";

/**
 * Each provider is shown only where its own switch says so for this host: on
 * the site's own address, where its state cookie can close, and only once it is
 * offered (Google before approval only on the owner's try link). A page passing
 * every provider on a creator's own domain therefore shows none (Claude 5 /
 * Claude 1 MEDIUM): the component fails closed by itself.
 */
const SHOWN:Record<BuyerProvider,(host:string|null|undefined,tryQuery?:unknown)=>boolean>={
 google:(host,tryQuery)=>googleSignInShown(host,tryQuery),
 apple:host=>appleSignInShown(host),
 discord:host=>discordSignInShown(host),
};

export function BuyerProviderSignIn({target,language,providers=[],host,tryQuery}:{target:string;language?:unknown;providers?:readonly BuyerProvider[];host?:string|null;tryQuery?:unknown}) {
 const destination=buyerSignInTarget(target),available=buyerSignInOptions(providers).filter(p=>SHOWN[p](host,tryQuery));
 if(!destination || available.length===0)return null;
 const w=providerSignInWords(language);
 const relay=available.includes("apple");
 // The notices are read before the buttons, by keyboard or screen reader, and describe them (WCAG 3.3.2).
 return <div className="mt-6 border-t border-line pt-6">
  <p id="buyer-signin-purchase" className="mb-3 text-sm text-ink-soft">{w.purchase}</p>
  {relay ? <p id="buyer-signin-relay" className="mb-3 text-sm text-ink-soft">{w.relay}</p> : null}
  {available.map(provider=><form key={provider} method="post" action={`/api/buyer/auth/${provider}`} className="mt-3">
   <input type="hidden" name="target" value={target}/>
   <button type="submit" aria-describedby={provider==="apple" ? "buyer-signin-purchase buyer-signin-relay" : "buyer-signin-purchase"} className="btn btn-secondary btn-block">{w[provider]}</button>
  </form>)}
 </div>;
}
