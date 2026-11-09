import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";
import { Type } from "class-transformer";
import { RequestStatus } from "@prisma/client";
import { Admin, AuthRequest, AuthService } from "../auth";
import { RequestsService } from "./service";

export class CreateRequest {
  @ApiProperty({ enum: ["season", "event"] }) @IsIn(["season", "event"]) kind!: "season" | "event";
  @ApiProperty() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) identifier!: string;
}
export class RequestList {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;
  @ApiProperty({ required: false, enum: Object.values(RequestStatus) })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(Object.values(RequestStatus))
  status?: RequestStatus;
  @ApiProperty({ required: false, enum: ["true", "false"] })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(["true", "false"])
  mine?: string;
}
export class ReviewRequest {
  @ApiProperty({ enum: ["approve", "reject"] }) @IsIn(["approve", "reject"]) decision!:
    "approve" | "reject";
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(2147483646) version!: number;
  @ApiProperty({ required: false, maxLength: 1000 })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
@ApiTags("Requests")
@Controller("requests")
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly auth: AuthService,
  ) {}
  @Post() create(@Body() input: CreateRequest, @Req() req: AuthRequest) {
    return this.requests.create(input, req.viewer!);
  }
  @Get() list(@Query() query: RequestList, @Req() req: AuthRequest) {
    return this.requests.list(req.viewer!, query.page, query.status, query.mine === "true");
  }
  @Get("lookup") async lookup(@Query() query: CreateRequest, @Req() req: AuthRequest) {
    await this.auth.rate(`availability:${req.viewer!.id}`, 30, 60);
    return this.requests.lookup(query);
  }
  @Get(":id") detail(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.requests.detail(id, req.viewer!);
  }
  @Admin() @Post(":id/review") review(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ReviewRequest,
    @Req() req: AuthRequest,
  ) {
    return this.requests.moderate(id, input, req.viewer!);
  }
}
