import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ApiError, type Item, type PartOption } from "./api";
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
}: {
  item: Item;
  kind?: string;
  headingLevel?: 2 | 3;
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const date = item.scheduledStart ? new Date(item.scheduledStart) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return (
    <Link className={`fixture fixture-${kind}`} to={`/catalog/${kind}/${item.id}`}>
      {kind === "event" ? (
        <div className="fixture-date">
          {valid ? (
            <>
              <strong>
                {new Intl.DateTimeFormat(i18n.language, {
                  day: "2-digit",
                  timeZone: timezone,
                }).format(date)}
              </strong>
              <span>
                {new Intl.DateTimeFormat(i18n.language, {
                  month: "short",
                  year: "numeric",
                  timeZone: timezone,
                }).format(date)}
              </span>
            </>
          ) : (
            <span>{t("dateUnknown")}</span>
          )}
        </div>
      ) : null}
      <Artwork item={item} kind={kind} />
      <div className="fixture-name">
        <Heading>{item.name}</Heading>
        <p>{item.leagueName ?? item.sportName ?? item.country ?? t(kind)}</p>
      </div>
      {valid ? (
        <time dateTime={date.toISOString()}>
          {new Intl.DateTimeFormat(i18n.language, {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: timezone,
          }).format(date)}
        </time>
      ) : null}
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
