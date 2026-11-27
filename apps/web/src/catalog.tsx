import { useState } from "react";
import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  api,
  client,
  mayRequestSeasons,
  type Item,
  type Page,
  type PartOptions,
  type User,
} from "./api";
import {
  Artwork,
  Breadcrumbs,
  ErrorMessage,
  Fixture,
  Loading,
  Pager,
  PartsDialog,
  QuotaNote,
  Status,
  timezoneOf,
  useQuota,
} from "./ui";
export function Discover({ user }: { user: User }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const mode = params.get("view") ?? "upcoming";
  const page = Number(params.get("page") ?? 1) || 1;
  const [text, setText] = useState(query);
  const path = query
    ? `/catalog/search?q=${encodeURIComponent(query)}`
    : `/catalog/${mode === "leagues" ? "leagues" : "upcoming"}?page=${page}`;
  const schedule = !query && mode !== "leagues";
  const catalog = useQuery({
    enabled: !schedule,
    queryKey: ["catalog", path],
    queryFn: () => api<Page & { results?: Item[] }>(path),
  });
  const upcoming = useInfiniteQuery({
    queryKey: ["upcoming"],
    enabled: schedule,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<Page>(`/catalog/upcoming?page=${pageParam}`),
    getNextPageParam: (last) => (last.hasMore ? (last.nextPage ?? last.page + 1) : undefined),
  });
  const result = schedule ? upcoming : catalog;
  const popular = useQuery({
    queryKey: ["popular"],
    queryFn: () => api<{ items: { id: string; metadata: Item }[] }>("/catalog/popular"),
  });
  const category = params.get("type") ?? "";
  const results = schedule
    ? [
        ...new Map(
          (upcoming.data?.pages.flatMap((part) => part.items) ?? []).map((item) => [item.id, item]),
        ).values(),
      ]
    : (catalog.data?.results ?? catalog.data?.items ?? []);
  const items =
    query && category ? results.filter((item) => item.entityType === category) : results;
  return (
    <>
      <div className="discover-head">
        <div className="page-path">
          <Breadcrumbs />
          <h1>{t("discover")}</h1>
        </div>
        <form
          className="search-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length >= 2) {
              setParams({ q: text.trim() });
            }
          }}
        >
          <label className="sr-only" htmlFor="search">
            {t("search")}
          </label>
          <div className="search-field">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" />
            </svg>
            <input
              id="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("searchPlaceholder")}
              minLength={2}
              maxLength={100}
              required
            />
          </div>
          <button>{t("search")}</button>
        </form>
      </div>
      <div className="workspace-columns">
        <section>
          <div className="tabs-row">
            <nav className="tabs" aria-label={t("discover")}>
              <button
                className={!query && mode === "upcoming" ? "selected" : ""}
                onClick={() => {
                  setText("");
                  setParams({ view: "upcoming" });
                }}
              >
                {t("upcoming")}
              </button>
              <button
                className={!query && mode === "leagues" ? "selected" : ""}
                onClick={() => {
                  setText("");
                  setParams({ view: "leagues" });
                }}
              >
                {t("leagues")}
              </button>
              {query && (
                <span className="selected">
                  {t("search")}: {query}
                </span>
              )}
            </nav>
            <p className="tabs-note">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" />
                <path d="M8 4.5V8l2.5 1.5" />
              </svg>
              {t("scheduleNote", { timezone: timezoneOf(user) })}
            </p>
          </div>
          {query && (
            <nav className="filter-tabs" aria-label={t("resultType")}>
              {[
                ["", "allResults"],
                ["league", "leagues"],
                ["team", "teams"],
                ["event", "events"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={category === value}
                  onClick={() => setParams({ ...Object.fromEntries(params), type: value })}
                >
                  {t(label)}
                </button>
              ))}
            </nav>
          )}
          {query && user.plan && !user.plan.allContent && (
            <p className="muted">{t("planSearchNote", { name: user.plan.name })}</p>
          )}
          {result.isPending ? (
            <>
              <Loading />
              <ErrorMessage error={result.failureReason} />
            </>
          ) : result.error && !items.length ? (
            <ErrorMessage error={result.error} />
          ) : schedule ? (
            items.length ? (
              <DaySchedule items={items} timezone={timezoneOf(user)} />
            ) : (
              <p className="empty">
                {t(upcoming.hasNextPage ? "emptySchedulePage" : "emptySchedule")}
              </p>
            )
          ) : (
            <div className="catalog-shelves">
              {(query
                ? ["league", "team", "event"]
                : [mode === "leagues" ? "league" : "event"]
              ).map((kind) => {
                const group = query ? items.filter((item) => item.entityType === kind) : items;
                if (!group.length) {
                  return null;
                }
                return (
                  <section
                    key={kind}
                    className={`catalog-shelf${query && !category && kind !== "event" && group.length <= 2 ? " shelf-compact" : ""}`}
                  >
                    {query && (
                      <h2>
                        {t(kind === "league" ? "leagues" : kind === "team" ? "teams" : "events")}{" "}
                        <span className="result-count">{group.length}</span>
                      </h2>
                    )}
                    <div className="fixtures">
                      {group.map((item) => (
                        <Fixture
                          headingLevel={query ? 3 : 2}
                          key={kind + item.id}
                          item={item}
                          kind={kind}
                          timezone={timezoneOf(user)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
              {!items.length && <p className="empty">{t("empty")}</p>}
            </div>
          )}
          {/* Searches return a limited number of events; older ones live under their league. */}
          {query && !result.isPending && (
            <aside className="search-hint">
              <p>{t("olderEventsHint")}</p>
              {results.some((item) => item.entityType === "league") && (
                <p className="search-hint-links">
                  {results
                    .filter((item) => item.entityType === "league")
                    .slice(0, 3)
                    .map((league) => (
                      <Link key={league.id} to={"/catalog/league/" + league.id}>
                        {t("openLeague", { name: league.name })}
                      </Link>
                    ))}
                </p>
              )}
            </aside>
          )}
          {schedule && upcoming.hasNextPage && !upcoming.isPending && (
            <button
              className="quiet load-more"
              disabled={upcoming.isFetching}
              onClick={() => void upcoming.fetchNextPage()}
            >
              {t(upcoming.isFetching ? "loading" : "moreEvents")}
            </button>
          )}
          {result.error && items.length > 0 && <ErrorMessage error={result.error} />}
          {result.error && (
            <button className="quiet" onClick={() => void result.refetch()}>
              {t("retry")}
            </button>
          )}
          {!query && !schedule && !catalog.isPending && !catalog.error && (
            <Pager
              page={page}
              more={catalog.data?.hasMore ?? page < (catalog.data?.totalPages ?? 0)}
              onChange={(page) => setParams({ view: mode, page: String(page) })}
            />
          )}
        </section>
        <aside className="popular" aria-labelledby="popular-title">
          <h2 id="popular-title">{t("popular")}</h2>
          {popular.data?.items.length ? (
            <div className="chip-list">
              {popular.data.items.map((item) => (
                <Link
                  className="league-chip"
                  key={item.id}
                  to={"/catalog/league/" + item.metadata.id}
                >
                  <Artwork item={item.metadata} kind="league" />
                  <span>{item.metadata.name}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">{t("popularEmpty")}</p>
          )}
        </aside>
      </div>
    </>
  );
}
/** The coming events, a section per day in the viewer's time zone. */
function DaySchedule({ items, timezone }: { items: Item[]; timezone: string }) {
  const { t, i18n } = useTranslation();
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    }).format(date);
  // Read once: which days are today and tomorrow does not change while the list is open.
  const [now] = useState(() => Date.now());
  const today = day(new Date(now));
  const tomorrow = day(new Date(now + 86400000));
  const days = new Map<string, Item[]>();
  for (const item of items) {
    const start = item.scheduledStart ? new Date(item.scheduledStart) : null;
    const key = start && !Number.isNaN(start.getTime()) ? day(start) : "";
    days.set(key, [...(days.get(key) ?? []), item]);
  }
  return (
    <div className="day-schedule">
      {[...days].map(([key, events]) => {
        // Noon UTC names the calendar day the key already is in the viewer's zone.
        const date = key ? new Date(`${key}T12:00:00Z`) : null;
        const format = (options: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat(i18n.language, { ...options, timeZone: "UTC" }).format(date!);
        const weekday = date ? format({ weekday: "long" }) : t("dateUnknown");
        return (
          <section key={key} className="day-group" aria-labelledby={`day-${key || "unknown"}`}>
            <h2 id={`day-${key || "unknown"}`}>
              <span className="day-name">
                {key === today
                  ? t("today")
                  : key === tomorrow
                    ? t("tomorrow")
                    : weekday.charAt(0).toUpperCase() + weekday.slice(1)}
              </span>
              {date && (
                <span className="day-date">{format({ day: "numeric", month: "long" })}</span>
              )}
            </h2>
            <div className="fixtures">
              {events.map((item) => (
                <Fixture key={item.id} item={item} timezone={timezone} showDate={false} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
export function CatalogDetail({ user }: { user: User }) {
  const { kind = "event", id = "" } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [order, setOrder] = useState("desc");
  const valid = ["league", "season", "event", "team"].includes(kind);
  // Seasons are offered only to users with the season grant; the server enforces it too.
  const mayRequest = kind !== "season" || mayRequestSeasons(user);
  const detail = useQuery({
    queryKey: ["detail", kind, id],
    queryFn: () => api<Item>(`/catalog/${kind}s/${encodeURIComponent(id)}`),
    enabled: valid,
  });
  const listPath =
    kind === "league"
      ? `/catalog/leagues/${encodeURIComponent(id)}/seasons?page=${page}`
      : `/catalog/events?${kind === "season" ? "season" : "team"}=${encodeURIComponent(id)}&page=${page}&order=${order}`;
  const list = useQuery({
    queryKey: ["detail-list", listPath],
    queryFn: () => api<Page>(listPath),
    enabled: valid && kind !== "event",
  });
  const availability = useQuery({
    queryKey: ["availability", kind, id],
    queryFn: () =>
      api<{
        state: "requested" | "available" | "missing" | "unknown" | "not_allowed";
        reason?: string;
        request?: { id: string; status: string };
        subscribed?: boolean;
        visible?: boolean;
      }>(`/requests/lookup?kind=${kind}&identifier=${encodeURIComponent(id)}`),
    enabled: valid && mayRequest && ["season", "event"].includes(kind),
    staleTime: 15000,
  });
  // Events split into parts (e.g. fight cards) ask which parts to request.
  const parts = useQuery({
    queryKey: ["parts", kind, id],
    queryFn: () =>
      api<PartOptions>(`/requests/parts?kind=${kind}&identifier=${encodeURIComponent(id)}`),
    enabled: valid && mayRequest && ["season", "event"].includes(kind),
    staleTime: 15000,
  });
  const [choosing, setChoosing] = useState(false);
  const byParts = parts.data?.supported === true;
  // Only starting a request uses the weekly limit; following one never does.
  const quota = useQuota(user);
  const exhausted = quota.data?.remaining === 0;
  const request = useMutation({
    mutationFn: (chosen?: string[]) =>
      api<{ request: { id: string } | null; available?: boolean }>("/requests", "POST", {
        kind,
        identifier: id,
        ...(chosen ? { parts: chosen } : {}),
      }),
    onSettled: () => void client.invalidateQueries({ queryKey: ["quota"] }),
    onSuccess: (result) => {
      setChoosing(false);
      void client.invalidateQueries({ queryKey: ["requests"] });
      void client.invalidateQueries({ queryKey: ["parts", kind, id] });
      if (result.request) {
        navigate("/requests/" + result.request.id);
      } else if (result.available) {
        client.setQueryData(["availability", kind, id], { state: "available" });
      }
    },
  });
  if (!valid) {
    return <p>{t("notFound")}</p>;
  }
  if (detail.isPending) {
    return (
      <>
        <Loading />
        <ErrorMessage error={detail.failureReason} />
      </>
    );
  }
  if (detail.error) {
    return <ErrorMessage error={detail.error} />;
  }
  const item = detail.data!;
  const start = item.scheduledStart ? new Date(item.scheduledStart) : null;
  const longDate = (date: Date) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: timezoneOf(user),
    }).format(date);
  return (
    <>
      <Breadcrumbs
        trail={[
          { label: t("discover"), to: "/" },
          ...(kind !== "league" && item.leagueId
            ? [{ label: item.leagueName ?? t("league"), to: "/catalog/league/" + item.leagueId }]
            : []),
          ...(kind === "event" && item.seasonId
            ? [{ label: item.seasonName ?? t("season"), to: "/catalog/season/" + item.seasonId }]
            : []),
        ]}
        current={item.name}
      />
      <header className="detail-heading">
        <div className={`detail-artwork${kind === "event" ? " detail-artwork-wide" : ""}`}>
          <Artwork item={item} kind={kind} />
        </div>
        <div className="detail-copy">
          <h1>{item.name}</h1>
          <p className="detail-meta">
            {start && (
              <span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2" y="3" width="12" height="11" rx="2" />
                  <path d="M2 7h12M5 1.5v3M11 1.5v3" />
                </svg>
                <time dateTime={start.toISOString()}>{longDate(start)}</time>
              </span>
            )}
            <span>
              {t(kind)}
              {item.sportName ? ` / ${item.sportName}` : ""}
            </span>
          </p>
          {item.description && <p className="detail-description">{item.description}</p>}
        </div>
        {["season", "event"].includes(kind) && (
          <aside className="request-box" aria-label={t("request")}>
            {!mayRequest ? (
              <p role="status" className="notice">
                {t("seasonRequestsNotAllowed")}
              </p>
            ) : availability.isPending ? (
              <Loading />
            ) : availability.error ? (
              <>
                <ErrorMessage error={availability.error} />
                <button className="quiet" onClick={() => void availability.refetch()}>
                  {t("retry")}
                </button>
              </>
            ) : availability.data?.state === "not_allowed" ? (
              <p role="status" className="notice">
                {t("notInPlan")}
              </p>
            ) : availability.data?.state === "available" ? (
              <>
                <Status value="AVAILABLE" />
                <p>{t("alreadyAvailable")}</p>
              </>
            ) : availability.data?.state === "requested" ? (
              <>
                <Status value={availability.data.request!.status} />
                {/* Requested elsewhere: its state shows, but it opens once followed. */}
                {availability.data.visible !== false && (
                  <Link to={"/requests/" + availability.data.request!.id}>{t("requested")}</Link>
                )}
                {availability.data.subscribed && !byParts ? (
                  <p>{t("alreadyFollowing")}</p>
                ) : (
                  <button
                    className="quiet"
                    disabled={request.isPending || parts.isPending}
                    onClick={() => (byParts ? setChoosing(true) : request.mutate(undefined))}
                  >
                    {t(byParts ? "addParts" : "followRequest")}
                  </button>
                )}
              </>
            ) : availability.data?.state === "unknown" &&
              availability.data.reason !== "not_configured" ? (
              <>
                <p role="status" className="notice">
                  {t("availabilityUnknown")}
                </p>
                <button className="quiet" onClick={() => void availability.refetch()}>
                  {t("retry")}
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={request.isPending || parts.isPending || exhausted}
                  onClick={() => (byParts ? setChoosing(true) : request.mutate(undefined))}
                >
                  {t(
                    request.isPending
                      ? "requestBusy"
                      : kind === "season"
                        ? "requestSeason"
                        : "requestEvent",
                  )}
                </button>
                <p>{t(kind === "season" ? "scopeNote" : "requestHelp")}</p>
                <QuotaNote quota={quota.data} user={user} />
                {availability.data?.reason === "not_configured" && (
                  <p>{t("managerNotConfigured")}</p>
                )}
              </>
            )}
            {!choosing && <ErrorMessage error={request.error} />}
            {choosing && byParts && (
              <PartsDialog
                parts={parts.data!.parts}
                busy={request.isPending}
                error={request.error}
                onConfirm={(chosen) => request.mutate(chosen)}
                onClose={() => {
                  setChoosing(false);
                  request.reset();
                }}
              />
            )}
          </aside>
        )}
      </header>
      {kind === "event" ? (
        <section className="detail-facts" aria-labelledby="details-title">
          <h2 id="details-title">{t("details")}</h2>
          <dl>
            {item.leagueName && (
              <div>
                <dt>{t("competition")}</dt>
                <dd>{item.leagueName}</dd>
              </div>
            )}
            {item.seasonName && (
              <div>
                <dt>{t("season")}</dt>
                <dd>{item.seasonName}</dd>
              </div>
            )}
            {item.sportName && (
              <div>
                <dt>{t("sport")}</dt>
                <dd>{item.sportName}</dd>
              </div>
            )}
            <div>
              <dt>{t("startsAt")}</dt>
              <dd>{start ? longDate(start) : t("dateUnknown")}</dd>
            </div>
          </dl>
          <p className="muted">{t("scheduleNote", { timezone: timezoneOf(user) })}</p>
        </section>
      ) : (
        <section>
          <div className="section-actions">
            <h2>{t(kind === "league" ? "seasons" : "events")}</h2>
            {kind !== "league" && (
              <label className="sort-control">
                {t("eventOrder")}
                <select
                  value={order}
                  onChange={(event) => {
                    setOrder(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="desc">{t("newestFirst")}</option>
                  <option value="asc">{t("oldestFirst")}</option>
                </select>
              </label>
            )}
          </div>
          {kind === "season" && <p className="muted">{t("openSeason")}</p>}
          {list.isPending ? (
            <Loading />
          ) : list.error ? (
            <ErrorMessage error={list.error} />
          ) : (
            <div className="fixtures">
              {list.data?.items.map((item) => (
                <Fixture
                  key={item.id}
                  item={item}
                  kind={kind === "league" ? "season" : "event"}
                  timezone={timezoneOf(user)}
                />
              ))}
              {!list.data?.items.length && (
                <p className="empty">{t(kind === "league" ? "noSeasons" : "empty")}</p>
              )}
            </div>
          )}
          <Pager page={page} more={page < (list.data?.totalPages ?? 0)} onChange={setPage} />
        </section>
      )}
    </>
  );
}
