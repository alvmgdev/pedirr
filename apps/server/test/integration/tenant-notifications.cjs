const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const Redis = require("ioredis");
const { Notifications } = require("../../dist/notifications/service");
const { NotificationSettings } = require("../../dist/settings/notifications");
const { pollTelegram } = require("../../dist/jobs/telegram-poll");

async function main() {
  const schema = "test_tenant_notifications_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  const redis = new Redis(process.env.REDIS_URL);
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    process.env.APP_ORIGIN = "https://pedirr.example.invalid";
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    const a = await db.tenant.create({ data: { code: "k7x2p", name: "Fight Club TV" } });
    const b = await db.tenant.create({ data: { code: "other", name: "Other Sports" } });
    const settings = new NotificationSettings({ db, redis });
    const channels = (host, webhook) => ({
      emailEnabled: true,
      smtpHost: host,
      smtpPort: 587,
      smtpSecurity: "starttls",
      smtpUser: "",
      emailFrom: `noreply@${host}`,
      discordEnabled: true,
      discordWebhook: webhook,
      discordLocale: "en",
    });
    await settings.save(
      channels("smtp.platform.invalid", "https://discord.com/api/webhooks/1/platform"),
    );
    await settings.save(
      channels("smtp.fightclub.invalid", "https://discord.com/api/webhooks/2/fightclub"),
      a.id,
    );
    // Each environment's settings and secrets are its own; the other reseller has none.
    assert.equal((await settings.publicSettings(a.id)).smtpHost, "smtp.fightclub.invalid");
    assert.equal((await settings.publicSettings()).smtpHost, "smtp.platform.invalid");
    assert.equal((await settings.configuration(b.id)).emailEnabled, false);
    assert.equal(
      (await settings.configuration(a.id)).discordWebhook,
      "https://discord.com/api/webhooks/2/fightclub",
    );

    const user = (email, role, tenantId) =>
      db.user.create({ data: { email, passwordHash: "unused", role, tenantId, locale: "en" } });
    const admin = await user("admin@example.invalid", "ADMIN", "platform");
    const fan = await user("fan@example.invalid", "USER", "platform");
    const ana = await user("ana@example.invalid", "USER", a.id);
    const bea = await user("bea@example.invalid", "USER", b.id);
    // The same address at the platform and at a reseller.
    const sharedHere = await user("shared@example.invalid", "USER", "platform");
    const sharedThere = await user("shared@example.invalid", "USER", a.id);

    const entity = await db.catalogEntity.create({
      data: { kind: "EVENT", title: "UFC 334", metadata: {} },
    });
    const request = await db.request.create({
      data: {
        entityId: entity.id,
        scopeKey: "event",
        scope: { kind: "event" },
        status: "AVAILABLE",
        subscribers: {
          create: [fan, ana, bea, sharedHere, sharedThere].map((item) => ({ userId: item.id })),
        },
        createdAt: new Date(Date.now() - 60000),
      },
    });

    const sent = [];
    const via = (channel, config) =>
      channel === "email"
        ? config.smtpHost
        : channel === "discord"
          ? config.discordWebhook.split("/").pop()
          : config.telegramToken.split(":")[0];
    const recorder = (channel) => ({
      send: async (config, recipient, notice) =>
        sent.push({
          channel,
          via: via(channel, config),
          recipient:
            channel === "email" ? recipient : channel === "telegram" ? recipient : "channel",
          url: notice.url,
        }),
    });
    const worker = new Notifications(
      { db, redis },
      settings,
      recorder("email"),
      recorder("discord"),
      recorder("telegram"),
    );
    const run = async (type, payload) => {
      sent.length = 0;
      const event = await db.outboxEvent.create({ data: { type, payload } });
      await worker.run(event.id);
      return sent.map((item) => `${item.channel} ${item.via} ${item.recipient} ${item.url}`).sort();
    };
    const origin = process.env.APP_ORIGIN;
    const requestPath = `/requests/${request.id}`;

    // Each person hears through their own environment's settings, with their own address;
    // a reseller without settings sends nothing; each channel links to its environment.
    assert.deepEqual(await run("request.status", { requestId: request.id, status: "AVAILABLE" }), [
      `discord fightclub channel ${origin}/k7x2p${requestPath}`,
      `discord platform channel ${origin}${requestPath}`,
      `email smtp.fightclub.invalid ana@example.invalid ${origin}/k7x2p${requestPath}`,
      `email smtp.fightclub.invalid shared@example.invalid ${origin}/k7x2p${requestPath}`,
      `email smtp.platform.invalid fan@example.invalid ${origin}${requestPath}`,
      `email smtp.platform.invalid shared@example.invalid ${origin}${requestPath}`,
    ]);
    // Platform administrators hear about new requests through the platform.
    const created = await run("request.created", {
      requestId: request.id,
      status: "PENDING",
      userIds: [ana.id],
    });
    assert.ok(
      created.includes(`email smtp.platform.invalid admin@example.invalid ${origin}${requestPath}`),
    );
    assert.ok(
      created.includes(
        `email smtp.fightclub.invalid ana@example.invalid ${origin}/k7x2p${requestPath}`,
      ),
    );
    assert.ok(!created.some((line) => line.includes("bea@") || line.includes("fan@")));

    // A client's new issue reaches the platform administrators and both channels; the answer
    // reaches the client through the reseller.
    const issue = await db.issue.create({
      data: {
        requestId: request.id,
        reporterId: ana.id,
        category: "QUALITY",
        description: "Blurry",
      },
    });
    const issuePath = `/issues/${issue.id}`;
    assert.deepEqual(await run("issue.created", { issueId: issue.id }), [
      `discord fightclub channel ${origin}/k7x2p${issuePath}`,
      `discord platform channel ${origin}${issuePath}`,
      `email smtp.platform.invalid admin@example.invalid ${origin}${issuePath}`,
    ]);
    assert.deepEqual(
      await run("issue.updated", {
        issueId: issue.id,
        status: "RESOLVED",
        audience: "reporter",
        actorId: admin.id,
      }),
      [`email smtp.fightclub.invalid ana@example.invalid ${origin}/k7x2p${issuePath}`],
    );

    // Telegram: one bot for the whole platform, set by the platform, checked with Telegram.
    const botToken = "424242424:" + "B".repeat(35);
    settings.telegram = (token) => ({
      getMe: async () => {
        if (token !== botToken) {
          throw Object.assign(new Error(), {
            getResponse: () => ({ code: "TELEGRAM_TOKEN_INVALID" }),
          });
        }
        return { username: "PedirrTestBot" };
      },
    });
    const withTelegram = (base, extra) => ({ ...base, ...extra });
    const fightClubChannels = channels(
      "smtp.fightclub.invalid",
      "https://discord.com/api/webhooks/2/fightclub",
    );
    const platformChannels = channels(
      "smtp.platform.invalid",
      "https://discord.com/api/webhooks/1/platform",
    );
    const refused = (expected) => (error) => error.getResponse().code === expected;
    // Before the platform has a bot, resellers can neither enable nor link Telegram.
    await assert.rejects(
      settings.save(withTelegram(fightClubChannels, { telegramEnabled: true }), a.id),
      refused("TELEGRAM_NOT_CONFIGURED"),
    );
    await assert.rejects(settings.startTelegramLink(a.id), refused("TELEGRAM_NOT_CONFIGURED"));
    await assert.rejects(
      settings.save(withTelegram(fightClubChannels, { telegramToken: botToken }), a.id),
      refused("TELEGRAM_TOKEN_PLATFORM_ONLY"),
    );
    await assert.rejects(
      settings.save(withTelegram(platformChannels, { telegramToken: "not-a-token" })),
      refused("TELEGRAM_TOKEN_INVALID"),
    );
    await assert.rejects(
      settings.save(withTelegram(platformChannels, { telegramToken: "1234567:" + "C".repeat(35) })),
      refused("TELEGRAM_TOKEN_INVALID"),
    );
    const platformTelegram = await settings.save(
      withTelegram(platformChannels, { telegramToken: botToken }),
    );
    assert.deepEqual(
      [platformTelegram.hasTelegramToken, platformTelegram.telegramBot],
      [true, "PedirrTestBot"],
    );
    assert.equal((await settings.publicSettings(a.id)).telegramBot, "PedirrTestBot");
    assert.equal((await settings.publicSettings(a.id)).hasTelegramToken, false);
    // Each environment links its own group or channel by posting its code there.
    const platformCode = (await settings.startTelegramLink()).code;
    const resellerLink = await settings.startTelegramLink(a.id);
    assert.equal(resellerLink.bot, "PedirrTestBot");
    const updates = [
      {
        update_id: 1,
        channel_post: {
          text: `/link ${platformCode}`,
          chat: { id: -1001, title: "Platform News" },
        },
      },
      {
        update_id: 2,
        message: {
          text: `/link ${resellerLink.code}`,
          chat: { id: -2002, title: "Fight Club Alerts" },
        },
      },
    ];
    const posted = [];
    await pollTelegram({ db, redis }, settings, () => ({
      getUpdates: async () => updates,
      sendMessage: async (chatId) => posted.push(chatId),
    }));
    assert.deepEqual(posted, ["-1001", "-2002"]);
    // With both linked nothing is pending, so the bot is no longer read.
    assert.equal(await redis.zcard("pedirr:telegram:pending"), 0);
    assert.deepEqual(
      await pollTelegram({ db, redis }, settings, () => assert.fail("Telegram must not be read")),
      { skipped: "nothing_to_link" },
    );
    assert.deepEqual((await settings.publicSettings(a.id)).telegramChat, {
      title: "Fight Club Alerts",
    });
    assert.deepEqual((await settings.publicSettings()).telegramChat, { title: "Platform News" });
    assert.equal((await settings.publicSettings(b.id)).telegramChat, null);
    await settings.save(withTelegram(platformChannels, { telegramEnabled: true }));
    await settings.save(
      withTelegram(fightClubChannels, { telegramEnabled: true, telegramLocale: "es" }),
      a.id,
    );
    // Each chat hears what its Discord channel would, through the platform's bot.
    const telegramLines = (
      await run("request.status", { requestId: request.id, status: "AVAILABLE" })
    ).filter((line) => line.startsWith("telegram"));
    assert.deepEqual(telegramLines, [
      `telegram 424242424 -1001 ${origin}${requestPath}`,
      `telegram 424242424 -2002 ${origin}/k7x2p${requestPath}`,
    ]);
    // Unlinking stops them.
    await settings.unlinkTelegram();
    const afterUnlink = (
      await run("request.status", { requestId: request.id, status: "APPROVED" })
    ).filter((line) => line.startsWith("telegram"));
    assert.deepEqual(afterUnlink, [`telegram 424242424 -2002 ${origin}/k7x2p${requestPath}`]);
    // Without the platform's bot nobody posts, though the reseller's chat stays linked.
    await assert.rejects(
      settings.save(withTelegram(platformChannels, { telegramToken: "" })),
      refused("TELEGRAM_NOT_CONFIGURED"),
    );
    await settings.save(
      withTelegram(platformChannels, { telegramEnabled: false, telegramToken: "" }),
    );
    assert.equal((await settings.publicSettings(a.id)).telegramBot, null);
    const withoutBot = (
      await run("request.status", { requestId: request.id, status: "AVAILABLE" })
    ).filter((line) => line.startsWith("telegram"));
    assert.deepEqual(withoutBot, []);

    // Each environment's delivery log holds only what its settings sent.
    const logged = async (tenantId) =>
      new Set((await settings.deliveries(tenantId)).map((item) => item.tenantId));
    assert.deepEqual([...(await logged(a.id))], [a.id]);
    assert.deepEqual([...(await logged())], ["platform"]);
    assert.equal((await settings.deliveries(b.id)).length, 0);
    console.log(
      "Tenant notifications integration passed: settings and secrets per environment, recipients routed through their environment's settings with its address, the same email at two environments, platform administrators and channels, silent resellers without settings, Telegram with one platform bot (token checks, linking by code in groups and channels, routing and unlinking), and per-environment delivery logs.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("Tenant notifications integration test failed:", error);
  process.exitCode = 1;
});
