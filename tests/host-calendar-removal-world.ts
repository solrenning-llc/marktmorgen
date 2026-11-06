/** Only the calendar/provider boundary is synthetic; route/auth/both quotas are real. */
export const state={disconnects:0,removals:0,checks:0,adds:0};
export const MAX_ICS_URL=2_000;
const view={source:"none",connected:null};
export async function hostCalendarView(){return view;}
export async function disconnectHostGoogle(){state.disconnects++;}
export async function removeHostIcs(){state.removals++;}
export async function checkHostCalendar(){state.checks++;return true;}
export async function addHostIcs(){state.adds++;return {ok:true};}
export async function setHostCalendars(){return null;}
export async function setHostSource(){return null;}
