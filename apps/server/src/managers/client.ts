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
  /**
   * Monitors an event Sportarr already imported from the Hub. Returns undefined when Sportarr
   * does not hold it yet: events are never created by hand, because a hand-made event lacks the
   * team names and local air date Sportarr needs to tell releases of other games apart.
   */
  abstract monitorEvent(
    externalId: string,
    leagueId: number,
    existing: ManagerEvent[],
  ): Promise<ManagerEvent | undefined>;
  /** Asks Sportarr to import a league's events from the Hub. Queued and rate limited upstream. */
  abstract refreshEvents(leagueId: number, seasons: string[]): Promise<void>;
  /** Automatic search; with a part name, Sportarr searches only that event part. */
  abstract search(id: number, part?: string): Promise<void>;
  /** Parts Sportarr defines for an event (number 0 is the full event). */
  abstract parts(id: number): Promise<ManagerPart[]>;
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
export type QueueItem = { eventId: number; status: string; progress: number; part: string | null };
export type ManagerPart = { name: string; number: number };
