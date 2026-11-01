import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import * as argon2 from 'argon2';
import { Admin, Credentials, passwordOptions, publicUserSelect, Viewer } from './auth';
import { Infrastructure } from './infrastructure';

export class UserUpdate {
  @ApiProperty({ required: false, enum: ['ADMIN', 'USER'] })
  @ValidateIf((_, value) => value !== undefined) @IsIn(['ADMIN', 'USER']) role?: 'ADMIN' | 'USER';
  @ApiProperty({ required: false })
  @ValidateIf((_, value) => value !== undefined) @IsBoolean() active?: boolean;
  @ApiProperty({ required: false, nullable: true, description: 'Null inherits the role policy.' })
  @ValidateIf((_, value) => value !== undefined && value !== null) @IsBoolean() autoApprove?: boolean | null;
}
export class UserPage {
  @ApiProperty({ required: false, default: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
}
export class AccessPolicy {
  @ApiProperty() @IsBoolean() registrationEnabled!: boolean;
  @ApiProperty() @IsBoolean() userAutoApprove!: boolean;
  @ApiProperty() @IsBoolean() adminAutoApprove!: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly infrastructure: Infrastructure) {}
  async list(page: number) {
    const [items, total] = await this.infrastructure.db.$transaction([
      this.infrastructure.db.user.findMany({ select: publicUserSelect, orderBy: { id: 'asc' }, skip: (page - 1) * 50, take: 50 }),
      this.infrastructure.db.user.count(),
    ]);
    return { items, total, page, pageSize: 50 };
  }
  async create(input: Credentials) {
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.infrastructure.db.user.create({ data: { email: input.email.trim().toLowerCase(), passwordHash }, select: publicUserSelect });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'EMAIL_UNAVAILABLE', message: 'Email cannot be registered' });
      throw error;
    }
  }
  async update(id: string, input: UserUpdate) {
    return this.infrastructure.db.$transaction(async tx => {
      // Serialize administrator changes with each other and initial provisioning.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(192837)`;
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      if (user.active && user.role === 'ADMIN' && (input.active === false || input.role === 'USER')) {
        if (await tx.user.count({ where: { role: 'ADMIN', active: true } }) <= 1) {
          throw new ConflictException({ code: 'LAST_ADMIN', message: 'At least one active administrator is required' });
        }
      }
      const updated = await tx.user.update({ where: { id }, data: input, select: publicUserSelect });
      if (input.active === false || (input.role !== undefined && input.role !== user.role)) {
        await tx.session.deleteMany({ where: { userId: id } });
      }
      return updated;
    });
  }
  async policy(): Promise<AccessPolicy> {
    const rows = await this.infrastructure.db.setting.findMany({ where: { key: { in: ['registration', 'autoApprove.USER', 'autoApprove.ADMIN'] } } });
    const enabled = (key: string) => rows.some(row => row.key === key && row.value === true);
    return { registrationEnabled: enabled('registration'), userAutoApprove: enabled('autoApprove.USER'), adminAutoApprove: enabled('autoApprove.ADMIN') };
  }
  async setPolicy(input: AccessPolicy) {
    const entries = [['registration', input.registrationEnabled], ['autoApprove.USER', input.userAutoApprove], ['autoApprove.ADMIN', input.adminAutoApprove]] as const;
    await this.infrastructure.db.$transaction(entries.map(([key, value]) => this.infrastructure.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })));
    return input;
  }
  async autoApproves(user: Pick<Viewer, 'autoApprove' | 'role'>) {
    if (user.autoApprove !== null) return user.autoApprove;
    const policy = await this.policy();
    return user.role === 'ADMIN' ? policy.adminAutoApprove : policy.userAutoApprove;
  }
}

@Admin() @ApiTags('Administration') @Controller('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get('users') list(@Query() query: UserPage) { return this.users.list(query.page); }
  @Post('users') create(@Body() input: Credentials) { return this.users.create(input); }
  @Patch('users/:id') update(@Param('id', ParseUUIDPipe) id: string, @Body() input: UserUpdate) { return this.users.update(id, input); }
  @Get('policies') policy() { return this.users.policy(); }
  @Patch('policies') setPolicy(@Body() input: AccessPolicy) { return this.users.setPolicy(input); }
}
