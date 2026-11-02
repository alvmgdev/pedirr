import { BadGatewayException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConnectionResult, ContentManager, EventInput, LeagueInput, ManagerConfig, ManagerEvent, ManagerLeague, QueueItem } from './client';

export function managerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException({ code: 'INVALID_MANAGER_URL', message: 'Enter an absolute HTTP or HTTPS URL' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BadRequestException({ code: 'INVALID_MANAGER_URL', message: 'URL must not contain credentials, query parameters or a fragment' });
  return url.href.replace(/\/+$/, '');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid manager identifier');
  return Number(value);
}
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Invalid text'); return value; }
function league(value: unknown): ManagerLeague {
  const row = object(value);
  if (typeof row.monitored !== 'boolean' || (row.externalId !== null && typeof row.externalId !== 'string')) throw new Error('Invalid league');
  return { ...row, id: positiveId(row.id), externalId: row.externalId, name: text(row.name), sport: text(row.sport), monitored: row.monitored };
}
function event(value: unknown): ManagerEvent {
  const row = object(value);
  if (typeof row.hasFile !== 'boolean' || typeof row.monitored !== 'boolean' || !Array.isArray(row.files) || (row.externalId !== null && typeof row.externalId !== 'string')) throw new Error('Invalid event');
  return { ...row, id: positiveId(row.id), externalId: row.externalId, title: text(row.title), hasFile: row.hasFile, monitored: row.monitored, files: row.files.map(object) };
}
function array<T>(value: unknown, parse: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid array');
  return value.map(parse);
}
export class SportarrClient extends ContentManager {
  private readonly base: string;
  constructor(private readonly config: Pick<ManagerConfig, 'url' | 'apiKey'>) { super(); this.base = managerUrl(config.url); }
  private invalid() { return new BadGatewayException({ code: 'SPORTARR_INVALID_RESPONSE', message: 'Sportarr returned an unexpected response' }); }
  async read<T>(path: string, parse: (value: unknown) => T, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/api/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'X-Api-Key': this.config.apiKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new ServiceUnavailableException({ code: 'SPORTARR_UNREACHABLE', message: 'Could not connect to Sportarr' }); }
    if (!response.ok) throw new BadGatewayException({ code: response.status === 401 || response.status === 403 ? 'SPORTARR_AUTH_FAILED' : 'SPORTARR_HTTP_ERROR', message: 'Sportarr rejected the request', upstreamStatus: response.status });
    try { return parse(await response.json()); }
    catch { throw this.invalid(); }
  }
  async assertWriteCompatibility() {
    const version = await this.read('system/status', value => {
      const data = object(value);
      if (data.appName !== 'Sportarr') throw new Error('Unexpected application');
      return text(data.version);
    });
    // Native write behavior was inspected at Sportarr 4.1.11. Recheck new minor versions.
    const match = /^4\.1\.(\d+)(?:[.-]|$)/.exec(version);
    if (!match || Number(match[1]) < 11) throw new BadGatewayException({ code: 'SPORTARR_UNSUPPORTED_VERSION', message: 'Native writes require Sportarr 4.1.11 or a later 4.1 patch release' });
  }
  async ensureLeague(input: LeagueInput): Promise<ManagerLeague> {
    if (!/^lg-\d+$/.test(input.externalId)) throw new BadRequestException({ code: 'MISSING_MANAGER_ID', message: 'League requires a Hub short identifier' });
    const find = (items: ManagerLeague[]) => {
      const matches = items.filter(item => item.externalId === input.externalId);
      if (matches.length > 1) throw this.invalid();
      return matches[0];
    };
    const existing = find(await this.leagues());
    if (existing) return existing;
    try {
      // Create an inert container; individual requested events control monitoring.
      await this.read('leagues', value => value, 'POST', { ...input, monitored: false, monitorType: 'None', monitoredTeamIds: [] });
    } catch (error) {
      // Sportarr may commit a league before reporting a later initialization error.
      const recovered = find(await this.leagues());
      if (recovered) return recovered;
      throw error;
    }
    const created = find(await this.leagues());
    if (!created) throw this.invalid();
    return created;
  }
  async ensureEvent(input: EventInput, existing: ManagerEvent[]): Promise<ManagerEvent> {
    if (!/^ev-\d+$/.test(input.externalId) || !Number.isFinite(Date.parse(input.eventDate))) throw new BadRequestException({ code: 'INVALID_EVENT_METADATA', message: 'Event requires a Hub short identifier and scheduled date' });
    const matches = existing.filter(item => item.externalId === input.externalId);
    if (matches.length > 1) throw this.invalid();
    let current = matches[0];
    if (!current) {
      try {
        const id = await this.read('events', value => {
          const response = object(value);
          return positiveId(response.event ? object(response.event).id : response.id);
        }, 'POST', { ...input, monitored: true, searchOnAdd: false });
        current = await this.event(id);
      } catch (error) {
        // Ambiguous timeout/response: read the library before any retry can write again.
        const recovered = (await this.events(input.leagueId)).filter(item => item.externalId === input.externalId);
        if (recovered.length !== 1) throw error;
        current = recovered[0];
      }
    }
    // Sportarr also deduplicates by title/date. Never adopt that match without identity proof.
    if (current.externalId !== input.externalId || current.leagueId !== input.leagueId) throw new BadGatewayException({ code: 'SPORTARR_IDENTITY_CONFLICT', message: 'Sportarr returned a different event identity or league' });
    if (!current.hasFile && !current.monitored) {
      await this.read(`events/${current.id}`, value => value, 'PUT', { monitored: true });
      current = await this.event(current.id);
    }
    return current;
  }
  async search(id: number): Promise<void> {
    await this.read(`event/${positiveId(id)}/automatic-search`, value => value, 'POST', {});
  }
  queue(): Promise<QueueItem[]> {
    return this.read('queue', value => array(value, row => {
      const data = object(row);
      const statuses = ['Queued', 'Downloading', 'Paused', 'Completed', 'Failed', 'Warning', 'Importing', 'Imported', 'ImportPending', 'ImportWarning'];
      const status = typeof data.status === 'number' ? statuses[data.status] : data.status;
      if (typeof status !== 'string' || !statuses.includes(status) || typeof data.progress !== 'number' || !Number.isFinite(data.progress)) throw new Error('Invalid queue');
      return { eventId: positiveId(data.eventId), status, progress: data.progress };
    }));
  }
  leagues() { return this.read('leagues', value => array(value, league)); }
  event(id: number) { return this.read(`events/${positiveId(id)}`, event); }
  async events(leagueId: number) {
    const records: ManagerEvent[] = [];
    const seen = new Set<number>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 10000; page++) {
      const result = await this.read(`leagues/${positiveId(leagueId)}/events?showAll=true&page=${page}&pageSize=200`, value => {
        const data = object(value);
        if (data.page !== page || !Number.isSafeInteger(data.totalPages) || Number(data.totalPages) < 0 || !Number.isSafeInteger(data.totalRecords) || Number(data.totalRecords) < 0) throw new Error('Invalid pagination');
        return { records: array(data.records, event), totalPages: Number(data.totalPages), totalRecords: Number(data.totalRecords) };
      });
      expectedTotal ??= result.totalRecords;
      if (expectedTotal !== result.totalRecords) throw this.invalid();
      for (const record of result.records) {
        if (seen.has(record.id)) throw this.invalid();
        seen.add(record.id); records.push(record);
      }
      if (page >= result.totalPages) {
        if (records.length !== expectedTotal) throw this.invalid();
        return records;
      }
      if (result.records.length === 0) throw this.invalid();
    }
    throw this.invalid();
  }
  async testConnection(): Promise<ConnectionResult> {
    const status = await this.read('system/status', value => {
      const data = object(value);
      if (data.appName !== 'Sportarr') throw new Error('Unexpected application');
      return { appName: data.appName, version: text(data.version) };
    });
    const leagues = await this.leagues();
    const rootFolders = await this.read('rootfolder', value => array(value, row => { const data = object(row); return { id: positiveId(data.id), path: text(data.path) }; }));
    const qualityProfiles = await this.read('qualityprofile', value => array(value, row => { const data = object(row); return { id: positiveId(data.id), name: text(data.name) }; }));
    return { ...status, leagues: leagues.length, rootFolders, qualityProfiles };
  }
}
