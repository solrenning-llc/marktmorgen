import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { forgetUser } from "@/lib/meet-connect";
import { forgetMetaUser } from "@/lib/meta-ads";
import { store as redis } from "./redis-stub";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const zoomUserKey = (id: string) => `nl:meet:user:zoom:${hash(`meet-user:zoom:${id}`)}`;
const zoomConnKey = (statsId: string) => `nl:meet:conn:${statsId}:zoom`;
const metaUserKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const metaConnKey = (statsId: string) => `nl:metaads:conn:${statsId}`;

test("Zoom never confirms all stores forgotten after processing only the first 50", async () => {
  redis.clear();
  const user = "zoom-user-with-51-stores";
  for (let index = 0; index < 51; index += 1) {
    const statsId = `zoom-stats-${String(index).padStart(2, "0")}`;
    redis.run(["SADD", zoomUserKey(user), statsId]);
    redis.run([
      "SET",
      zoomConnKey(statsId),
      JSON.stringify({
        provider: "zoom",
        account: { id: user, email: "host@example.com", name: "Host" },
        refresh: "sealed",
        access: "sealed",
        owner: { email: "owner@example.com", handle: "shop" },
      }),
    ]);
  }

  const forgotten = await forgetUser("zoom", user);

  assert.equal(forgotten.length, 50, "only the sliced prefix was processed");
  assert.equal(redis.run(["EXISTS", zoomConnKey("zoom-stats-50")]), 1, "the 51st connection must still be discoverable");
  assert.equal(redis.run(["EXISTS", zoomUserKey(user)]), 1, "the index must remain while any connection remains");
});

test("Meta never issues a complete deletion result after processing only the first 50 stores", async () => {
  redis.clear();
  const user = "10150000000000051";
  for (let index = 0; index < 51; index += 1) {
    const statsId = `meta-stats-${String(index).padStart(2, "0")}`;
    redis.run(["SADD", metaUserKey(user), statsId]);
    redis.run([
      "SET",
      metaConnKey(statsId),
      JSON.stringify({
        user,
        token: "sealed",
        accounts: [],
        account: "",
        sid: "sid-1",
        owner: { email: "owner@example.com", handle: "shop" },
      }),
    ]);
  }

  const forgotten = await forgetMetaUser(user);

  assert.equal(forgotten.length, 50, "only the sliced prefix was processed");
  assert.equal(redis.run(["EXISTS", metaConnKey("meta-stats-50")]), 1, "the 51st connection must still be discoverable");
  assert.equal(redis.run(["EXISTS", metaUserKey(user)]), 1, "the index must remain while any connection remains");
});
