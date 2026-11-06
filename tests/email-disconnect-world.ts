/** Only outgoing notice delivery is synthetic. No authentication/store/backend mocks. */
export const notices:string[]=[];
export async function noticeCreator(_store:unknown,change:{kind:string}){notices.push(change.kind);return true;}
