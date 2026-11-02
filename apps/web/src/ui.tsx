import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ApiError, type Item } from "./api";
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
    EMAIL_UNAVAILABLE: "emailUnavailable",
    CONNECTION_FAILED: "connectionError",
  };
  return error ? (
    <p role="alert" className="notice danger">
      {t(error instanceof ApiError ? (keys[error.code] ?? "error") : "error")}
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
  return (
    <span className={"status status-" + value.toLowerCase()}>{t(value)}</span>
  );
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
      <button
        className="quiet"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
      >
        {t("previous")}
      </button>
      <span>{t("page", { page })}</span>
      <button
        className="quiet"
        disabled={!more}
        onClick={() => onChange(page + 1)}
      >
        {t("next")}
      </button>
    </nav>
  );
}
export function Artwork({ item, kind = "league" }: { item: Item; kind?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const candidates = kind === "event"
    ? [item.thumbUrl, item.imageUrl, item.posterUrl, item.logoUrl]
    : [item.logoUrl, item.imageUrl, item.thumbUrl, item.posterUrl];
  const image = candidates.find(value => typeof value === "string" && /^https?:\/\//.test(value) && !failed.includes(value));
  const photo = !image || (kind === "event" && image !== item.logoUrl);
  return (
    <span className={`artwork ${photo ? "artwork-photo" : "artwork-logo"}${image ? "" : " artwork-default"}`} aria-hidden="true">
      <img
        src={image ?? "/images/sports-default.webp"}
        alt=""
        loading="lazy"
        decoding="async"
        onError={image ? () => setFailed(previous => [...previous, image]) : undefined}
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
      ) : (
        <span className="fixture-kind">{t(kind)}</span>
      )}
    </Link>
  );
}
