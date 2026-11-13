import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  client,
  ISSUE_CATEGORIES,
  type Issue,
  type IssueDetail as IssueRecord,
  type RequestRecord,
  type User,
} from "./api";
import { ErrorMessage, Loading, Pager, Status } from "./ui";

/** What the issue is about: the request, plus the event and part when given. */
function subject(issue: Issue) {
  return [issue.request.title, issue.request.season, issue.event?.name, issue.part]
    .filter(Boolean)
    .join(" / ");
}
function useDate(user: User) {
  const { i18n } = useTranslation();
  return (date: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: user.timezone,
    }).format(new Date(date));
}
const refresh = () => {
  void client.invalidateQueries({ queryKey: ["issues"] });
  void client.invalidateQueries({ queryKey: ["issue"] });
};

export function Issues({ user }: { user: User }) {
  const { t } = useTranslation();
  const format = useDate(user);
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1) || 1;
  const status = params.get("status") ?? "";
  const category = params.get("category") ?? "";
  const mine = params.get("mine") === "true";
  const query = new URLSearchParams({ page: String(page) });
  for (const [key, value] of [
    ["status", status],
    ["category", category],
    ["mine", mine ? "true" : ""],
  ]) {
    if (value) {
      query.set(key, value);
    }
  }
  const result = useQuery({
    queryKey: ["issues", query.toString()],
    queryFn: () => api<{ items: Issue[]; total: number }>("/issues?" + query),
    refetchInterval: 30000,
  });
  const change = (values: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), page: "1", ...values });
  return (
    <>
      <header className="page-heading">
        <h1>{t("issues")}</h1>
        <p>{t(user.role === "ADMIN" ? "issuesAdminHelp" : "issuesHelp")}</p>
      </header>
      <nav className="filter-tabs" aria-label={t("status")}>
        {["", "OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((value) => (
          <button
            key={value}
            aria-pressed={status === value}
            onClick={() => change({ status: value })}
          >
            {t(value || "all")}
          </button>
        ))}
      </nav>
      {user.role === "ADMIN" && (
        <div className="filters">
          <label>
            {t("issueCategory")}
            <select value={category} onChange={(event) => change({ category: event.target.value })}>
              <option value="">{t("allCategories")}</option>
              {ISSUE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={mine}
              onChange={(event) => change({ mine: String(event.target.checked) })}
            />
            {t("myIssues")}
          </label>
        </div>
      )}
      {result.isPending ? (
        <Loading />
      ) : result.error ? (
        <ErrorMessage error={result.error} />
      ) : (
        <ul className="issue-list">
          {result.data?.items.map((issue) => (
            <li key={issue.id}>
              <Link to={"/issues/" + issue.id}>
                <span className="issue-category">{t(issue.category)}</span>
                <span className="issue-subject">{subject(issue)}</span>
              </Link>
              <Status value={issue.status} />
              <span className="muted">
                {issue.reporter ? `${issue.reporter.email} · ` : ""}
                {t("issueUpdated", { date: format(issue.updatedAt) })}
              </span>
            </li>
          ))}
          {!result.data?.items.length && <li className="empty">{t("issueEmpty")}</li>}
        </ul>
      )}
      <Pager
        page={page}
        more={page * 30 < (result.data?.total ?? 0)}
        onChange={(next) => setParams({ ...Object.fromEntries(params), page: String(next) })}
      />
    </>
  );
}

export function IssueDetail({ user }: { user: User }) {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const format = useDate(user);
  const [action, setAction] = useState<Issue["status"] | null>(null);
  const result = useQuery({
    queryKey: ["issue", id],
    queryFn: () => api<IssueRecord>("/issues/" + id),
    refetchInterval: 30000,
  });
  const comment = useMutation({
    mutationFn: (body: string) => api<IssueRecord>(`/issues/${id}/comments`, "POST", { body }),
    onSuccess: (issue) => {
      client.setQueryData(["issue", id], issue);
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: (body: { status: Issue["status"]; comment?: string }) =>
      api<IssueRecord>(`/issues/${id}`, "PATCH", body),
    onSuccess: (issue) => {
      setAction(null);
      client.setQueryData(["issue", id], issue);
      refresh();
    },
  });
  if (result.isPending) {
    return <Loading />;
  }
  if (result.error) {
    return <ErrorMessage error={result.error} />;
  }
  const issue = result.data!;
  const admin = user.role === "ADMIN";
  const finished = issue.status === "RESOLVED" || issue.status === "CLOSED";
  // Administrators manage the lifecycle; reporters close active issues and reopen finished ones.
  const actions: Issue["status"][] = admin
    ? finished
      ? ["OPEN"]
      : issue.status === "OPEN"
        ? ["IN_PROGRESS", "RESOLVED", "CLOSED"]
        : ["RESOLVED", "CLOSED"]
    : finished
      ? ["OPEN"]
      : ["CLOSED"];
  const label: Record<Issue["status"], string> = {
    OPEN: "reopenIssue",
    IN_PROGRESS: "markInProgress",
    RESOLVED: "resolveIssue",
    CLOSED: "closeIssue",
  };
  const author = (entry: IssueRecord["timeline"][number]) =>
    !entry.author
      ? t("formerUser")
      : entry.author.mine
        ? t("you")
        : (entry.author.email ?? t(entry.author.role === "ADMIN" ? "administrator" : "reporter"));
  return (
    <>
      <Link className="back" to="/issues">
        {t("issues")}
      </Link>
      <header className="issue-heading">
        <Status value={issue.status} />
        <h1>{t(issue.category)}</h1>
        <p>
          <Link to={"/requests/" + issue.request.id}>{subject(issue)}</Link>
        </p>
        {issue.reporter && (
          <p className="muted">{t("reportedBy", { email: issue.reporter.email })}</p>
        )}
      </header>
      <div className="workspace-columns">
        <section>
          <h2>{t("conversation")}</h2>
          <ol className="history issue-timeline">
            <li>
              <strong>{issue.mine ? t("you") : (issue.reporter?.email ?? t("reporter"))}</strong>
              <time dateTime={issue.createdAt}>{format(issue.createdAt)}</time>
              <p>{issue.description}</p>
            </li>
            {issue.timeline.map((entry) => (
              <li key={entry.id}>
                <strong>{author(entry)}</strong>
                <time dateTime={entry.createdAt}>{format(entry.createdAt)}</time>
                {entry.status && (
                  <p className="issue-change">{t("statusChanged", { status: t(entry.status) })}</p>
                )}
                {entry.body && <p>{entry.body}</p>}
              </li>
            ))}
          </ol>
          <form
            className="compact-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              comment.mutate(String(new FormData(form).get("body")), {
                onSuccess: () => form.reset(),
              });
            }}
          >
            <label>
              {t("comment")}
              <textarea name="body" required maxLength={2000} rows={4} />
            </label>
            <ErrorMessage error={comment.error} />
            <button disabled={comment.isPending}>{t("addComment")}</button>
          </form>
        </section>
        <section className="sidebar-note">
          <h2>{t("status")}</h2>
          <div className="issue-actions">
            {actions.map((status) => (
              <button
                key={status}
                className={status === "RESOLVED" ? "" : "quiet"}
                disabled={change.isPending}
                aria-expanded={status === action}
                onClick={() =>
                  status === "IN_PROGRESS"
                    ? change.mutate({ status })
                    : setAction(action === status ? null : status)
                }
              >
                {t(label[status])}
              </button>
            ))}
          </div>
          {action && (
            <form
              className="compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                const note = String(new FormData(event.currentTarget).get("note") ?? "").trim();
                change.mutate({ status: action, ...(note ? { comment: note } : {}) });
              }}
            >
              <label>
                {t(action === "RESOLVED" ? "resolutionNote" : "optionalNote")}
                <textarea name="note" required={action === "RESOLVED"} maxLength={2000} rows={3} />
              </label>
              <button disabled={change.isPending}>{t(label[action])}</button>
            </form>
          )}
          <ErrorMessage error={change.error} />
        </section>
      </div>
    </>
  );
}

/**
 * Reporting form on a request the viewer follows, with the viewer's issues about it. The event
 * and part choices appear only when the request has them.
 */
export function RequestIssues({ request, user }: { request: RequestRecord; user: User }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [eventId, setEventId] = useState("");
  const mine = useQuery({
    queryKey: ["issues", "request", request.id],
    queryFn: () =>
      api<{ items: Issue[] }>(
        `/issues?request=${request.id}${user.role === "ADMIN" ? "&mine=true" : ""}`,
      ),
  });
  const report = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<Issue>(`/requests/${request.id}/issues`, "POST", body),
    onSuccess: (issue) => {
      refresh();
      navigate("/issues/" + issue.id);
    },
  });
  const events = request.events ?? [];
  const selected = events.find((event) => event.id === eventId);
  const parts = [
    ...new Set([
      ...request.parts.map((part) => part.name),
      ...(selected ? selected.parts : events.flatMap((event) => event.parts)),
    ]),
  ];
  const existing =
    report.error instanceof ApiError && report.error.code === "ISSUE_EXISTS"
      ? report.error.issueId
      : undefined;
  return (
    <section className="request-issues">
      <h2>{t("issues")}</h2>
      {mine.data?.items?.length ? (
        <ul className="issue-list">
          {mine.data.items.map((issue) => (
            <li key={issue.id}>
              <Link to={"/issues/" + issue.id}>
                <span className="issue-category">{t(issue.category)}</span>
                <span className="issue-subject">
                  {[issue.event?.name, issue.part].filter(Boolean).join(" / ")}
                </span>
              </Link>
              <Status value={issue.status} />
            </li>
          ))}
        </ul>
      ) : null}
      {!open ? (
        <button className="quiet" onClick={() => setOpen(true)}>
          {t("reportIssue")}
        </button>
      ) : (
        <form
          className="panel compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const body: Record<string, string> = {
              category: String(data.get("category")),
              description: String(data.get("description")),
            };
            for (const key of ["eventId", "part"]) {
              if (data.get(key)) {
                body[key] = String(data.get(key));
              }
            }
            report.mutate(body);
          }}
        >
          <label>
            {t("issueCategory")}
            <select name="category" required defaultValue="">
              <option value="" disabled>
                {t("chooseCategory")}
              </option>
              {ISSUE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(value)}
                </option>
              ))}
            </select>
          </label>
          {request.scope.kind === "season" && events.length > 0 && (
            <label>
              {t("event")}
              <select
                name="eventId"
                value={eventId}
                onChange={(event) => setEventId(event.target.value)}
              >
                <option value="">{t("allEvents")}</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.metadata.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {parts.length > 0 && (
            <label>
              {t("issuePart")}
              <select name="part" defaultValue="">
                <option value="">{t("wholeEvent")}</option>
                {parts.map((part) => (
                  <option key={part}>{part}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t("issueDescription")}
            <textarea name="description" required maxLength={2000} rows={4} />
          </label>
          <p className="muted">{t("issuesHelp")}</p>
          <ErrorMessage error={report.error} />
          {existing && <Link to={"/issues/" + existing}>{t("openExistingIssue")}</Link>}
          <div className="dialog-actions">
            <button type="button" className="quiet" onClick={() => setOpen(false)}>
              {t("cancel")}
            </button>
            <button disabled={report.isPending}>{t("sendReport")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
