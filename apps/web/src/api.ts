import { QueryClient } from "@tanstack/react-query";
export const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000,
      retry: (attempt, error) => error instanceof ApiError && error.code === "METADATA_BUSY" && attempt < 2,
      retryDelay: (_attempt, error) => error instanceof ApiError ? Math.max(1000, (error.retryAfterSeconds ?? 10) * 1000) : 1000,
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
    if (method === "GET" || !(error instanceof ApiError) || error.code !== "CSRF_INVALID") throw error;
    resetCsrfToken();
    return send<T>(path, method, body);
  } finally {
    if (sessionChangingPaths.includes(path)) resetCsrfToken();
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
    if (
      response.status === 401 &&
      path !== "/auth/login" &&
      path !== "/auth/me"
    )
      window.dispatchEvent(new Event("pedirr:session-expired"));
    throw new ApiError(
      response.status,
      error.code ?? (response.status === 400 ? "INVALID_INPUT" : "UNKNOWN"),
      error.retryAfterSeconds,
      error.reason,
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
};
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
  }[];
};

export function setSession(user: User | null) {
  resetCsrfToken();
  void client.cancelQueries();
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
  client.setQueryData(["me"], user);
}
