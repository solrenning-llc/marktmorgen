import { checkGeneratedCode, outsideUrl, tagsOf } from "@/lib/generated-code-check";
import { done, is, part } from "./check";
const allowed=["files.store.example"];
part("C0 at the start is removed by the native URL parser, never a relative path");
for(const cp of [1,2,3,8,14,31])for(const address of ["//collector.example/p.png","https://collector.example/p.png"]){
  const raw=String.fromCodePoint(cp)+address;
  is(`native destination ${cp} ${address}`,new URL(raw,"https://apps.store.example/").hostname,"collector.example");
  is(`external raw address refused ${cp} ${address}`,outsideUrl(raw,allowed),true);
  const html=`<img src="&#${cp};${address}" alt="">`;
  is(`numeric reference refuses external image ${cp} ${address}`,checkGeneratedCode({html,css:"",js:""},{allowedHosts:allowed}).staticPass,false);
}
part("Ordinary destinations and the first attribute keep their meaning");
is("relative stays allowed",outsideUrl("/files/p.png",allowed),false);
is("allowed host stays allowed",outsideUrl("https://files.store.example/p.png",allowed),false);
is("ordinary external stays refused",outsideUrl("https://collector.example/p.png",allowed),true);
is("first duplicate is retained",tagsOf('<img src="/first.png" src="https://collector.example/p.png" alt="">')[0].attrs.get("src"),"/first.png");
done();
