const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { TelegramApi } = require("../dist/notifications/telegram");
const { pollTelegram } = require("../dist/jobs/telegram-poll");

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const token = "123456789:" + "A".repeat(35);
const code = (error) => error.getResponse();

test("messages go to the chat through the bot API, without link previews", async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  await new TelegramApi(token).sendMessage("-1001234", "Pedirr · Approved");
  assert.deepEqual(calls, [
    {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      body: { chat_id: "-1001234", text: "Pedirr · Approved", disable_web_page_preview: true },
    },
  ]);
});

test("Telegram refusals become codes and never carry the token", async () => {
  for (const [status, body, expected] of [
    [429, { ok: false, parameters: { retry_after: 7 } }, "TELEGRAM_RATE_LIMITED"],
    [401, { ok: false }, "TELEGRAM_TOKEN_INVALID"],
    [403, { ok: false, description: "bot was kicked" }, "TELEGRAM_FORBIDDEN"],
    [500, { ok: false }, "TELEGRAM_DELIVERY_FAILED"],
  ]) {
    global.fetch = async () => Response.json(body, { status });
    await assert.rejects(new TelegramApi(token).sendMessage("1", "x"), (error) => {
      const response = code(error);
      assert.equal(response.code, expected);
      assert.ok(!JSON.stringify(response).includes(token));
      if (status === 429) {
        assert.equal(response.retryAfterSeconds, 7);
      }
      return true;
    });
  }
  global.fetch = async () => {
    throw new Error(`connect failed to bot${token}`);
  };
  await assert.rejects(new TelegramApi(token).getMe(), (error) => {
    assert.equal(code(error).code, "TELEGRAM_UNREACHABLE");
    assert.ok(!JSON.stringify(code(error)).includes(token));
    return true;
  });
});

/** In-memory Redis with the few commands the poll uses. */
function memoryRedis() {
  const data = new Map();
  const pending = new Map();
  return {
    data,
    pending,
    zremrangebyscore: async (_key, _min, max) => {
      for (const [member, score] of pending) {
        if (score <= max) {
          pending.delete(member);
        }
      }
    },
    zcard: async () => pending.size,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value, ...args) => {
      if (args.includes("NX") && data.has(key)) {
        return null;
      }
      data.set(key, value);
      return "OK";
    },
    del: async (...keys) => keys.forEach((key) => data.delete(key)),
  };
}

test("posted link codes link their chat, in groups and channels", async () => {
  const redis = memoryRedis();
  redis.data.set("pedirr:telegram:link:ABCD2345", "tenant-a");
  redis.data.set("pedirr:telegram:link:WXYZ6789", "platform");
  redis.pending.set("tenant-a", Date.now() + 60000);
  const linked = [];
  const sent = [];
  const settings = {
    configuration: async () => ({ telegramToken: token }),
    linkTelegram: async (tenantId, chat) => linked.push([tenantId, chat]),
  };
  const offsets = [];
  const client = () => ({
    getUpdates: async (offset) => {
      offsets.push(offset);
      return [
        { update_id: 10, message: { text: "hello", chat: { id: 1, title: "Chat" } } },
        {
          update_id: 11,
          message: { text: "/link@PedirrBot abcd2345", chat: { id: -100, title: "Fight Club" } },
        },
        {
          update_id: 12,
          channel_post: { text: "/link WXYZ6789", chat: { id: -200, username: "news" } },
        },
        { update_id: 13, message: { text: "/link NOTACODE", chat: { id: 5, title: "Other" } } },
      ];
    },
    sendMessage: async (chatId) => sent.push(chatId),
  });
  const result = await pollTelegram({ redis }, settings, client);
  assert.deepEqual(result, { updates: 4, linked: 2 });
  assert.deepEqual(linked, [
    ["tenant-a", { id: "-100", title: "Fight Club" }],
    ["platform", { id: "-200", title: "@news" }],
  ]);
  assert.deepEqual(sent, ["-100", "-200"]);
  // Codes are single use, and the next run starts after the last update read.
  assert.equal(redis.data.has("pedirr:telegram:link:ABCD2345"), false);
  assert.equal(redis.data.get("pedirr:telegram:offset"), "14");
  await pollTelegram({ redis }, settings, client);
  assert.deepEqual(offsets, [undefined, 14]);
  assert.equal(linked.length, 2);
});

test("pages of updates are handled before they are confirmed", async () => {
  const redis = memoryRedis();
  redis.pending.set("platform", Date.now() + 60000);
  redis.data.set("pedirr:telegram:link:LATE2345", "platform");
  const page = (from, size) =>
    Array.from({ length: size }, (_, i) => ({
      update_id: from + i,
      message: { text: "chatter", chat: { id: 1 } },
    }));
  const offsets = [];
  const linked = [];
  const settings = {
    configuration: async () => ({ telegramToken: token }),
    linkTelegram: async (tenantId) => linked.push(tenantId),
  };
  // A day of group chatter waits in front of the code: one run reads through it.
  const client = () => ({
    getUpdates: async (offset) => {
      offsets.push(offset);
      return offset === undefined
        ? page(1, 100)
        : [
            ...page(101, 1),
            { update_id: 102, channel_post: { text: "/link LATE2345", chat: { id: -9 } } },
          ];
    },
    sendMessage: async () => undefined,
  });
  assert.deepEqual(await pollTelegram({ redis }, settings, client), { updates: 102, linked: 1 });
  assert.deepEqual(offsets, [undefined, 101]);
  assert.deepEqual(linked, ["platform"]);
  // A failure while handling a page leaves it unconfirmed, to be read again.
  const failing = {
    configuration: settings.configuration,
    linkTelegram: async () => {
      throw new Error("database down");
    },
  };
  redis.data.set("pedirr:telegram:link:AGAIN234", "platform");
  const retry = () => ({
    getUpdates: async () => [
      { update_id: 103, message: { text: "/link AGAIN234", chat: { id: -9 } } },
    ],
    sendMessage: async () => undefined,
  });
  await assert.rejects(pollTelegram({ redis }, failing, retry), /database down/);
  assert.equal(redis.data.get("pedirr:telegram:offset"), "103");
  assert.equal(redis.data.has("pedirr:telegram:poll"), false);
});

test("the bot is read only while a code is pending, with a token, by one worker", async () => {
  const redis = memoryRedis();
  const client = () => assert.fail("Telegram must not be called");
  const configured = { configuration: async () => ({ telegramToken: token }) };
  assert.deepEqual(await pollTelegram({ redis }, configured, client), {
    skipped: "nothing_to_link",
  });
  // Expired codes no longer count.
  redis.pending.set("tenant-a", Date.now() - 1);
  assert.deepEqual(await pollTelegram({ redis }, configured, client), {
    skipped: "nothing_to_link",
  });
  assert.equal(redis.pending.size, 0);
  redis.pending.set("tenant-a", Date.now() + 60000);
  assert.deepEqual(
    await pollTelegram({ redis }, { configuration: async () => ({ telegramToken: "" }) }, client),
    { skipped: "not_configured" },
  );
  redis.data.set("pedirr:telegram:poll", "1");
  assert.deepEqual(
    await pollTelegram(
      { redis },
      { configuration: async () => ({ telegramToken: token }) },
      client,
    ),
    { skipped: "running" },
  );
});
