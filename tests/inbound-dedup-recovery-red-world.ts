import { store as redis } from "./redis-stub";

type ClaimReply = unknown;

export const world: {
  claimReply: ClaimReply;
  throwBeforeReply: boolean;
  applyBeforeThrow: boolean;
  providerReads: number;
  seenCommands: (string | number)[][];
} = {
  claimReply: ["OK"],
  throwBeforeReply: false,
  applyBeforeThrow: false,
  providerReads: 0,
  seenCommands: [],
};

const originalPipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;

function isSeenCommand(command: (string | number)[]): boolean {
  return (command[0] === "SET" || command[0] === "DEL")
    && typeof command[1] === "string"
    && command[1].startsWith("nl:inbound:seen:");
}

export function installInboundRecoveryWorld(): void {
  redis.pipeline = async (commands) => {
    const seen = commands.filter(isSeenCommand);
    world.seenCommands.push(...seen);
    const claim = seen.find((command) => command[0] === "SET");
    if (claim) {
      if (world.applyBeforeThrow) await originalPipeline(commands);
      if (world.throwBeforeReply) throw new Error("synthetic lost inbound claim reply");
      return world.claimReply as never[];
    }
    return originalPipeline(commands);
  };
  globalThis.fetch = (async () => {
    world.providerReads += 1;
    return new Response("provider unavailable", { status: 500 });
  }) as typeof fetch;
}

export function resetInboundRecoveryWorld(
  claimReply: ClaimReply,
  options: { throwBeforeReply?: boolean; applyBeforeThrow?: boolean } = {},
): void {
  redis.clear();
  world.claimReply = claimReply;
  world.throwBeforeReply = options.throwBeforeReply ?? false;
  world.applyBeforeThrow = options.applyBeforeThrow ?? false;
  world.providerReads = 0;
  world.seenCommands = [];
}

export function restoreInboundRecoveryWorld(): void {
  redis.pipeline = originalPipeline;
  globalThis.fetch = originalFetch;
  redis.clear();
}
