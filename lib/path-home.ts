/** Static descriptions of the actual first seven Path missions. No store read or provider call. */
import { dayMissions, NO_FACTS } from "@/lib/path-rules";
const roles: Record<string,{creator:string;platform:string}> = {
 title:{creator:"Write your store name and the line explaining what you make.",platform:"Checks whether that name and line are published on the store."},
 product:{creator:"Prepare a listed product and add its file, course or destination link.",platform:"Checks the listed product's delivery facts; it does not make the product for you."},
 test:{creator:"Only in Stripe test mode, inspect the checkout and manually check access to what was bought.",platform:"Checks a recorded paid test checkout. This does not verify file access or delivery; live stores are never asked to make a real self-purchase."},
 social:{creator:"Choose a social profile and share your store address where appropriate.",platform:"Checks whether a visit from a social network was recorded. It does not promise traffic or publish a post for you."},
 posts:{creator:"Make a separate short link for each post you plan.",platform:"Checks the number of recorded post links, without claiming they generated sales."},
 lead:{creator:"Offer a sign-up or free product and explain the person's permission choices.",platform:"Counts an address once its owner confirms it from the emailed link; a typed-in address does not count, and a confirmation alone is not marketing consent."},
 sale:{creator:"When live checkout is available, present your product and its actual terms to people who choose to buy.",platform:"Checks a real paid order confirmed by Stripe; a full refund removes its completion. No sale or deadline is guaranteed."},
};
export const PATH_HOME_STEPS = dayMissions(NO_FACTS,{minutes:15,audience:"none",subject:"",skills:""}).map(mission=>({id:mission.id,title:mission.title,...roles[mission.id]}));
