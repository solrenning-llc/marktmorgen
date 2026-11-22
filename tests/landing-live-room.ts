import { ROOM as BASE_ROOM } from './data-room';
import { storeIdCommand, storeRef } from '@/lib/store';
import { store as redis } from './redis-stub';
export const ROOM = { ...BASE_ROOM, sid: '1'.repeat(32), email: 'landing-room@example.invalid', extra: false };
export function seedLandingRoom(room = ROOM): void {
  redis.run(['SET', storeIdCommand(room.sid)[1], storeRef(room)]);
}
export function resetLandingRoom(room = ROOM): void {
  redis.clear();
  seedLandingRoom(room);
}
