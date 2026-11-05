let redisReplies: unknown[][] = [];
let orderReplies: unknown[][] = [];

export function answerRedis(...replies: unknown[][]): void {
  redisReplies = replies.map((reply) => [...reply]);
}

export function answerOrder(...replies: unknown[][]): void {
  orderReplies = replies.map((reply) => [...reply]);
}

export const isRedisConfigured = (): boolean => true;

export async function redisPipeline(_commands: (string | number)[][]): Promise<unknown[]> {
  void _commands;
  if (!redisReplies.length) throw new Error("No synthetic Redis reply left");
  return redisReplies.shift()!;
}

export async function orderWrite(_store: unknown, _commands: (string | number)[][]): Promise<unknown[]> {
  void _store;
  void _commands;
  if (!orderReplies.length) throw new Error("No synthetic order reply left");
  return orderReplies.shift()!;
}

export async function rememberBuyers(_sid: string, _emails: string[]): Promise<void> {
  void _sid;
  void _emails;
}
export async function needData(_room: unknown, _entries: unknown[]): Promise<void> {
  void _room;
  void _entries;
}
export const dataBytes = (_parts: unknown[], _count: number): number => {
  void _parts;
  void _count;
  return 0;
};
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();
