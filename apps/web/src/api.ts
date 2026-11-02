import { QueryClient } from "@tanstack/react-query";
export const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60000, retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    const token = await api<{ token: string }>("/auth/csrf");
    headers["x-csrf-token"] = token.token;
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
  void client.cancelQueries();
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
  client.setQueryData(["me"], user);
}
