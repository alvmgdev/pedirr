export type ManagerConfig = {
  url: string;
  apiKey: string;
  rootFolderId: number;
  qualityProfileId: number;
};
export type ManagerLeague = {
  id: number;
  externalId: string | null;
  name: string;
  sport: string;
  monitored: boolean;
  [key: string]: unknown;
};
export type ManagerEvent = {
  id: number;
  externalId: string | null;
  title: string;
  hasFile: boolean;
  monitored: boolean;
  files: Record<string, unknown>[];
  [key: string]: unknown;
};
export type ConnectionResult = {
  appName: string;
  version: string;
  leagues: number;
  rootFolders: { id: number; path: string }[];
  qualityProfiles: { id: number; name: string }[];
};
export abstract class ContentManager {
  abstract assertWriteCompatibility(): Promise<void>;
  abstract ensureLeague(input: LeagueInput): Promise<ManagerLeague>;
  abstract ensureEvent(input: EventInput, existing: ManagerEvent[]): Promise<ManagerEvent>;
  /** Automatic search; with a part name, Sportarr searches only that event part. */
  abstract search(id: number, part?: string): Promise<void>;
  /** Parts Sportarr defines for an event (number 0 is the full event). */
  abstract parts(id: number): Promise<ManagerPart[]>;
  /** Part definitions of a sport, for events Sportarr does not hold yet. */
  abstract sportParts(sport: string): Promise<ManagerPart[]>;
  /** Whether Sportarr splits fighting events into parts at all. */
  abstract multiPartEnabled(): Promise<boolean>;
  /** Replaces an event's monitored parts with comma-separated part names. */
  abstract setMonitoredParts(id: number, parts: string): Promise<ManagerEvent>;
  abstract queue(): Promise<QueueItem[]>;
  abstract testConnection(): Promise<ConnectionResult>;
  abstract leagues(): Promise<ManagerLeague[]>;
  abstract events(leagueId: number): Promise<ManagerEvent[]>;
  abstract event(id: number): Promise<ManagerEvent>;
}

export type LeagueInput = {
  externalId: string;
  name: string;
  sport: string;
  rootFolderId: number;
  qualityProfileId: number;
};
export type EventInput = {
  externalId: string;
  title: string;
  sport: string;
  leagueId: number;
  eventDate: string;
  season: string | null;
  seasonNumber: number | null;
  qualityProfileId: number;
};
export type QueueItem = { eventId: number; status: string; progress: number; part: string | null };
export type ManagerPart = { name: string; number: number };
