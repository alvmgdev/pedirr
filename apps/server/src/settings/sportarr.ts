import { BadRequestException, Body, Controller, Get, Injectable, Post, Put, ServiceUnavailableException } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Admin } from '../auth';
import { Infrastructure } from '../infrastructure';
import { ManagerConfig } from '../managers/client';
import { managerUrl, SportarrClient } from '../managers/sportarr';
import { SecretBox } from './secrets';

export class ConnectionInput {
  @ApiProperty() @IsString() @MaxLength(2048) url!: string;
  @ApiProperty({ required: false, writeOnly: true, description: 'Omit to retain the saved key for the same URL.' })
  @ValidateIf((_, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(512) apiKey?: string;
}
export class SportarrSettingsInput extends ConnectionInput {
  @ApiProperty() @IsInt() @Min(1) @Max(2147483647) rootFolderId!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(2147483647) qualityProfileId!: number;
}
type StoredConfig = Omit<ManagerConfig, 'apiKey'> & { encryptedApiKey: string };
@Injectable()
export class SportarrSettings {
  private readonly secrets = new SecretBox();
  constructor(private readonly infrastructure: Infrastructure) {}
  private async stored(): Promise<StoredConfig | null> {
    const row = await this.infrastructure.db.setting.findUnique({ where: { key: 'sportarr' } });
    return row ? row.value as unknown as StoredConfig : null;
  }
  async publicSettings() {
    const config = await this.stored();
    return config ? { configured: true, url: config.url, hasApiKey: true, rootFolderId: config.rootFolderId, qualityProfileId: config.qualityProfileId } : { configured: false, url: '', hasApiKey: false, rootFolderId: null, qualityProfileId: null };
  }
  private unlock(config: StoredConfig) {
    try { return this.secrets.decrypt(config.encryptedApiKey, 'sportarr.apiKey'); }
    catch { throw new ServiceUnavailableException({ code: 'SETTINGS_DECRYPTION_FAILED', message: 'Check the settings encryption key or save new credentials' }); }
  }
  async credentials(input: ConnectionInput): Promise<Pick<ManagerConfig, 'url' | 'apiKey'>> {
    const url = managerUrl(input.url);
    const saved = await this.stored();
    const apiKey = input.apiKey ?? (saved?.url === url ? this.unlock(saved) : undefined);
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new BadRequestException({ code: 'API_KEY_REQUIRED', message: 'Provide an API key for this Sportarr URL' });
    return { url, apiKey };
  }
  async configuration(): Promise<ManagerConfig> {
    const config = await this.stored();
    if (!config) throw new ServiceUnavailableException({ code: 'SPORTARR_NOT_CONFIGURED', message: 'Configure Sportarr before processing requests' });
    return { url: config.url, rootFolderId: config.rootFolderId, qualityProfileId: config.qualityProfileId, apiKey: this.unlock(config) };
  }
  async test(input: ConnectionInput) { return new SportarrClient(await this.credentials(input)).testConnection(); }
  async save(input: SportarrSettingsInput) {
    const credentials = await this.credentials(input);
    const connection = await new SportarrClient(credentials).testConnection();
    if (!connection.rootFolders.some(root => root.id === input.rootFolderId) || !connection.qualityProfiles.some(profile => profile.id === input.qualityProfileId)) throw new BadRequestException({ code: 'INVALID_MANAGER_DEFAULTS', message: 'Select an existing root folder and quality profile' });
    const value = { url: credentials.url, rootFolderId: input.rootFolderId, qualityProfileId: input.qualityProfileId, encryptedApiKey: this.secrets.encrypt(credentials.apiKey, 'sportarr.apiKey') };
    await this.infrastructure.db.setting.upsert({ where: { key: 'sportarr' }, create: { key: 'sportarr', value }, update: { value } });
    return this.publicSettings();
  }
}
@Admin() @ApiTags('Settings') @Controller('admin/settings/sportarr')
export class SportarrSettingsController {
  constructor(private readonly settings: SportarrSettings) {}
  @Get() get() { return this.settings.publicSettings(); }
  @Post('test') test(@Body() input: ConnectionInput) { return this.settings.test(input); }
  @Put() save(@Body() input: SportarrSettingsInput) { return this.settings.save(input); }
}
