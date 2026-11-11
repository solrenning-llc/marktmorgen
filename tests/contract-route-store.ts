export * from '../lib/store';
export const savedSubscriptions:unknown[]=[];
/** What the stand-ins answer: the account's other stores (or a read that fails), and what writing the subscription down returns (null: not written). */
export const storeAnswers={owned:[] as unknown[],ownedFail:false,saved:null as unknown};
export const resetStoreAnswers=()=>{savedSubscriptions.length=0;storeAnswers.owned=[];storeAnswers.ownedFail=false;storeAnswers.saved=null;};
export const accountStores=async()=>{if(storeAnswers.ownedFail)throw Error('TEST ONLY account stores unreadable');return storeAnswers.owned;};
export const setSubscription=async(_ref:unknown,fields:unknown)=>{savedSubscriptions.push(fields);return storeAnswers.saved;};
