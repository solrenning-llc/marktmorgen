/** Provider test-meeting calls and outgoing notices only. Route, permissions,
 * provider configuration, connection storage/locks and quotas stay real. */
export const state={tests:0,moves:0,removes:0,notices:0};
export class TestMeetingUnavailable extends Error {}
export async function makeTest(){state.tests++;return {id:"synthetic-meeting"};}
export async function moveTest(){state.moves++;return {id:"synthetic-meeting"};}
export async function removeTest(){state.removes++;}
export async function noticeCreator(){state.notices++;return true;}
