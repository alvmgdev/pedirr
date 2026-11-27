import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import {
  AuthRequest,
  Credentials,
  PASSWORD_MIN_LENGTH,
  passwordOptions,
  publicUserSelect,
  ResellerAdmin,
} from "./auth";
import { Infrastructure } from "./infrastructure";
import { withWeeklyUsage } from "./requests/quota";
import { UserPage } from "./users";

/** What a reseller administrator may set on a client; never the role or approval. */
class ClientFields {
  @ApiProperty({
    required: false,
    nullable: true,
    format: "uuid",
    description: "A plan of the reseller's package. Without one the client cannot request.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID()
  planId?: string | null;
  @ApiProperty({ required: false, nullable: true, minimum: 0, maximum: 1000 })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(1000)
  weeklyRequestLimit?: number | null;
  @ApiProperty({ required: false, nullable: true, format: "date-time" })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}
export class ClientCreate extends Credentials {
  @ApiProperty({ required: false, nullable: true, format: "uuid" })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID()
  planId?: string | null;
  @ApiProperty({ required: false, nullable: true, minimum: 0, maximum: 1000 })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(1000)
  weeklyRequestLimit?: number | null;
  @ApiProperty({ required: false, nullable: true, format: "date-time" })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}
export class ClientUpdate extends ClientFields {
  @ApiProperty({ required: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}
export class ClientPassword {
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: 128 })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(128)
  password!: string;
}

const notFound = () =>
  new NotFoundException({ code: "CLIENT_NOT_FOUND", message: "Client not found" });
/** A reseller's clients: its accounts with the user role. */
const clientsOf = (tenantId: string) => ({ tenantId, role: "USER" as const });

/**
 * A reseller administrator's view of its own reseller and clients. Every query is scoped to the
 * administrator's environment, so one reseller can never see or change another's accounts.
 */
@Injectable()
export class ClientsService {
  constructor(private readonly infrastructure: Infrastructure) {}
  private async tenant(tenantId: string, db: Prisma.TransactionClient = this.infrastructure.db) {
    return db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        code: true,
        name: true,
        maxUsers: true,
        package: { select: { id: true, name: true, plans: { select: { id: true, name: true } } } },
        _count: { select: { users: { where: { role: "USER" } } } },
      },
    });
  }
  async overview(tenantId: string) {
    const { _count, ...tenant } = await this.tenant(tenantId);
    return { ...tenant, clients: _count.users };
  }
  private async planOf(tenantId: string, planId: string | null | undefined) {
    if (!planId) {
      return;
    }
    const { package: pack } = await this.tenant(tenantId);
    if (!pack?.plans.some((plan) => plan.id === planId)) {
      throw new BadRequestException({
        code: "PLAN_NOT_IN_PACKAGE",
        message: "Choose a plan of your package",
      });
    }
  }
  async list(tenantId: string, page: number) {
    const where = clientsOf(tenantId);
    const [items, total] = await this.infrastructure.db.$transaction([
      this.infrastructure.db.user.findMany({
        where,
        select: publicUserSelect,
        orderBy: [{ email: "asc" }, { id: "asc" }],
        skip: (page - 1) * 50,
        take: 50,
      }),
      this.infrastructure.db.user.count({ where }),
    ]);
    return {
      items: await withWeeklyUsage(this.infrastructure.db, items),
      total,
      page,
      pageSize: 50,
    };
  }
  async detail(tenantId: string, id: string) {
    const client = await this.infrastructure.db.user.findFirst({
      where: { id, ...clientsOf(tenantId) },
      select: publicUserSelect,
    });
    if (!client) {
      throw notFound();
    }
    return client;
  }
  /** Creates a client within the reseller's limit; concurrent creations take turns. */
  async create(tenantId: string, input: ClientCreate) {
    await this.planOf(tenantId, input.planId);
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.infrastructure.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`clients:${tenantId}`}))`;
        const tenant = await this.tenant(tenantId, tx);
        if (tenant.maxUsers !== null && tenant._count.users >= tenant.maxUsers) {
          throw new ConflictException({
            code: "CLIENT_LIMIT_REACHED",
            message: "You have reached the number of clients you can have",
          });
        }
        return tx.user.create({
          data: {
            email: input.email.trim().toLowerCase(),
            passwordHash,
            tenantId,
            planId: input.planId ?? null,
            weeklyRequestLimit: input.weeklyRequestLimit ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          },
          select: publicUserSelect,
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new ConflictException({
          code: "EMAIL_UNAVAILABLE",
          message: "Email cannot be registered",
        });
      }
      throw error;
    }
  }
  async update(tenantId: string, id: string, input: ClientUpdate) {
    await this.detail(tenantId, id);
    await this.planOf(tenantId, input.planId);
    return this.infrastructure.db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...input,
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
            : {}),
        },
        select: publicUserSelect,
      });
      if (input.active === false) {
        await tx.session.deleteMany({ where: { userId: id } });
      }
      return updated;
    });
  }
  /** Sets a new password for a client and signs them out everywhere. */
  async resetPassword(tenantId: string, id: string, input: ClientPassword) {
    await this.detail(tenantId, id);
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    await this.infrastructure.db.$transaction([
      this.infrastructure.db.user.update({ where: { id }, data: { passwordHash } }),
      this.infrastructure.db.session.deleteMany({ where: { userId: id } }),
    ]);
    return { ok: true as const };
  }
}

@ResellerAdmin()
@ApiTags("Reseller")
@Controller("reseller")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}
  @Get("overview") overview(@Req() req: AuthRequest) {
    return this.clients.overview(req.viewer!.tenantId);
  }
  @Get("clients") list(@Query() query: UserPage, @Req() req: AuthRequest) {
    return this.clients.list(req.viewer!.tenantId, query.page);
  }
  @Get("clients/:id") detail(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.clients.detail(req.viewer!.tenantId, id);
  }
  @Post("clients") create(@Body() input: ClientCreate, @Req() req: AuthRequest) {
    return this.clients.create(req.viewer!.tenantId, input);
  }
  @Patch("clients/:id") update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ClientUpdate,
    @Req() req: AuthRequest,
  ) {
    return this.clients.update(req.viewer!.tenantId, id, input);
  }
  @Post("clients/:id/password") resetPassword(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ClientPassword,
    @Req() req: AuthRequest,
  ) {
    return this.clients.resetPassword(req.viewer!.tenantId, id, input);
  }
}
