import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { IssueCategory, IssueStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { AuthRequest, AuthService } from "../auth";
import { IssuesService } from "./service";
import { ISSUE_CATEGORIES, ISSUE_STATUSES } from "./rules";

const optional = ValidateIf((_, value) => value !== undefined);

export class CreateIssue {
  @ApiProperty({ enum: ISSUE_CATEGORIES }) @IsIn(ISSUE_CATEGORIES) category!: IssueCategory;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;
  @ApiProperty({ required: false, description: "Affected event of a season request." })
  @optional
  @IsUUID()
  eventId?: string;
  @ApiProperty({ required: false, description: "Affected part, for events split into parts." })
  @optional
  @IsString()
  @MaxLength(60)
  part?: string;
}
export class IssueList {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;
  @ApiProperty({ required: false, enum: ISSUE_STATUSES })
  @optional
  @IsIn(ISSUE_STATUSES)
  status?: IssueStatus;
  @ApiProperty({ required: false, enum: ISSUE_CATEGORIES })
  @optional
  @IsIn(ISSUE_CATEGORIES)
  category?: IssueCategory;
  @ApiProperty({ required: false, enum: ["true", "false"] })
  @optional
  @IsIn(["true", "false"])
  mine?: string;
  @ApiProperty({ required: false, description: "Only issues about this request." })
  @optional
  @IsUUID()
  request?: string;
}
export class IssueComment {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
export class IssueStatusChange {
  @ApiProperty({ enum: ISSUE_STATUSES }) @IsIn(ISSUE_STATUSES) status!: IssueStatus;
  @ApiProperty({ required: false, maxLength: 2000, description: "Required when resolving." })
  @optional
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

@ApiTags("Issues")
@Controller()
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly auth: AuthService,
  ) {}
  @Post("requests/:id/issues") async create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CreateIssue,
    @Req() req: AuthRequest,
  ) {
    await this.auth.rate(`issues:${req.viewer!.id}`, 10, 3600);
    return this.issues.create(id, input, req.viewer!);
  }
  @Get("issues") list(@Query() query: IssueList, @Req() req: AuthRequest) {
    return this.issues.list(req.viewer!, {
      page: query.page,
      status: query.status,
      category: query.category,
      mine: query.mine === "true",
      requestId: query.request,
    });
  }
  @Get("issues/open") open(@Req() req: AuthRequest) {
    return this.issues.open(req.viewer!);
  }
  @Get("issues/:id") detail(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.issues.detail(id, req.viewer!);
  }
  @Post("issues/:id/comments") async comment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: IssueComment,
    @Req() req: AuthRequest,
  ) {
    await this.auth.rate(`issue-comments:${req.viewer!.id}`, 60, 3600);
    return this.issues.comment(id, input.body, req.viewer!);
  }
  @Patch("issues/:id") status(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: IssueStatusChange,
    @Req() req: AuthRequest,
  ) {
    return this.issues.changeStatus(id, input, req.viewer!);
  }
}
