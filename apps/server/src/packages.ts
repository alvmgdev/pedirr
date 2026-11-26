import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { Admin } from "./auth";
import { Infrastructure } from "./infrastructure";

export class PackageInput {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
  @ApiProperty({ type: [String], description: "Plans resellers with this package may assign." })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  planIds!: string[];
}

const packageSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  plans: { select: { id: true, name: true }, orderBy: { name: "asc" as const } },
  _count: { select: { tenants: true } },
} satisfies Prisma.PlanPackageSelect;
type PackageRow = Prisma.PlanPackageGetPayload<{ select: typeof packageSelect }>;
const present = ({ _count, ...pack }: PackageRow) => ({ ...pack, resellers: _count.tenants });
const notFound = () =>
  new NotFoundException({ code: "PACKAGE_NOT_FOUND", message: "Package not found" });

/** Packages of plans the platform administrator gives resellers to assign to their clients. */
@Injectable()
export class PackagesService {
  constructor(private readonly infrastructure: Infrastructure) {}
  async list() {
    const packages = await this.infrastructure.db.planPackage.findMany({
      select: packageSelect,
      orderBy: { name: "asc" },
    });
    return packages.map(present);
  }
  async detail(id: string) {
    const pack = await this.infrastructure.db.planPackage.findUnique({
      where: { id },
      select: packageSelect,
    });
    if (!pack) {
      throw notFound();
    }
    return present(pack);
  }
  /** Every plan must exist; a package may also be empty while it is being prepared. */
  private async plans(input: PackageInput) {
    const ids = [...new Set(input.planIds)];
    const found = await this.infrastructure.db.plan.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      throw new BadRequestException({
        code: "INVALID_PACKAGE_PLAN",
        message: "A plan of the package no longer exists",
      });
    }
    return ids.map((id) => ({ id }));
  }
  private conflict(error: unknown): never {
    if ((error as { code?: string }).code === "P2002") {
      throw new ConflictException({
        code: "PACKAGE_NAME_TAKEN",
        message: "Another package has this name",
      });
    }
    if ((error as { code?: string }).code === "P2025") {
      throw notFound();
    }
    throw error;
  }
  async create(input: PackageInput) {
    const plans = await this.plans(input);
    try {
      return present(
        await this.infrastructure.db.planPackage.create({
          data: { name: input.name, plans: { connect: plans } },
          select: packageSelect,
        }),
      );
    } catch (error) {
      this.conflict(error);
    }
  }
  async update(id: string, input: PackageInput) {
    const plans = await this.plans(input);
    try {
      return present(
        await this.infrastructure.db.planPackage.update({
          where: { id },
          data: { name: input.name, plans: { set: plans } },
          select: packageSelect,
        }),
      );
    } catch (error) {
      this.conflict(error);
    }
  }
  /** A package still given to resellers cannot be deleted; give them another one first. */
  async remove(id: string) {
    return this.infrastructure.db.$transaction(async (tx) => {
      const pack = await tx.planPackage.findUnique({ where: { id }, select: packageSelect });
      if (!pack) {
        throw notFound();
      }
      if (pack._count.tenants > 0) {
        throw new ConflictException({
          code: "PACKAGE_IN_USE",
          message: "Give the package's resellers another package before deleting it",
        });
      }
      await tx.planPackage.delete({ where: { id } });
      return { ok: true as const };
    });
  }
}

@Admin()
@ApiTags("Administration")
@Controller("admin/packages")
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}
  @Get() list() {
    return this.packages.list();
  }
  @Get(":id") detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.packages.detail(id);
  }
  @Post() create(@Body() input: PackageInput) {
    return this.packages.create(input);
  }
  @Put(":id") update(@Param("id", ParseUUIDPipe) id: string, @Body() input: PackageInput) {
    return this.packages.update(id, input);
  }
  @Delete(":id") remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.packages.remove(id);
  }
}
