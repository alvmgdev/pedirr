import { useState } from "react";
import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, client, type Item, type Page, type User } from "./api";
import { Artwork, ErrorMessage, Fixture, Loading, Pager, Status } from "./ui";
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
      <header className="page-heading">
        <h1>{t("discover")}</h1>
        <p>{t("intro")}</p>
      </header>
      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim().length >= 2) setParams({ q: text.trim() });
        }}
      >
        <label className="sr-only" htmlFor="search">
          {t("search")}
        </label>
        <input
          id="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("searchPlaceholder")}
          minLength={2}
          maxLength={100}
          required
        />
        <button>{t("search")}</button>
      </form>
      <div className="workspace-columns">
        <section>
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
          <p className="muted">{t("scheduleNote", { timezone: user.timezone })}</p>
          {result.isPending ? (
            <>
              <Loading />
              <ErrorMessage error={result.failureReason} />
            </>
          ) : result.error && !items.length ? (
            <ErrorMessage error={result.error} />
          ) : (
            <div className="catalog-shelves">
              {(query
                ? ["league", "team", "event"]
                : [mode === "leagues" ? "league" : "event"]
              ).map((kind) => {
                const group = query ? items.filter((item) => item.entityType === kind) : items;
                if (!group.length) return null;
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
                          timezone={user.timezone}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
              {!items.length && (
                <p className="empty">
                  {t(
                    schedule
                      ? upcoming.hasNextPage
                        ? "emptySchedulePage"
                        : "emptySchedule"
                      : "empty",
                  )}
                </p>
              )}
            </div>
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
        <aside className="sidebar-note" aria-label={t("popular")}>
          <h2>{t("popular")}</h2>
          {popular.data?.items.length ? (
            popular.data.items.map((item) => (
              <Link
                className="league-link"
                key={item.id}
                to={"/catalog/league/" + item.metadata.id}
              >
                <Artwork item={item.metadata} kind="league" />
                <span>{item.metadata.name}</span>
              </Link>
            ))
          ) : (
            <p>{t("popularEmpty")}</p>
          )}
          <div className="request-explainer">
            <h2>{t("requests")}</h2>
            <p>{t("requestHelp")}</p>
            <Link to="/requests">{t("requests")}</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
export function CatalogDetail({ user }: { user: User }) {
  const { kind = "event", id = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [order, setOrder] = useState("desc");
  const valid = ["league", "season", "event", "team"].includes(kind);
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
        state: "requested" | "available" | "missing" | "unknown";
        reason?: string;
        request?: { id: string; status: string };
      }>(`/requests/lookup?kind=${kind}&identifier=${encodeURIComponent(id)}`),
    enabled: valid && ["season", "event"].includes(kind),
    staleTime: 15000,
  });
  const request = useMutation({
    mutationFn: () =>
      api<{ request: { id: string } | null; available?: boolean }>("/requests", "POST", {
        kind,
        identifier: id,
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["requests"] });
      if (result.request) navigate("/requests/" + result.request.id);
      else if (result.available)
        client.setQueryData(["availability", kind, id], { state: "available" });
    },
  });
  if (!valid) return <p>{t("notFound")}</p>;
  if (detail.isPending)
    return (
      <>
        <Loading />
        <ErrorMessage error={detail.failureReason} />
      </>
    );
  if (detail.error) return <ErrorMessage error={detail.error} />;
  const item = detail.data!;
  return (
    <>
      <Link className="back" to="/">
        {t("back")}
      </Link>
      <header className="detail-heading">
        <div className="detail-artwork">
          <Artwork item={item} kind={kind} />
        </div>
        <div className="detail-copy">
          <p className="muted">
            {t(kind)}
            {item.sportName ? ` / ${item.sportName}` : ""}
          </p>
          <h1>{item.name}</h1>
          {item.leagueId && (
            <Link to={"/catalog/league/" + item.leagueId}>{item.leagueName ?? t("league")}</Link>
          )}
          {item.description && <p>{item.description}</p>}
        </div>
        {["season", "event"].includes(kind) && (
          <div className="request-box">
            {availability.isPending ? (
              <Loading />
            ) : availability.error ? (
              <>
                <ErrorMessage error={availability.error} />
                <button className="quiet" onClick={() => void availability.refetch()}>
                  {t("retry")}
                </button>
              </>
            ) : availability.data?.state === "available" ? (
              <>
                <Status value="AVAILABLE" />
                <p>{t("alreadyAvailable")}</p>
              </>
            ) : availability.data?.state === "requested" ? (
              <>
                <Status value={availability.data.request!.status} />
                <Link to={"/requests/" + availability.data.request!.id}>{t("requested")}</Link>
                <button
                  className="quiet"
                  disabled={request.isPending}
                  onClick={() => request.mutate()}
                >
                  {t("followRequest")}
                </button>
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
                <button disabled={request.isPending} onClick={() => request.mutate()}>
                  {t(
                    request.isPending
                      ? "requestBusy"
                      : kind === "season"
                        ? "requestSeason"
                        : "requestEvent",
                  )}
                </button>
                <p>{t(kind === "season" ? "scopeNote" : "requestHelp")}</p>
                {availability.data?.reason === "not_configured" && (
                  <p>{t("managerNotConfigured")}</p>
                )}
              </>
            )}
            <ErrorMessage error={request.error} />
          </div>
        )}
      </header>
      {kind === "event" ? (
        <section className="panel">
          <h2>{t("details")}</h2>
          <Fixture item={item} timezone={user.timezone} />
          <p className="muted">{t("scheduleNote", { timezone: user.timezone })}</p>
          {item.seasonName && (
            <p>
              {t("season")}: {item.seasonName}
            </p>
          )}
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
                  timezone={user.timezone}
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
