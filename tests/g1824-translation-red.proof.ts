/** Independent causal RED for SZ1 units2/3; uses the pre-existing pure helper export. */
import { policyFacts } from "@/lib/store-policy-facts";
import { done, is } from "./check";
const input={storeName:"Harbor Kitchen",sellsDigital:true,sellsMemberships:false,paypal:false,pixels:[],postalAddress:""};
is("English control",policyFacts(input,"en")[0].title,"Who sells");
is("German policy is German",policyFacts(input,"de")[0].title,"Wer verkauft");
is("European Portuguese policy is Portuguese",policyFacts(input,"pt")[0].title,"Quem vende");
is("no seller name produces no invented seller",policyFacts({...input,storeName:" "},"en"),[]);
done();
