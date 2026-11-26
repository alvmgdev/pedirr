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
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import * as argon2 from "argon2";
import { Admin, Credentials, passwordOptions, publicUserSelect, Viewer } from "./auth";
import { Infrastructure } from "./infrastructure";
import { PLATFORM_TENANT } from "./tenants";

export class UserUpdate {
  @ApiProperty({ required: false, enum: ["ADMIN", "USER"] })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(["ADMIN", "USER"])
  role?: "ADMIN" | "USER";
  @ApiProperty({ required: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
  @ApiProperty({ required: false, nullable: true, description: "Null inherits the role policy." })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsBoolean()
  autoApprove?: boolean | null;
  @ApiProperty({
    required: false,
    nullable: true,
    minimum: 0,
    maximum: 1000,
    description: "New requests allowed in any seven days. Null means no limit.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(1000)
  weeklyRequestLimit?: number | null;
  @ApiProperty({
    required: false,
    nullable: true,
    format: "date-time",
    description: "When the account stops working. Null means it never expires.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true })
  expiresAt?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    format: "uuid",
    description: "What the user may request. Null means everything.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID()
  planId?: string | null;
}
export class UserCreate extends Credentials {
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
  @ApiProperty({
    required: false,
    nullable: true,
    format: "uuid",
    description: "What the user may request. Null means everything.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID()
  planId?: string | null;
}
/** A plan ID that does not exist fails the foreign key; say so instead of a server error. */
const planMissing = (error: unknown) =>
  (error as { code?: string }).code === "P2003"
    ? new BadRequestException({ code: "PLAN_NOT_FOUND", message: "Plan not found" })
    : error;
export class UserPage {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @ApiProperty({
    required: false,
    description: 'Only accounts of this environment: "platform" or a reseller\'s ID.',
  })
  @ValidateIf((_, value) => value !== undefined && value !== "")
  @Matches(/^(platform|[0-9a-f-]{36})$/)
  tenant?: string;
}
export class AccessPolicy {
  @ApiProperty() @IsBoolean() registrationEnabled!: boolean;
  @ApiProperty() @IsBoolean() userAutoApprove!: boolean;
  @ApiProperty() @IsBoolean() adminAutoApprove!: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly infrastructure: Infrastructure) {}
  /** Every account, or those of one environment, with the environment each belongs to. */
  async list(page: number, tenant?: string) {
    const where = tenant ? { tenantId: tenant } : {};
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
    return { items, total, page, pageSize: 50 };
  }
  async detail(id: string) {
    const user = await this.infrastructure.db.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
    if (!user) {
      throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found" });
    }
    return user;
  }
  async create(input: UserCreate) {
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.infrastructure.db.user.create({
        data: {
          email: input.email.trim().toLowerCase(),
          passwordHash,
          weeklyRequestLimit: input.weeklyRequestLimit ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          planId: input.planId ?? null,
        },
        select: publicUserSelect,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new ConflictException({
          code: "EMAIL_UNAVAILABLE",
          message: "Email cannot be registered",
        });
      }
      throw planMissing(error);
    }
  }
  async update(id: string, input: UserUpdate) {
    return this.infrastructure.db.$transaction(async (tx) => {
      // Serialize administrator changes with each other and initial provisioning.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(192837)`;
      const user = await tx.user.findUnique({
        where: { id },
        include: {
          tenant: { select: { package: { select: { plans: { select: { id: true } } } } } },
        },
      });
      if (!user) {
        throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found" });
      }
      if (user.tenantId !== PLATFORM_TENANT) {
        // Platform administrators only exist at the platform; reseller accounts keep their role.
        if (input.role !== undefined && input.role !== user.role) {
          throw new BadRequestException({
            code: "ROLE_NOT_ALLOWED",
            message: "A reseller's accounts keep their role",
          });
        }
        // A reseller's clients get plans of the reseller's package.
        const plans = user.tenant.package?.plans ?? [];
        if (input.planId && !plans.some((plan) => plan.id === input.planId)) {
          throw new BadRequestException({
            code: "PLAN_NOT_IN_PACKAGE",
            message: "Choose a plan of the reseller's package",
          });
        }
      }
      if (
        user.active &&
        user.role === "ADMIN" &&
        (input.active === false || input.role === "USER")
      ) {
        if ((await tx.user.count({ where: { role: "ADMIN", active: true } })) <= 1) {
          throw new ConflictException({
            code: "LAST_ADMIN",
            message: "At least one active administrator is required",
          });
        }
      }
      const updated = await tx.user
        .update({ where: { id }, data: input, select: publicUserSelect })
        .catch((error: unknown) => {
          throw planMissing(error);
        });
      if (input.active === false || (input.role !== undefined && input.role !== user.role)) {
        await tx.session.deleteMany({ where: { userId: id } });
      }
      return updated;
    });
  }
  async policy(): Promise<AccessPolicy> {
    const rows = await this.infrastructure.db.setting.findMany({
      where: { key: { in: ["registration", "autoApprove.USER", "autoApprove.ADMIN"] } },
    });
    const enabled = (key: string) => rows.some((row) => row.key === key && row.value === true);
    return {
      registrationEnabled: enabled("registration"),
      userAutoApprove: enabled("autoApprove.USER"),
      adminAutoApprove: enabled("autoApprove.ADMIN"),
    };
  }
  async setPolicy(input: AccessPolicy) {
    const entries = [
      ["registration", input.registrationEnabled],
      ["autoApprove.USER", input.userAutoApprove],
      ["autoApprove.ADMIN", input.adminAutoApprove],
    ] as const;
    await this.infrastructure.db.$transaction(
      entries.map(([key, value]) =>
        this.infrastructure.db.setting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        }),
      ),
    );
    return input;
  }
  async autoApproves(user: Pick<Viewer, "autoApprove" | "role">) {
    if (user.autoApprove !== null) {
      return user.autoApprove;
    }
    const policy = await this.policy();
    return user.role === "ADMIN" ? policy.adminAutoApprove : policy.userAutoApprove;
  }
}

@Admin()
@ApiTags("Administration")
@Controller("admin")
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get("users") list(@Query() query: UserPage) {
    return this.users.list(query.page, query.tenant || undefined);
  }
  @Get("users/:id") detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.users.detail(id);
  }
  @Post("users") create(@Body() input: UserCreate) {
    return this.users.create(input);
  }
  @Patch("users/:id") update(@Param("id", ParseUUIDPipe) id: string, @Body() input: UserUpdate) {
    return this.users.update(id, input);
  }
  @Get("policies") policy() {
    return this.users.policy();
  }
  @Patch("policies") setPolicy(@Body() input: AccessPolicy) {
    return this.users.setPolicy(input);
  }
}
