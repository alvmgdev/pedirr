import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, Injectable, Patch, Post, Req, Res, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, ValidateIf, IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import { Infrastructure } from './infrastructure';
import { required } from './config';

export const Public = () => SetMetadata('public', true);
export const Admin = () => SetMetadata('admin', true);
export const publicUserSelect = { id: true, email: true, role: true, active: true, locale: true, timezone: true, autoApprove: true } as const;
export type Viewer = { id: string; email: string; role: 'ADMIN' | 'USER'; active: boolean; locale: string; timezone: string; autoApprove: boolean | null };
export type AuthRequest = Request & { viewer?: Viewer; sessionHash?: string };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const passwordOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export class Credentials {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 }) @IsString() @MinLength(12) @MaxLength(128) password!: string;
}
export class ProfileUpdate {
  @ApiProperty({ enum: ['en', 'es'], required: false }) @ValidateIf((_, value) => value !== undefined) @IsIn(['en', 'es']) locale?: string;
  @ApiProperty({ required: false }) @ValidateIf((_, value) => value !== undefined) @IsString() @MinLength(1) @MaxLength(100) timezone?: string;
}
export class PasswordUpdate {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: 12 }) @IsString() @MinLength(12) @MaxLength(128) newPassword!: string;
}

@Injectable()
export class AuthService {
  private readonly secret = required('SESSION_SECRET');
  readonly origin = new URL(required('APP_ORIGIN')).origin;
  readonly secure = this.origin.startsWith('https:');
  readonly cookieName = this.secure ? '__Host-pedirr_session' : 'pedirr_session';
  constructor(readonly infrastructure: Infrastructure) {
    if (this.secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  csrf(sessionHash = '') {
    const nonce = randomBytes(24).toString('hex');
    return `${nonce}.${this.sign(nonce, sessionHash)}`;
  }
  private sign(nonce: string, sessionHash: string) {
    return createHmac('sha256', this.secret).update(`${nonce}:${sessionHash}`).digest('hex');
  }
  verifyCsrf(token: unknown, sessionHash = '') {
    if (typeof token !== 'string' || !/^[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(nonce, sessionHash), 'hex'));
  }
  async rate(key: string, limit: number, seconds: number) {
    const value = await this.infrastructure.redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`, 1, `pedirr:rate:${key}`, seconds);
    if (Number(value) > limit) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' }, 429);
  }
  async resolve(req: AuthRequest) {
    const token: unknown = req.cookies?.[this.cookieName];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
    const sessionHash = digest(token);
    const session = await this.infrastructure.db.session.findUnique({ where: { tokenHash: sessionHash }, include: { user: { select: publicUserSelect } } });
    if (!session || session.expiresAt < new Date() || !session.user.active) return;
    req.viewer = session.user;
    req.sessionHash = sessionHash;
  }
  async login(email: string, password: string, res: Response) {
    const user = await this.infrastructure.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Keep unknown-account and wrong-password responses identical.
    const valid = user ? await argon2.verify(user.passwordHash, password) : await argon2.verify(await this.dummyHash, password);
    if (!valid || !user?.active) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    await this.infrastructure.db.session.create({ data: { tokenHash: digest(token), userId: user.id, expiresAt } });
    res.cookie(this.cookieName, token, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/', expires: expiresAt });
    return this.infrastructure.db.user.findUniqueOrThrow({ where: { id: user.id }, select: publicUserSelect });
  }
  private readonly dummyHash = argon2.hash(randomBytes(32), passwordOptions);
}

@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    await this.auth.resolve(req);
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', targets);
    if (!isPublic && !req.viewer) throw new UnauthorizedException();
    if (this.reflector.getAllAndOverride<boolean>('admin', targets) && req.viewer?.role !== 'ADMIN') throw new ForbiddenException();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== this.auth.origin || !this.auth.verifyCsrf(req.headers['x-csrf-token'], req.sessionHash)) throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Refresh the page and try again' });
      await this.auth.rate(`write:${req.viewer?.id ?? req.ip}`, 120, 60);
    }
    return true;
  }
}

@ApiTags('Authentication')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Get('auth/csrf')
  csrf(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { token: this.auth.csrf(req.sessionHash) };
  }
  @Public() @Post('auth/register')
  async register(@Body() input: Credentials, @Req() req: AuthRequest) {
    await this.auth.rate(`register:${req.ip}`, 5, 3600);
    const enabled = await this.auth.infrastructure.db.setting.findUnique({ where: { key: 'registration' } });
    if (enabled?.value !== true) throw new ForbiddenException({ code: 'REGISTRATION_CLOSED', message: 'Registration is disabled' });
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.auth.infrastructure.db.user.create({ data: { email: input.email.trim().toLowerCase(), passwordHash }, select: publicUserSelect });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new HttpException({ code: 'EMAIL_UNAVAILABLE', message: 'Email cannot be registered' }, 409);
      throw error;
    }
  }
  @Public() @Post('auth/login')
  async login(@Body() input: Credentials, @Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.rate(`login:${req.ip}`, 15, 900);
    await this.auth.rate(`login-email:${digest(input.email.toLowerCase())}`, 10, 900);
    return this.auth.login(input.email, input.password, res);
  }
  @Post('auth/logout')
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.infrastructure.db.session.deleteMany({ where: { tokenHash: req.sessionHash } });
    res.clearCookie(this.auth.cookieName, { path: '/', httpOnly: true, secure: this.auth.secure, sameSite: 'lax' });
    return { ok: true };
  }
  @Get('auth/me') me(@Req() req: AuthRequest) { return req.viewer; }
  @Patch('me')
  async profile(@Body() input: ProfileUpdate, @Req() req: AuthRequest) {
    if (input.timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); }
      catch { throw new HttpException({ code: 'INVALID_TIMEZONE', message: 'Invalid timezone' }, 400); }
    }
    return this.auth.infrastructure.db.user.update({ where: { id: req.viewer!.id }, data: input, select: publicUserSelect });
  }
  @Post('me/password')
  async password(@Body() input: PasswordUpdate, @Req() req: AuthRequest) {
    const user = await this.auth.infrastructure.db.user.findUniqueOrThrow({ where: { id: req.viewer!.id } });
    if (!await argon2.verify(user.passwordHash, input.currentPassword)) throw new UnauthorizedException();
    const passwordHash = await argon2.hash(input.newPassword, passwordOptions);
    await this.auth.infrastructure.db.$transaction([
      this.auth.infrastructure.db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.auth.infrastructure.db.session.deleteMany({ where: { userId: user.id } }),
    ]);
    return { ok: true };
  }
}
