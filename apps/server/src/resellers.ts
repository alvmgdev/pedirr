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
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import { randomInt } from "node:crypto";
import { Admin, Credentials, PASSWORD_MIN_LENGTH, passwordOptions } from "./auth";
import { Infrastructure } from "./infrastructure";
import { isTenantCode, PLATFORM_TENANT } from "./tenants";

// Generated codes avoid characters that are easy to confuse (0/o, 1/l/i).
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function generateTenantCode(length = 5) {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

class ResellerFields {
  @ApiProperty({ required: false, nullable: true, format: "uuid" })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUUID()
  packageId?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    minimum: 0,
    maximum: 100000,
    description: "Clients the reseller may have. Null means no limit.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(100000)
  maxUsers?: number | null;
}
export class ResellerCreate extends ResellerFields {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
  @ApiProperty({
    required: false,
    description: "Address code (/<code>/); generated when left out. It cannot change later.",
  })
  @ValidateIf((_, value) => value !== undefined && value !== "")
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(20)
  code?: string;
  @ApiProperty({ type: Credentials, description: "The reseller administrator's account." })
  @ValidateNested()
  @Type(() => Credentials)
  admin!: Credentials;
}
export class ResellerUpdate extends ResellerFields {
  @ApiProperty({ required: false, minLength: 1, maxLength: 80 })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
  @ApiProperty({ required: false, description: "A disabled reseller's users cannot sign in." })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}
export class ResellerPassword {
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: 128 })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(128)
  password!: string;
}

const resellerSelect = {
  id: true,
  code: true,
  name: true,
  active: true,
  maxUsers: true,
  createdAt: true,
  package: { select: { id: true, name: true } },
  users: { where: { role: "RESELLER" as const }, select: { id: true, email: true }, take: 1 },
  _count: { select: { users: { where: { role: "USER" as const } } } },
} satisfies Prisma.TenantSelect;
type ResellerRow = Prisma.TenantGetPayload<{ select: typeof resellerSelect }>;
const present = ({ users, _count, ...reseller }: ResellerRow) => ({
  ...reseller,
  admin: users[0] ?? null,
  clients: _count.users,
});
const notFound = () =>
  new NotFoundException({ code: "RESELLER_NOT_FOUND", message: "Reseller not found" });
// The platform is an environment too, but never a reseller.
const resellers = { id: { not: PLATFORM_TENANT } } satisfies Prisma.TenantWhereInput;

@Injectable()
export class ResellersService {
  constructor(private readonly infrastructure: Infrastructure) {}
  async list() {
    const rows = await this.infrastructure.db.tenant.findMany({
      where: resellers,
      select: resellerSelect,
      orderBy: { name: "asc" },
    });
    return rows.map(present);
  }
  async detail(id: string) {
    const row = await this.infrastructure.db.tenant.findFirst({
      // Both conditions are on the ID, so they must be combined, not merged.
      where: { AND: [resellers, { id }] },
      select: resellerSelect,
    });
    if (!row) {
      throw notFound();
    }
    return present(row);
  }
  private failure(error: unknown): never {
    const code = (error as { code?: string; meta?: { target?: unknown } }).code;
    if (code === "P2002") {
      throw new ConflictException({
        code: "RESELLER_CODE_TAKEN",
        message: "Another reseller has this code",
      });
    }
    if (code === "P2003") {
      throw new BadRequestException({ code: "PACKAGE_NOT_FOUND", message: "Package not found" });
    }
    throw error;
  }
  /** Creates the reseller and its administrator together, so neither exists without the other. */
  async create(input: ResellerCreate) {
    if (input.code && !isTenantCode(input.code)) {
      throw new BadRequestException({
        code: "INVALID_RESELLER_CODE",
        message: "Use 3 to 20 lowercase letters, digits or inner hyphens, not a reserved word",
      });
    }
    const passwordHash = await argon2.hash(input.admin.password, passwordOptions);
    // A generated code can collide or spell a reserved word; try a few.
    for (let attempt = 0; ; attempt++) {
      const code = input.code || generateTenantCode();
      if (!isTenantCode(code) && attempt < 5) {
        continue;
      }
      try {
        const tenant = await this.infrastructure.db.tenant.create({
          data: {
            code,
            name: input.name,
            packageId: input.packageId ?? null,
            maxUsers: input.maxUsers ?? null,
            users: {
              create: {
                email: input.admin.email.trim().toLowerCase(),
                passwordHash,
                role: "RESELLER",
              },
            },
          },
          select: { id: true },
        });
        return this.detail(tenant.id);
      } catch (error) {
        const taken = (error as { code?: string }).code === "P2002";
        if (taken && !input.code && attempt < 5) {
          continue;
        }
        this.failure(error);
      }
    }
  }
  async update(id: string, input: ResellerUpdate) {
    await this.detail(id);
    try {
      await this.infrastructure.db.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id }, data: input });
        // Signing in already fails for a disabled reseller; end the open sessions too.
        if (input.active === false) {
          await tx.session.deleteMany({ where: { user: { tenantId: id } } });
        }
      });
    } catch (error) {
      this.failure(error);
    }
    return this.detail(id);
  }
  /** Sets a new password for the reseller administrator and signs them out everywhere. */
  async resetAdminPassword(id: string, input: ResellerPassword) {
    const reseller = await this.detail(id);
    if (!reseller.admin) {
      throw notFound();
    }
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    await this.infrastructure.db.$transaction([
      this.infrastructure.db.user.update({
        where: { id: reseller.admin.id },
        data: { passwordHash },
      }),
      this.infrastructure.db.session.deleteMany({ where: { userId: reseller.admin.id } }),
    ]);
    return { ok: true as const };
  }
}

@Admin()
@ApiTags("Administration")
@Controller("admin/resellers")
export class ResellersController {
  constructor(private readonly resellers: ResellersService) {}
  @Get() list() {
    return this.resellers.list();
  }
  @Get(":id") detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.resellers.detail(id);
  }
  @Post() create(@Body() input: ResellerCreate) {
    return this.resellers.create(input);
  }
  @Patch(":id") update(@Param("id", ParseUUIDPipe) id: string, @Body() input: ResellerUpdate) {
    return this.resellers.update(id, input);
  }
  @Post(":id/admin-password") resetAdminPassword(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ResellerPassword,
  ) {
    return this.resellers.resetAdminPassword(id, input);
  }
}
