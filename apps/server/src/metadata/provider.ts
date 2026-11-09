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
  abstract leagues(page: number): Promise<MetadataPage>;
  abstract league(id: string): Promise<MetadataItem>;
  abstract seasons(league: string, page: number): Promise<MetadataPage>;
  abstract season(id: string): Promise<MetadataItem>;
  abstract team(id: string): Promise<MetadataItem>;
  abstract events(filters: EventFilters): Promise<MetadataPage>;
  abstract event(id: string): Promise<MetadataItem>;
}
