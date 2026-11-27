import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Injectable,
  Patch,
  Post,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, ValidateIf, IsString, MaxLength, MinLength } from "class-validator";
import { PASSWORD_MIN_LENGTH } from "./passwords";
export { PASSWORD_MIN_LENGTH };
import { Request, Response } from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as argon2 from "argon2";
import { Infrastructure } from "./infrastructure";
import { required } from "./config";
import { isExpired } from "./requests/quota";
import { EnvironmentRequest, PLATFORM_TENANT } from "./tenants";

export const Public = () => SetMetadata("public", true);
export const Admin = () => SetMetadata("admin", true);
/** Routes for a reseller's administrator, always scoped to that reseller. */
export const ResellerAdmin = () => SetMetadata("reseller", true);
export const publicUserSelect = {
  id: true,
  email: true,
  role: true,
  active: true,
  locale: true,
  timezone: true,
  autoApprove: true,
  weeklyRequestLimit: true,
  expiresAt: true,
  plan: { select: { id: true, name: true, allContent: true } },
  tenantId: true,
  tenant: { select: { code: true, name: true } },
} as const;
export type Viewer = {
  id: string;
  email: string;
  role: "ADMIN" | "RESELLER" | "USER";
  active: boolean;
  locale: string;
  timezone: string;
  autoApprove: boolean | null;
  weeklyRequestLimit: number | null;
  expiresAt: Date | null;
  plan: { id: string; name: string; allContent: boolean } | null;
  tenantId: string;
  tenant: { code: string | null; name: string };
};
/** The environment a request addresses: the platform, or a reseller by its code. */
export type Environment = { id: string; code: string | null; name: string; active: boolean };
/** The platform needs no lookup: it always exists, is always active and has no code. */
const PLATFORM: Environment = { id: PLATFORM_TENANT, code: null, name: "Pedirr", active: true };
/**
 * Whole seasons can grow into hundreds of downloads, so only administrators request them; users
 * request single events.
 */
export const mayRequestSeasons = (user: Pick<Viewer, "role">) =>
  user.role === "ADMIN" || user.role === "RESELLER";
export type AuthRequest = Request &
  EnvironmentRequest & { viewer?: Viewer; sessionHash?: string; tenant?: Environment };
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export class Credentials {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: 128 })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(128)
  password!: string;
}
export class ProfileUpdate {
  @ApiProperty({ enum: ["en", "es"], required: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(["en", "es"])
  locale?: string;
  @ApiProperty({ required: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  timezone?: string;
}
export class PasswordUpdate {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(128)
  newPassword!: string;
}

@Injectable()
export class AuthService {
  private readonly secret = required("SESSION_SECRET");
  readonly origin = new URL(required("APP_ORIGIN")).origin;
  readonly secure = this.origin.startsWith("https:");
  /** The platform's session cookie, for the whole site. */
  readonly cookieName = this.secure ? "__Host-pedirr_session" : "pedirr_session";
  // A reseller's session cookie only travels under /<code>/, so environments never share one
  // and a browser can be signed in to several at once.
  private readonly resellerCookieName = this.secure
    ? "__Secure-pedirr_reseller_session"
    : "pedirr_reseller_session";
  constructor(readonly infrastructure: Infrastructure) {
    if (this.secret.length < 32) {
      throw new Error("SESSION_SECRET must contain at least 32 characters");
    }
  }
  cookie(tenant: Environment = PLATFORM) {
    return tenant.code
      ? { name: this.resellerCookieName, path: `/${tenant.code}/` }
      : { name: this.cookieName, path: "/" };
  }
  /** The platform without a code; a reseller by its code, or null when no reseller has it. */
  async environment(code?: string): Promise<Environment | null> {
    if (!code) {
      return PLATFORM;
    }
    return this.infrastructure.db.tenant.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, active: true },
    });
  }
  csrf(sessionHash = "") {
    const nonce = randomBytes(24).toString("hex");
    return `${nonce}.${this.sign(nonce, sessionHash)}`;
  }
  private sign(nonce: string, sessionHash: string) {
    return createHmac("sha256", this.secret).update(`${nonce}:${sessionHash}`).digest("hex");
  }
  verifyCsrf(token: unknown, sessionHash = "") {
    if (typeof token !== "string" || !/^[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token)) {
      return false;
    }
    const [nonce, signature] = token.split(".");
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(this.sign(nonce, sessionHash), "hex"),
    );
  }
  // Registration stays closed until an administrator enables it in the access policy.
  async registrationEnabled(): Promise<boolean> {
    const setting = await this.infrastructure.db.setting.findUnique({
      where: { key: "registration" },
    });
    return setting?.value === true;
  }
  async rate(key: string, limit: number, seconds: number) {
    const value = await this.infrastructure.redis.eval(
      `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`,
      1,
      `pedirr:rate:${key}`,
      seconds,
    );
    if (Number(value) > limit) {
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
        429,
      );
    }
  }
  async resolve(req: AuthRequest) {
    const tenant = req.tenant ?? PLATFORM;
    const token: unknown = req.cookies?.[this.cookie(tenant).name];
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      return;
    }
    const sessionHash = digest(token);
    const session = await this.infrastructure.db.session.findUnique({
      where: { tokenHash: sessionHash },
      include: { user: { select: publicUserSelect } },
    });
    if (
      !session ||
      session.expiresAt < new Date() ||
      !session.user.active ||
      isExpired(session.user) ||
      // A session only works in its account's environment, and not while a reseller is disabled.
      session.user.tenantId !== tenant.id ||
      !tenant.active
    ) {
      return;
    }
    req.viewer = session.user;
    req.sessionHash = sessionHash;
  }
  async login(email: string, password: string, res: Response, tenant: Environment = PLATFORM) {
    if (!tenant.active) {
      throw new ForbiddenException({
        code: "TENANT_DISABLED",
        message: "This service is not available",
      });
    }
    const user = await this.infrastructure.db.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: email.trim().toLowerCase() } },
    });
    // Keep unknown-account and wrong-password responses identical.
    const valid = user
      ? await argon2.verify(user.passwordHash, password)
      : await argon2.verify(await this.dummyHash, password);
    if (!valid || !user?.active) {
      throw new UnauthorizedException({
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      });
    }
    // Only someone who knows the password learns that the account expired.
    if (isExpired(user)) {
      throw new ForbiddenException({
        code: "ACCOUNT_EXPIRED",
        message: "This account has expired. Contact an administrator.",
      });
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    await this.infrastructure.db.session.create({
      data: { tokenHash: digest(token), userId: user.id, expiresAt },
    });
    const cookie = this.cookie(tenant);
    res.cookie(cookie.name, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      path: cookie.path,
      expires: expiresAt,
    });
    return this.infrastructure.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: publicUserSelect,
    });
  }
  private readonly dummyHash = argon2.hash(randomBytes(32), passwordOptions);
}

@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const tenant = await this.auth.environment(req.environment);
    if (!tenant) {
      throw new NotFoundException({
        code: "TENANT_NOT_FOUND",
        message: "This address does not belong to any service",
      });
    }
    req.tenant = tenant;
    await this.auth.resolve(req);
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>("public", targets);
    if (!isPublic && !req.viewer) {
      throw new UnauthorizedException();
    }
    if (
      this.reflector.getAllAndOverride<boolean>("admin", targets) &&
      req.viewer?.role !== "ADMIN"
    ) {
      throw new ForbiddenException();
    }
    if (
      this.reflector.getAllAndOverride<boolean>("reseller", targets) &&
      req.viewer?.role !== "RESELLER"
    ) {
      throw new ForbiddenException();
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.headers.origin !== this.auth.origin ||
        !this.auth.verifyCsrf(req.headers["x-csrf-token"], req.sessionHash)
      ) {
        throw new ForbiddenException({
          code: "CSRF_INVALID",
          message: "Refresh the page and try again",
        });
      }
      await this.auth.rate(`write:${req.viewer?.id ?? req.ip}`, 120, 60);
    }
    return true;
  }
}

@ApiTags("Authentication")
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Get("auth/csrf")
  csrf(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    return { token: this.auth.csrf(req.sessionHash) };
  }
  @Public()
  @Get("auth/config")
  async config(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    const tenant = req.tenant!;
    // Resellers create their clients' accounts; self-registration is the platform's for now.
    return tenant.code
      ? {
          registrationEnabled: false,
          environment: { code: tenant.code, name: tenant.name, active: tenant.active },
        }
      : { registrationEnabled: await this.auth.registrationEnabled(), environment: null };
  }
  @Public()
  @Post("auth/register")
  async register(@Body() input: Credentials, @Req() req: AuthRequest) {
    await this.auth.rate(`register:${req.ip}`, 5, 3600);
    if (req.tenant!.code || !(await this.auth.registrationEnabled())) {
      throw new ForbiddenException({
        code: "REGISTRATION_CLOSED",
        message: "Registration is disabled",
      });
    }
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.auth.infrastructure.db.user.create({
        data: { email: input.email.trim().toLowerCase(), passwordHash },
        select: publicUserSelect,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new HttpException(
          { code: "EMAIL_UNAVAILABLE", message: "Email cannot be registered" },
          409,
        );
      }
      throw error;
    }
  }
  @Public()
  @Post("auth/login")
  async login(
    @Body() input: Credentials,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.rate(`login:${req.ip}`, 15, 900);
    const tenant = req.tenant!;
    await this.auth.rate(`login-email:${tenant.id}:${digest(input.email.toLowerCase())}`, 10, 900);
    return this.auth.login(input.email, input.password, res, tenant);
  }
  @Post("auth/logout")
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.infrastructure.db.session.deleteMany({ where: { tokenHash: req.sessionHash } });
    const cookie = this.auth.cookie(req.tenant);
    res.clearCookie(cookie.name, {
      path: cookie.path,
      httpOnly: true,
      secure: this.auth.secure,
      sameSite: "lax",
    });
    return { ok: true };
  }
  @Get("auth/me") me(@Req() req: AuthRequest) {
    return req.viewer;
  }
  @Patch("me")
  async profile(@Body() input: ProfileUpdate, @Req() req: AuthRequest) {
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      } catch {
        throw new HttpException({ code: "INVALID_TIMEZONE", message: "Invalid timezone" }, 400);
      }
    }
    return this.auth.infrastructure.db.user.update({
      where: { id: req.viewer!.id },
      data: input,
      select: publicUserSelect,
    });
  }
  @Post("me/password")
  async password(@Body() input: PasswordUpdate, @Req() req: AuthRequest) {
    const user = await this.auth.infrastructure.db.user.findUniqueOrThrow({
      where: { id: req.viewer!.id },
    });
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException();
    }
    const passwordHash = await argon2.hash(input.newPassword, passwordOptions);
    await this.auth.infrastructure.db.$transaction([
      this.auth.infrastructure.db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.auth.infrastructure.db.session.deleteMany({ where: { userId: user.id } }),
    ]);
    return { ok: true };
  }
}
