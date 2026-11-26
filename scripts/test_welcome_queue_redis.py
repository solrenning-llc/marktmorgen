"""Actual welcome queue Lua, synthetic keys on disposable loopback Redis."""
import concurrent.futures
import os
from pathlib import Path
import re
import unittest
import uuid
from test_form_opportunity_redis import Redis


class WelcomeQueue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
            raise RuntimeError("Dedicated disposable loopback Redis required")
        source = (Path(__file__).resolve().parents[1] / "lib/welcome-offer-send.ts").read_text()
        match = re.search(r"export const ZADD_IF_MARK = `([^`]+)`;", source)
        if not match or "${" in match[1]:
            raise RuntimeError("Expected static Lua")
        cls.script = match[1]

    def setUp(self):
        self.redis = Redis()
        self.prefix = "marktmorgen:integration:welcome:" + uuid.uuid4().hex + ":"
        self.keys = [self.prefix + name for name in ("mark", "queue", "erased")]

    def tearDown(self):
        try:
            assert all(k.startswith(self.prefix) for k in self.keys)
            self.redis.command("DEL", *self.keys)
        finally:
            self.redis.close()

    def queue(self, client=None):
        return (client or self.redis).command("EVAL", self.script, 3, *self.keys,
                                             "due:2000000000:1.123456789", 2000000000,
                                             '{"e":"synthetic@example.test"}', 3600, "person-print")

    def test_queue_claims_locator_with_expiry(self):
        self.assertEqual(self.queue(), 1)
        self.assertEqual(self.redis.command("GET", self.keys[0]), "due:2000000000:1.123456789")
        self.assertGreater(self.redis.command("TTL", self.keys[0]), 3590)
        self.assertEqual(self.redis.command("ZCARD", self.keys[1]), 1)

    def test_erasure_prevents_claim_and_queue(self):
        self.redis.command("HSET", self.keys[2], "person-print", 1)
        self.assertEqual(self.queue(), 0)
        self.assertEqual(self.redis.command("EXISTS", *self.keys[:2]), 0)

    def test_another_generation_is_not_overwritten(self):
        self.redis.command("SET", self.keys[0], "other-generation", "EX", 120)
        self.assertEqual(self.queue(), 0)
        self.assertEqual(self.redis.command("GET", self.keys[0]), "other-generation")
        self.assertEqual(self.redis.command("ZCARD", self.keys[1]), 0)

    def test_concurrent_calls_claim_once(self):
        def press(_):
            client = Redis()
            try:
                return self.queue(client)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(press, range(32)))
        self.assertEqual(results.count(1), 1)
        self.assertEqual(results.count(0), 31)
        self.assertEqual(self.redis.command("ZCARD", self.keys[1]), 1)


def main():
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(WelcomeQueue))
    if not result.wasSuccessful():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
