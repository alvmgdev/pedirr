import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";
import { required } from "./config";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["password", "apiKey", "authorization", "cookie", "secret", "token"],
});

@Injectable()
export class Infrastructure implements OnModuleDestroy {
  readonly db = new PrismaClient();
  readonly redis = new Redis(required("REDIS_URL"), { maxRetriesPerRequest: 1, lazyConnect: true });

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
    this.redis.disconnect();
  }
}
