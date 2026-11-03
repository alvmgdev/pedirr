import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, client, type RequestRecord, type User } from "./api";
import { Artwork, ErrorMessage, Loading, Pager, Status } from "./ui";
export function Requests() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1) || 1;
  const status = params.get("status") ?? "";
  const mine = params.get("mine") === "true";
  const query = new URLSearchParams({ page: String(page), mine: String(mine) });
  if (status) query.set("status", status);
  const result = useQuery({
    queryKey: ["requests", query.toString()],
    queryFn: () =>
      api<{ items: RequestRecord[]; total: number }>("/requests?" + query),
    refetchInterval: 30000,
  });
  const change = (values: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), page: "1", ...values });
  return (
    <>
      <header className="page-heading">
        <h1>{t("requests")}</h1>
        <p>{t("requestHelp")}</p>
      </header>
      <nav className="filter-tabs" aria-label={t("status")}>
        {["", "PENDING", "APPROVED", "DOWNLOADING", "AVAILABLE", "REJECTED"].map(value => (
          <button key={value} aria-pressed={status === value} onClick={() => change({ status: value })}>
            {t(value || "all")}
          </button>
        ))}
      </nav>
      <div className="filters">
        <label className="check">
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => change({ mine: String(event.target.checked) })}
          />
          {t("mine")}
        </label>
      </div>
      {result.isPending ? (
        <Loading />
      ) : result.error ? (
        <ErrorMessage error={result.error} />
      ) : (
        <div className="request-list">
          {result.data?.items.map((request) => (
            <Link
              className="request-row"
              key={request.id}
              to={"/requests/" + request.id}
            >
              <Artwork item={request.scope.event ?? request.scope.league ?? { id: request.id, name: request.entity.title }} kind={request.scope.kind === "event" ? "event" : "league"} />
              <div className="request-name">
                <h2>{request.entity.title}</h2>
                <p>{request.scope.season?.name ?? t("event")}</p>
              </div>
              <Status value={request.status} />
            </Link>
          ))}
          {!result.data?.items.length && (
            <p className="empty">{t("requestEmpty")}</p>
          )}
        </div>
      )}
      <Pager
        page={page}
        more={page * 30 < (result.data?.total ?? 0)}
        onChange={(page) =>
          setParams({ ...Object.fromEntries(params), page: String(page) })
        }
      />
    </>
  );
}
export function RequestDetail({ user }: { user: User }) {
  const { id = "" } = useParams();
  const { t, i18n } = useTranslation();
  const [reject, setReject] = useState(false);
  const result = useQuery({
    queryKey: ["requests", id],
    queryFn: () => api<RequestRecord>("/requests/" + id),
    refetchInterval: 15000,
  });
  const review = useMutation({
    mutationFn: (body: unknown) =>
      api("/requests/" + id + "/review", "POST", body),
    onSuccess: () => {
      setReject(false);
      void client.invalidateQueries({ queryKey: ["requests"] });
    },
  });
  if (result.isPending) return <Loading />;
  if (result.error) return <ErrorMessage error={result.error} />;
  const request = result.data!;
  const format = (date: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: user.timezone,
    }).format(new Date(date));
  return (
    <>
      <Link className="back" to="/requests">
        {t("back")}
      </Link>
      <header className="detail-heading">
        <div className="detail-artwork">
          <Artwork
            item={request.scope.event ?? request.scope.league ?? { id: request.id, name: request.entity.title }}
            kind={request.scope.kind === "event" ? "event" : "league"}
          />
        </div>
        <div className="detail-copy">
          <Status value={request.status} />
          <h1>{request.entity.title}</h1>
          <p>{request.scope.season?.name ?? t("event")}</p>
          <p className="muted">
            {t("subscribers", { count: request._count.subscribers })}
          </p>
        </div>
        {user.role === "ADMIN" && request.status === "PENDING" && (
          <div className="request-box">
            <button
              disabled={review.isPending}
              onClick={() =>
                review.mutate({ decision: "approve", version: request.version })
              }
            >
              {t("approve")}
            </button>
            <button className="quiet" onClick={() => setReject(!reject)}>
              {t("reject")}
            </button>
            {reject && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  review.mutate({
                    decision: "reject",
                    version: request.version,
                    reason: String(
                      new FormData(event.currentTarget).get("reason"),
                    ),
                  });
                }}
              >
                <label>
                  {t("reason")}
                  <textarea name="reason" required maxLength={1000} />
                </label>
                <button disabled={review.isPending}>{t("reject")}</button>
              </form>
            )}
            <ErrorMessage error={review.error} />
          </div>
        )}
      </header>
      {request.rejectionReason && (
        <p className="notice">{request.rejectionReason}</p>
      )}
      {request.integrationState === "error" && (
        <p role="status" className="notice danger">
          {t("integrationError")}
        </p>
      )}
      <div className="workspace-columns">
        <section>
          <h2>{t("progress")}</h2>
          {request.events?.length ? (
            <div className="fixtures">
              {request.events.map((event) => (
                <div className="progress-row" key={event.id}>
                  <h3>{event.metadata.name}</h3>
                  <p>{t(event.available ? "available" : "waiting")}</p>
                  <progress
                    max={100}
                    value={event.progress}
                    aria-label={event.metadata.name}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">
              {t(request.status === "PENDING" ? "PENDING" : "waiting")}
            </p>
          )}
        </section>
        <section className="sidebar-note">
          <h2>{t("history")}</h2>
          <ol className="history">
            {request.history?.map((entry) => (
              <li key={entry.id}>
                <strong>{t(entry.details.status ?? entry.action)}</strong>
                <time dateTime={entry.createdAt}>
                  {format(entry.createdAt)}
                </time>
                {entry.details.reason && <p>{entry.details.reason}</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
