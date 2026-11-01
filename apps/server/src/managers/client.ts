export type ManagerConfig = { url: string; apiKey: string; rootFolderId: number; qualityProfileId: number };
export type ManagerLeague = { id: number; externalId: string | null; name: string; sport: string; monitored: boolean; [key: string]: unknown };
export type ManagerEvent = { id: number; externalId: string | null; title: string; hasFile: boolean; monitored: boolean; files: Record<string, unknown>[]; [key: string]: unknown };
export type ConnectionResult = { appName: string; version: string; leagues: number; rootFolders: { id: number; path: string }[]; qualityProfiles: { id: number; name: string }[] };
export abstract class ContentManager {
  abstract testConnection(): Promise<ConnectionResult>;
  abstract leagues(): Promise<ManagerLeague[]>;
  abstract events(leagueId: number): Promise<ManagerEvent[]>;
  abstract event(id: number): Promise<ManagerEvent>;
}
