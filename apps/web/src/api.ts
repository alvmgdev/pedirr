import { QueryClient } from "@tanstack/react-query";
export const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000,
      retry: (attempt, error) =>
        error instanceof ApiError && error.code === "METADATA_BUSY" && attempt < 2,
      retryDelay: (_attempt, error) =>
        error instanceof ApiError ? Math.max(1000, (error.retryAfterSeconds ?? 10) * 1000) : 1000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfterSeconds?: number,
    public reason?: string,
    /** The existing issue when the same problem was already reported. */
    public issueId?: string,
  ) {
    super(code);
  }
}
// CSRF tokens are bound to the current session, so one token serves every write
// until the session changes (login, logout, password change or expiry).
let csrfToken: Promise<string> | null = null;
const sessionChangingPaths = ["/auth/login", "/auth/logout", "/auth/register", "/me/password"];

export function resetCsrfToken() {
  csrfToken = null;
}

function currentCsrfToken(): Promise<string> {
  csrfToken ??= api<{ token: string }>("/auth/csrf").then(
    (result) => result.token,
    (error: unknown) => {
      csrfToken = null;
      throw error;
    },
  );
  return csrfToken;
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  try {
    return await send<T>(path, method, body);
  } catch (error) {
    // A cached token goes stale when the server revokes the session; refresh it once.
    if (method === "GET" || !(error instanceof ApiError) || error.code !== "CSRF_INVALID") {
      throw error;
    }
    resetCsrfToken();
    return send<T>(path, method, body);
  } finally {
    if (sessionChangingPaths.includes(path)) {
      resetCsrfToken();
    }
  }
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["x-csrf-token"] = await currentCsrfToken();
    headers["content-type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "CONNECTION_FAILED");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/auth/login" && path !== "/auth/me") {
      window.dispatchEvent(new Event("pedirr:session-expired"));
    }
    throw new ApiError(
      response.status,
      error.code ?? (response.status === 400 ? "INVALID_INPUT" : "UNKNOWN"),
      error.retryAfterSeconds,
      error.reason,
      typeof error.issueId === "string" ? error.issueId : undefined,
    );
  }
  return response.json();
}
export type User = {
  id: string;
  email: string;
  role: "ADMIN" | "USER";
  active: boolean;
  locale: string;
  timezone: string;
  autoApprove: boolean | null;
  canRequestSeasons: boolean;
};
/** Administrators may always request whole seasons; other users need the grant. */
export const mayRequestSeasons = (user: Pick<User, "role" | "canRequestSeasons">) =>
  user.role === "ADMIN" || user.canRequestSeasons;
export type Item = {
  id: string;
  name: string;
  shortId?: string;
  entityType?: "league" | "team" | "event";
  leagueId?: string;
  leagueName?: string;
  seasonId?: string;
  seasonName?: string;
  sportName?: string;
  country?: string;
  scheduledStart?: string;
  logoUrl?: string;
  imageUrl?: string;
  posterUrl?: string;
  thumbUrl?: string;
  description?: string;
  status?: string;
  isCurrent?: boolean;
};
export type Page = {
  items: Item[];
  page: number;
  totalPages?: number;
  hasMore?: boolean;
  nextPage?: number | null;
};
export type RequestRecord = {
  id: string;
  status: string;
  version: number;
  createdAt: string;
  rejectionReason?: string;
  integrationState: string;
  lastError?: string;
  entity: { title: string };
  scope: {
    kind: "event" | "season";
    season?: Item;
    event?: Item;
    league: Item;
  };
  _count: { subscribers: number };
  /** Requested parts; empty when the whole event was requested. */
  parts: { name: string; status: string; rejectionReason: string | null }[];
  /** The viewer's own parts and status when they follow the request. */
  subscription: { parts: string[]; status: string } | null;
  /** Administrators only: who follows the request, with their parts and status. */
  subscribers?: { email: string; parts: string[]; status: string; createdAt: string }[] | null;
  history?: {
    id: string;
    action: string;
    createdAt: string;
    details: { status?: string; reason?: string };
  }[];
  events?: {
    id: string;
    metadata: Item;
    available: boolean;
    progress: number;
    parts: string[];
    availableParts: string[];
    downloadingParts: string[];
  }[];
};
export type PartOption = {
  name: string;
  optional: boolean;
  selected: boolean;
  state: "none" | "requested" | "downloading" | "available";
};
export type PartOptions = { supported: boolean; parts: PartOption[] };
export const ISSUE_CATEGORIES = [
  "WRONG_CONTENT",
  "MISSING_CONTENT",
  "QUALITY",
  "LANGUAGE",
  "PLAYBACK",
  "OTHER",
] as const;
export type Issue = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  category: (typeof ISSUE_CATEGORIES)[number];
  part: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  mine: boolean;
  /** Administrators only. */
  reporter: { id: string; email: string } | null;
  request: { id: string; title: string; kind: "event" | "season"; season: string | null };
  event: { id: string; name: string | null } | null;
  comments: number;
};
export type IssueDetail = Issue & {
  timeline: {
    id: string;
    body: string | null;
    status: Issue["status"] | null;
    createdAt: string;
    author: { role: "ADMIN" | "USER"; mine: boolean; email: string | null } | null;
  }[];
};

export function setSession(user: User | null) {
  resetCsrfToken();
  void client.cancelQueries();
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
  client.setQueryData(["me"], user);
}
