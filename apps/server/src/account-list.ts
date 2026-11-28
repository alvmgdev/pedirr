import { ApiProperty } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import { Type } from "class-transformer";
import { IsIn, IsInt, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

const optional = ValidateIf((_, value) => value !== undefined && value !== "");

/** Search, filters and order shared by the platform's user list and a reseller's client list. */
export class AccountListQuery {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @ApiProperty({ required: false, description: "Part of the email, in any case." })
  @optional
  @MaxLength(254)
  q?: string;
  @ApiProperty({
    required: false,
    enum: ["active", "inactive", "expired"],
    description: "Expired accounts are active ones past their expiration date.",
  })
  @optional
  @IsIn(["active", "inactive", "expired"])
  status?: "active" | "inactive" | "expired";
  @ApiProperty({
    required: false,
    description: 'A plan\'s ID, or "none" for accounts without one.',
  })
  @optional
  @Matches(/^(none|[0-9a-f-]{36})$/)
  plan?: string;
  @ApiProperty({ required: false, enum: ["email", "created", "expires"], default: "email" })
  @optional
  @IsIn(["email", "created", "expires"])
  sort?: "email" | "created" | "expires";
  @ApiProperty({ required: false, enum: ["asc", "desc"], default: "asc" })
  @optional
  @IsIn(["asc", "desc"])
  order?: "asc" | "desc";
}

/** The accounts matching a list's search and filters. Expiration only ever applies to users. */
export function accountFilters(query: AccountListQuery, now = new Date()): Prisma.UserWhereInput {
  const expired: Prisma.UserWhereInput = { role: "USER", expiresAt: { lte: now } };
  const filters: Prisma.UserWhereInput[] = [];
  if (query.q) {
    filters.push({ email: { contains: query.q.trim(), mode: "insensitive" } });
  }
  if (query.status === "inactive") {
    filters.push({ active: false });
  } else if (query.status === "expired") {
    filters.push({ active: true, ...expired });
  } else if (query.status === "active") {
    filters.push({ active: true, NOT: expired });
  }
  if (query.plan) {
    filters.push({ planId: query.plan === "none" ? null : query.plan });
  }
  return { AND: filters };
}

/** A list's order; accounts without an expiration date come last, whichever the direction. */
export function accountOrder(query: AccountListQuery): Prisma.UserOrderByWithRelationInput[] {
  const order = query.order ?? "asc";
  const first: Prisma.UserOrderByWithRelationInput =
    query.sort === "created"
      ? { createdAt: order }
      : query.sort === "expires"
        ? { expiresAt: { sort: order, nulls: "last" } }
        : { email: order };
  return [first, { email: "asc" }, { id: "asc" }];
}
