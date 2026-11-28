import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  isExpired,
  type Item,
  type ListedUser,
  type PartOption,
  type Quota,
  type User,
} from "./api";
export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const keys: Record<string, string> = {
    AVAILABILITY_UNKNOWN: "availabilityUnknown",
    SPORTARR_AUTH_FAILED: "managerAuthFailed",
    SPORTARR_UNREACHABLE: "managerUnreachable",
    INVALID_MANAGER_DEFAULTS: "managerDefaults",
    API_KEY_REQUIRED: "secretRequired",
    SMTP_PASSWORD_REQUIRED: "secretRequired",
    INVALID_MANAGER_URL: "invalidUrl",
    INVALID_DISCORD_WEBHOOK: "invalidDiscord",
    DISCORD_WEBHOOK_REQUIRED: "invalidDiscord",
    INVALID_SMTP_HOST: "invalidSmtp",
    REGISTRATION_CLOSED: "registrationClosed",
    INVALID_CREDENTIALS: "invalidCredentials",
    CSRF_INVALID: "csrf",
    RATE_LIMITED: "rateLimited",
    METADATA_BUSY: "metadataBusy",
    REQUEST_CHANGED: "requestChanged",
    INVALID_INPUT: "invalidInput",
    LAST_ADMIN: "lastAdmin",
    INVALID_PARTS: "invalidParts",
    ISSUE_EXISTS: "issueExists",
    ISSUE_NOT_FOUND: "issueNotFound",
    ISSUE_STATUS_NOT_ALLOWED: "issueChanged",
    INVALID_ISSUE_TARGET: "invalidIssueTarget",
    COMMENT_REQUIRED: "commentRequired",
    DESCRIPTION_REQUIRED: "descriptionRequired",
    PARTS_NOT_SUPPORTED: "invalidParts",
    PARTS_REQUIRED: "invalidParts",
    SEASON_REQUESTS_NOT_ALLOWED: "seasonRequestsNotAllowed",
    WEEKLY_LIMIT_REACHED: "weeklyLimitReached",
    TENANT_DISABLED: "environmentDisabled",
    TENANT_NOT_FOUND: "unknownEnvironment",
    PLAN_NOT_ALLOWED: "notInPlan",
    PLAN_IN_PACKAGE: "planInPackageError",
    PLAN_NOT_IN_PACKAGE: "planNotInPackage",
    CLIENT_LIMIT_REACHED: "clientLimitReached",
    CLIENT_NOT_FOUND: "clientNotFound",
    ROLE_NOT_ALLOWED: "roleNotAllowed",
    PACKAGE_NOT_FOUND: "packageNotFound",
    PACKAGE_IN_USE: "packageInUseError",
    PACKAGE_NAME_TAKEN: "packageNameTaken",
    INVALID_PACKAGE_PLAN: "invalidPackagePlan",
    RESELLER_NOT_FOUND: "resellerNotFound",
    RESELLER_CODE_TAKEN: "resellerCodeTaken",
    INVALID_RESELLER_CODE: "invalidResellerCode",
    PLAN_NOT_FOUND: "planNotFound",
    PLAN_IN_USE: "planInUseError",
    PLAN_NAME_TAKEN: "planNameTaken",
    PLAN_EMPTY: "planEmpty",
    INVALID_PLAN_GRANT: "invalidPlanGrant",
    ACCOUNT_EXPIRED: "accountExpired",
    EMAIL_UNAVAILABLE: "emailUnavailable",
    CONNECTION_FAILED: "connectionError",
  };
  const busyReasons: Record<string, string> = {
    local_limit: "metadataLocalLimit",
    upstream_limit: "metadataProviderLimit",
    upstream: "metadataUnavailable",
    in_flight: "metadataLoading",
  };
  const message =
    error instanceof ApiError
      ? error.code === "METADATA_BUSY" && error.reason
        ? (busyReasons[error.reason] ?? "metadataBusy")
        : (keys[error.code] ?? "error")
      : "error";
  return error ? (
    <p role="alert" className="notice danger">
      {t(message)}
    </p>
  ) : null;
}
/** The viewer's weekly limit, fetched only when they have one. */
export function useQuota(user: User) {
  return useQuery({
    queryKey: ["quota"],
    queryFn: () => api<Quota>("/requests/quota"),
    enabled: user.role === "USER" && typeof user.weeklyRequestLimit === "number",
    staleTime: 15000,
  });
}
/**
 * The time zone dates are shown in: this device's, so nobody has to set it, or the one saved at
 * sign-in when the browser cannot tell.
 */
export function timezoneOf(user: { timezone: string }) {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return zone;
    }
  } catch {
    // An unknown zone: fall back to the saved one.
  }
  return user.timezone;
}
export function formatDateTime(value: string, language: string, timezone: string) {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}
/**
 * A small "i" that explains something: it opens on hover with a mouse, and on tap, click
 * or Enter elsewhere. The bubble stays inside the window and closes on Escape or scroll.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = place !== null;
  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const width = Math.min(300, window.innerWidth - 32);
    const left = rect.left + rect.width / 2 - width / 2;
    setPlace({
      top: rect.bottom + 8,
      left: Math.max(16, Math.min(left, window.innerWidth - 16 - width)),
      width,
    });
  };
  const hide = () => setPlace(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => setPlace(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <span
      className="info-tip"
      onPointerEnter={(event) => event.pointerType === "mouse" && show()}
      onPointerLeave={(event) => event.pointerType === "mouse" && hide()}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? hide() : show())}
        onBlur={hide}
        onKeyDown={(event) => event.key === "Escape" && hide()}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span
        id={id}
        role="status"
        className="info-tip-bubble"
        style={place ? { top: place.top, left: place.left, width: place.width } : undefined}
        hidden={!open}
      >
        {open && children}
      </span>
    </span>
  );
}
/** Explains that the weekly limit is a rolling seven days, not the calendar week. */
export function WeeklyLimitInfo() {
  const { t } = useTranslation();
  return <InfoTip label={t("weeklyLimitInfoLabel")}>{t("weeklyLimitInfo")}</InfoTip>;
}
/** One row of a RecordTable: the first cell names the record and links to it. */
export type RecordRow = { key: string; to: string; cells: ReactNode[] };
/** A column's heading; with `sort`, clicking it orders the list by that key. */
export type RecordColumn = string | { label: string; sort: string };
/** The list's current order, and how to change it. */
export type RecordSort = {
  key: string;
  order: "asc" | "desc";
  onChange: (key: string, order: "asc" | "desc") => void;
};
const columnLabel = (column: RecordColumn) => (typeof column === "string" ? column : column.label);
/**
 * Records as a table with headed columns. The whole row opens the record through the
 * link in its first cell; on phones each row stacks its cells, labelled by their column.
 * Sortable columns are buttons that toggle the order, announced with aria-sort.
 */
export function RecordTable({
  label,
  columns,
  rows,
  className,
  sort,
}: {
  label: string;
  columns: RecordColumn[];
  rows: RecordRow[];
  className?: string;
  sort?: RecordSort;
}) {
  return (
    <table className={className ? `record-table ${className}` : "record-table"} aria-label={label}>
      <thead>
        <tr>
          {columns.map((column) => {
            const name = columnLabel(column);
            if (typeof column === "string" || !sort) {
              return (
                <th key={name} scope="col">
                  {name}
                </th>
              );
            }
            const active = sort.key === column.sort;
            return (
              <th
                key={name}
                scope="col"
                aria-sort={active ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
              >
                <button
                  type="button"
                  className="sort-button"
                  onClick={() =>
                    sort.onChange(column.sort, active && sort.order === "asc" ? "desc" : "asc")
                  }
                >
                  {name}
                  <span className="sort-arrow" aria-hidden="true">
                    {active ? (sort.order === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, index) =>
              index === 0 ? (
                <th key={index} scope="row">
                  <Link className="record-link" to={row.to}>
                    {cell}
                  </Link>
                </th>
              ) : (
                <td key={index} data-label={columnLabel(columns[index])}>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
/**
 * A list's search, filters, order and page, kept in the address so Back and shared links
 * keep them. Changing anything but the page goes back to the first page.
 */
export function useListParams() {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const set = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
    }
    if (!("page" in values)) {
      next.delete("page");
    }
    setParams(next, { replace: true });
  };
  /** The API query for these keys, with the page. */
  const query = (keys: string[]) => {
    const result = new URLSearchParams({ page: String(page) });
    for (const key of keys) {
      if (get(key)) {
        result.set(key, get(key));
      }
    }
    return result.toString();
  };
  return { get, page, set, query };
}
/** The keys an account list sends to the API. */
export const ACCOUNT_LIST_KEYS = ["q", "status", "plan", "sort", "order"];
const SORTS = [
  ["", "", "sortEmailAsc"],
  ["email", "desc", "sortEmailDesc"],
  ["created", "desc", "sortNewest"],
  ["created", "asc", "sortOldest"],
  ["expires", "asc", "sortExpiring"],
] as const;
/**
 * Search, filters and order for an account list (users or a reseller's clients). `extra`
 * holds filters only one list has, such as the environment or the role.
 */
export function AccountFilters({
  list,
  plans,
  extra,
}: {
  list: ReturnType<typeof useListParams>;
  plans: { id: string; name: string }[];
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const sortValue = `${list.get("sort")}:${list.get("order")}`;
  const filtered = ["q", "status", "plan", "tenant", "role"].some((key) => list.get(key));
  return (
    <div className="list-toolbar account-filters">
      <SearchBox
        value={list.get("q")}
        label={t("searchEmail")}
        onSearch={(text) => list.set({ q: text })}
      />
      <div className="filters">
        {extra}
        <label className="inline-filter">
          {t("colStatus")}
          <select
            value={list.get("status")}
            onChange={(event) => list.set({ status: event.currentTarget.value })}
          >
            <option value="">{t("anyStatus")}</option>
            <option value="active">{t("statusActive")}</option>
            <option value="inactive">{t("inactive")}</option>
            <option value="expired">{t("expired")}</option>
          </select>
        </label>
        <label className="inline-filter">
          {t("plan")}
          <select
            value={list.get("plan")}
            onChange={(event) => list.set({ plan: event.currentTarget.value })}
          >
            <option value="">{t("anyPlan")}</option>
            <option value="none">{t("noPlanShort")}</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-filter">
          {t("sortBy")}
          <select
            value={
              SORTS.some(([sort, order]) => `${sort}:${order}` === sortValue) ? sortValue : ":"
            }
            onChange={(event) => {
              const [sort, order] = event.currentTarget.value.split(":");
              list.set({ sort, order });
            }}
          >
            {SORTS.map(([sort, order, label]) => (
              <option key={label} value={`${sort}:${order}`}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="link-button"
            onClick={() => list.set({ q: "", status: "", plan: "", tenant: "", role: "" })}
          >
            {t("clearFilters")}
          </button>
        )}
      </div>
    </div>
  );
}
/** Clickable headers for an account list: email and expiration. */
export const accountSort = (list: ReturnType<typeof useListParams>): RecordSort => ({
  key: list.get("sort") || "email",
  order: list.get("order") === "desc" ? "desc" : "asc",
  onChange: (sort, order) =>
    list.set({ sort: sort === "email" ? "" : sort, order: order === "asc" ? "" : order }),
});
/** A search field that updates the list a moment after typing stops. */
export function SearchBox({
  value,
  label,
  onSearch,
}: {
  value: string;
  label: string;
  onSearch: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => {
    if (text.trim() === value) {
      return;
    }
    const timer = setTimeout(() => onSearch(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, value, onSearch]);
  return (
    <label className="search-box">
      <span className="sr-only">{label}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={text}
        placeholder={label}
        onChange={(event) => setText(event.currentTarget.value)}
      />
    </label>
  );
}
/** When an account stops working, in the viewer's time zone, or "Never". */
export function ExpiresOn({ user }: { user: User }) {
  const { t, i18n } = useTranslation();
  if (!user.expiresAt) {
    return <span>{t("neverExpires")}</span>;
  }
  const date = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeZone: timezoneOf(user),
  }).format(new Date(user.expiresAt));
  return <span className={isExpired(user) ? "off" : undefined}>{date}</span>;
}
/** A row's weekly requests: "2 of 3 this week", highlighted once all are used. */
export function WeeklyUsage({ user }: { user: ListedUser }) {
  const { t } = useTranslation();
  if (user.weeklyRequestsUsed === null || user.weeklyRequestLimit === null) {
    return <span>{t("noWeeklyLimit")}</span>;
  }
  const usedUp = user.weeklyRequestsUsed >= user.weeklyRequestLimit;
  return (
    <span className={usedUp ? "used-up" : undefined}>
      {t("weeklyUsage", { used: user.weeklyRequestsUsed, limit: user.weeklyRequestLimit })}
    </span>
  );
}
/** Requests left this week and, once none are left, when the next one frees up. */
export function QuotaNote({ quota, user }: { quota?: Quota; user: User }) {
  const { t, i18n } = useTranslation();
  if (typeof quota?.limit !== "number") {
    return null;
  }
  return (
    <div className="quota-line">
      <p className="quota-note" role="status">
        <strong>{t("quotaLeft", { remaining: quota.remaining, limit: quota.limit })}</strong>
        {quota.remaining === 0 && quota.resetsAt && (
          <>
            {" "}
            {t("quotaResets", {
              date: formatDateTime(quota.resetsAt, i18n.language, timezoneOf(user)),
            })}
          </>
        )}
      </p>
      <WeeklyLimitInfo />
    </div>
  );
}
export type Crumb = { label: string; to: string };
/**
 * Where a page sits: the environment (the platform or the reseller), the page's ancestors as
 * links, and the page itself as the highlighted last step. Pages with a large title of their own
 * (an event, a request, an issue) name themselves here too.
 */
export function Breadcrumbs({ trail = [], current }: { trail?: Crumb[]; current?: string }) {
  const { t } = useTranslation();
  const home = useQueryClient().getQueryData<User | null>(["me"])?.tenant?.name ?? "Pedirr";
  return (
    <nav className="breadcrumbs" aria-label={t("breadcrumb")}>
      <ol>
        {[{ label: home, to: "/" }, ...trail].map((crumb, index) => (
          <li key={index}>
            <Link to={crumb.to}>{crumb.label}</Link>
          </li>
        ))}
        {current && (
          <li className="crumb-current" aria-current="page">
            {current}
          </li>
        )}
      </ol>
    </nav>
  );
}
/**
 * A page's title as the last, highlighted step of its breadcrumbs, so the name is not repeated on
 * a line of its own. A short description can follow on one line; actions belong to the content.
 */
export function PageHeader({
  title,
  trail,
  children,
}: {
  title: string;
  trail?: Crumb[];
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-path">
        <Breadcrumbs trail={trail} />
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}
export function Loading() {
  const { t } = useTranslation();
  return (
    <p role="status" className="notice">
      {t("loading")}
    </p>
  );
}
export function Status({ value }: { value: string }) {
  const { t } = useTranslation();
  return <span className={"status status-" + value.toLowerCase()}>{t(value)}</span>;
}
export function Pager({
  page,
  more,
  onChange,
}: {
  page: number;
  more: boolean;
  onChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="pager" aria-label={t("page", { page })}>
      <button className="quiet" disabled={page === 1} onClick={() => onChange(page - 1)}>
        {t("previous")}
      </button>
      <span>{t("page", { page })}</span>
      <button className="quiet" disabled={!more} onClick={() => onChange(page + 1)}>
        {t("next")}
      </button>
    </nav>
  );
}
export function Artwork({ item, kind = "league" }: { item: Item; kind?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const candidates =
    kind === "event"
      ? [item.thumbUrl, item.imageUrl, item.posterUrl, item.logoUrl]
      : [item.logoUrl, item.imageUrl, item.thumbUrl, item.posterUrl];
  const image = candidates.find(
    (value) => typeof value === "string" && /^https?:\/\//.test(value) && !failed.includes(value),
  );
  const photo = !image || (kind === "event" && image !== item.logoUrl);
  return (
    <span
      className={`artwork ${photo ? "artwork-photo" : "artwork-logo"}${image ? "" : " artwork-default"}`}
      aria-hidden="true"
    >
      <img
        src={image ?? "/images/artwork-default.svg"}
        alt=""
        loading="lazy"
        decoding="async"
        onError={image ? () => setFailed((previous) => [...previous, image]) : undefined}
      />
    </span>
  );
}

export function Fixture({
  item,
  kind = "event",
  headingLevel = 3,
  timezone,
  showDate = true,
}: {
  item: Item;
  kind?: string;
  headingLevel?: 2 | 3;
  timezone: string;
  /** Off where a heading already names the day. */
  showDate?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const date = item.scheduledStart ? new Date(item.scheduledStart) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return (
    <Link className={`fixture fixture-${kind}`} to={`/catalog/${kind}/${item.id}`}>
      <Artwork item={item} kind={kind} />
      <div className="fixture-body">
        <p className="fixture-meta">
          {item.leagueName ?? item.sportName ?? item.country ?? t(kind)}
        </p>
        <Heading>{item.name}</Heading>
        {kind === "event" && (
          <p className="fixture-when">
            {valid ? (
              <>
                <time dateTime={date.toISOString()}>
                  {new Intl.DateTimeFormat(i18n.language, {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: timezone,
                  }).format(date)}
                </time>
                {showDate && (
                  <span>
                    {new Intl.DateTimeFormat(i18n.language, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      timeZone: timezone,
                    }).format(date)}
                  </span>
                )}
              </>
            ) : (
              <span>{t("dateUnknown")}</span>
            )}
          </p>
        )}
      </div>
    </Link>
  );
}

/**
 * Asks which parts of an event or season to request. Parts are listed in card order with their
 * current state; parts already on disk cannot be requested again.
 */
export function PartsDialog({
  parts,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  parts: PartOption[];
  busy: boolean;
  error: unknown;
  onConfirm: (parts: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState(
    () =>
      new Set(
        parts
          .filter((part) => part.selected && part.state !== "available")
          .map((part) => part.name),
      ),
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) {
      next.add(name);
    } else {
      next.delete(name);
    }
    setChosen(next);
  };
  return (
    <dialog ref={dialog} className="parts-dialog" aria-labelledby="parts-title" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm(parts.filter((part) => chosen.has(part.name)).map((part) => part.name));
        }}
      >
        <h2 id="parts-title">{t("chooseParts")}</h2>
        <p>{t("choosePartsHelp")}</p>
        <fieldset>
          <legend className="sr-only">{t("parts")}</legend>
          {parts.map((part, index) => {
            const available = part.state === "available";
            return (
              <label key={part.name} className={"part-option part-" + part.state}>
                <input
                  aria-labelledby={`part-${index}`}
                  aria-describedby={`part-${index}-state`}
                  type="checkbox"
                  checked={available || chosen.has(part.name)}
                  disabled={available || busy}
                  onChange={(event) => toggle(part.name, event.target.checked)}
                />
                <span className="part-name" id={`part-${index}`}>
                  {part.name}
                </span>
                <span className="part-state" id={`part-${index}-state`}>
                  {part.state === "none"
                    ? part.optional
                      ? t("partOptional")
                      : ""
                    : t(
                        {
                          requested: "partRequested",
                          downloading: "partDownloading",
                          available: "partAvailable",
                        }[part.state],
                      )}
                </span>
              </label>
            );
          })}
        </fieldset>
        <ErrorMessage error={error} />
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={() => dialog.current?.close()}>
            {t("cancel")}
          </button>
          <button disabled={busy || chosen.size === 0}>
            {t(busy ? "requestBusy" : "requestParts", { count: chosen.size })}
          </button>
        </div>
      </form>
    </dialog>
  );
}
