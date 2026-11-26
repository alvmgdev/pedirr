export interface MetadataItem {
  id: string;
  name: string;
  shortId?: string | null;
  tsdbId?: string | null;
  leagueId?: string | null;
  seasonId?: string | null;
  scheduledStart?: string | null;
  [field: string]: unknown;
}
export interface MetadataPage {
  items: MetadataItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export interface MetadataSearch {
  query: string;
  total: number;
  results: (MetadataItem & { entityType: "league" | "team" | "event" })[];
}
/**
 * Search results that carry their league, from Hub's TheSportsDB-compatible search: events with
 * the league's short ID, teams with the league's name. Used to search the whole catalog for
 * users on a plan, since Hub's main search does not say which league a result belongs to.
 */
export type LeagueSearch = {
  events: (MetadataItem & { leagueShortId: string | null })[];
  teams: MetadataItem[];
};
export type EventFilters = {
  league?: string;
  season?: string;
  team?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize?: number;
  order?: "asc" | "desc";
};
export abstract class MetadataProvider {
  abstract search(query: string): Promise<MetadataSearch>;
  abstract searchWithLeagues(query: string): Promise<LeagueSearch>;
  /** Every sport Hub knows (a few dozen), for choosing what a plan includes. */
  abstract sports(): Promise<MetadataPage>;
  abstract leagues(page: number, pageSize?: number): Promise<MetadataPage>;
  abstract league(id: string): Promise<MetadataItem>;
  abstract seasons(league: string, page: number): Promise<MetadataPage>;
  abstract season(id: string): Promise<MetadataItem>;
  abstract team(id: string): Promise<MetadataItem>;
  abstract events(filters: EventFilters): Promise<MetadataPage>;
  abstract event(id: string): Promise<MetadataItem>;
}
