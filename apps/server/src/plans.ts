import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Prisma } from "@prisma/client";
import { Admin } from "./auth";
import { Infrastructure } from "./infrastructure";
import { MetadataProvider } from "./metadata/provider";

type Grant = { kind: "SPORT" | "LEAGUE"; hubId: string };
export type PlanAccess = { allContent: boolean; grants: Grant[] } | null | undefined;

/**
 * Whether a plan lets its users request content of a league: a league grant matches the league,
 * a sport grant every league of that sport. Without a plan, users may request everything.
 */
export function planAllows(plan: PlanAccess, league: { id: string; sportId?: unknown }) {
  if (!plan || plan.allContent) {
    return true;
  }
  return plan.grants.some((grant) =>
    grant.kind === "LEAGUE" ? grant.hubId === league.id : grant.hubId === league.sportId,
  );
}
export const planNotAllowed = () =>
  new ForbiddenException({
    code: "PLAN_NOT_ALLOWED",
    message: "Your plan does not include this league",
  });

export class PlanGrantInput {
  @ApiProperty({ enum: ["SPORT", "LEAGUE"] }) @IsIn(["SPORT", "LEAGUE"]) kind!: "SPORT" | "LEAGUE";
  @ApiProperty({ description: "Sportarr Hub ID (UUID or short ID) of the sport or league." })
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/)
  hubId!: string;
}
export class PlanInput {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
  @ApiProperty({ description: "Every sport and league; grants are then ignored." })
  @IsBoolean()
  allContent!: boolean;
  @ApiProperty({ type: [PlanGrantInput] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PlanGrantInput)
  grants!: PlanGrantInput[];
}

const planSelect = {
  id: true,
  name: true,
  allContent: true,
  createdAt: true,
  updatedAt: true,
  grants: {
    select: { kind: true, hubId: true, name: true },
    orderBy: [{ kind: "asc" as const }, { name: "asc" as const }],
  },
  _count: { select: { users: true, packages: true } },
} satisfies Prisma.PlanSelect;
type PlanRow = Prisma.PlanGetPayload<{ select: typeof planSelect }>;
const present = ({ _count, ...plan }: PlanRow) => ({
  ...plan,
  users: _count.users,
  packages: _count.packages,
});
const notFound = () => new NotFoundException({ code: "PLAN_NOT_FOUND", message: "Plan not found" });
const invalidGrant = () =>
  new BadRequestException({
    code: "INVALID_PLAN_GRANT",
    message: "A sport or league of the plan was not found in the catalog",
  });

@Injectable()
export class PlansService {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly metadata: MetadataProvider,
  ) {}
  async list() {
    const plans = await this.infrastructure.db.plan.findMany({
      select: planSelect,
      orderBy: { name: "asc" },
    });
    return plans.map(present);
  }
  async detail(id: string) {
    const plan = await this.infrastructure.db.plan.findUnique({
      where: { id },
      select: planSelect,
    });
    if (!plan) {
      throw notFound();
    }
    return present(plan);
  }
  async sports() {
    const page = await this.metadata.sports();
    return page.items
      .filter((sport) => sport.isActive !== false)
      .map((sport) => ({ id: sport.id, name: sport.name }));
  }
  /**
   * Stores grants under Hub's canonical ID and name, never the client's. Grants the plan already
   * has keep their stored name, so saving a plan does not look every league up again.
   */
  private async grants(input: PlanInput, current: { kind: string; hubId: string; name: string }[]) {
    if (!input.allContent && input.grants.length === 0) {
      throw new BadRequestException({
        code: "PLAN_EMPTY",
        message: "Choose at least one sport or league, or every sport",
      });
    }
    let sports: { id: string; name: string; shortId?: unknown }[] | undefined;
    const resolved = new Map<string, Grant & { name: string }>();
    for (const grant of input.grants) {
      const known = current.find((item) => item.kind === grant.kind && item.hubId === grant.hubId);
      let found: { id: string; name: string } | undefined = known
        ? { id: known.hubId, name: known.name }
        : undefined;
      if (!found && grant.kind === "SPORT") {
        sports ??= (await this.metadata.sports()).items;
        found = sports.find((sport) => sport.id === grant.hubId || sport.shortId === grant.hubId);
      } else if (!found) {
        try {
          found = await this.metadata.league(grant.hubId);
        } catch (error) {
          if (error instanceof NotFoundException) {
            throw invalidGrant();
          }
          throw error;
        }
      }
      if (!found) {
        throw invalidGrant();
      }
      resolved.set(`${grant.kind}:${found.id}`, {
        kind: grant.kind,
        hubId: found.id,
        name: found.name,
      });
    }
    return [...resolved.values()];
  }
  private conflict(error: unknown): never {
    if ((error as { code?: string }).code === "P2002") {
      throw new ConflictException({
        code: "PLAN_NAME_TAKEN",
        message: "Another plan has this name",
      });
    }
    throw error;
  }
  async create(input: PlanInput) {
    const grants = await this.grants(input, []);
    try {
      return present(
        await this.infrastructure.db.plan.create({
          data: {
            name: input.name,
            allContent: input.allContent,
            grants: { create: grants },
          },
          select: planSelect,
        }),
      );
    } catch (error) {
      this.conflict(error);
    }
  }
  async update(id: string, input: PlanInput) {
    const current = await this.infrastructure.db.planGrant.findMany({ where: { planId: id } });
    const grants = await this.grants(input, current);
    try {
      return await this.infrastructure.db.$transaction(async (tx) => {
        if (!(await tx.plan.findUnique({ where: { id } }))) {
          throw notFound();
        }
        await tx.planGrant.deleteMany({ where: { planId: id } });
        return present(
          await tx.plan.update({
            where: { id },
            data: {
              name: input.name,
              allContent: input.allContent,
              grants: { create: grants },
            },
            select: planSelect,
          }),
        );
      });
    } catch (error) {
      this.conflict(error);
    }
  }
  /** A plan still assigned to users cannot be deleted; move them to another plan first. */
  async remove(id: string) {
    return this.infrastructure.db.$transaction(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { id }, select: planSelect });
      if (!plan) {
        throw notFound();
      }
      if (plan._count.users > 0) {
        throw new ConflictException({
          code: "PLAN_IN_USE",
          message: "Move the plan's users to another plan before deleting it",
        });
      }
      // Removing it would silently shrink what resellers sell.
      if (plan._count.packages > 0) {
        throw new ConflictException({
          code: "PLAN_IN_PACKAGE",
          message: "Remove the plan from its packages before deleting it",
        });
      }
      await tx.plan.delete({ where: { id } });
      return { ok: true as const };
    });
  }
}

@Admin()
@ApiTags("Administration")
@Controller("admin/plans")
export class PlansController {
  constructor(private readonly plans: PlansService) {}
  @Get() list() {
    return this.plans.list();
  }
  @Get("sports") sports() {
    return this.plans.sports();
  }
  @Get(":id") detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.plans.detail(id);
  }
  @Post() create(@Body() input: PlanInput) {
    return this.plans.create(input);
  }
  @Put(":id") update(@Param("id", ParseUUIDPipe) id: string, @Body() input: PlanInput) {
    return this.plans.update(id, input);
  }
  @Delete(":id") remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.plans.remove(id);
  }
}
