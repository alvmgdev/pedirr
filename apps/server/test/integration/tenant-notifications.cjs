const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const Redis = require("ioredis");
const { Notifications } = require("../../dist/notifications/service");
const { NotificationSettings } = require("../../dist/settings/notifications");

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
    const settings = new NotificationSettings({ db });
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
    const recorder = (channel) => ({
      send: async (config, recipient, notice) =>
        sent.push({
          channel,
          via: channel === "email" ? config.smtpHost : config.discordWebhook.split("/").pop(),
          recipient: channel === "email" ? recipient : "channel",
          url: notice.url,
        }),
    });
    const worker = new Notifications(
      { db, redis },
      settings,
      recorder("email"),
      recorder("discord"),
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

    // Each environment's delivery log holds only what its settings sent.
    const logged = async (tenantId) =>
      new Set((await settings.deliveries(tenantId)).map((item) => item.tenantId));
    assert.deepEqual([...(await logged(a.id))], [a.id]);
    assert.deepEqual([...(await logged())], ["platform"]);
    assert.equal((await settings.deliveries(b.id)).length, 0);
    console.log(
      "Tenant notifications integration passed: settings and secrets per environment, recipients routed through their environment's settings with its address, the same email at two environments, platform administrators and channels, silent resellers without settings, and per-environment delivery logs.",
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
