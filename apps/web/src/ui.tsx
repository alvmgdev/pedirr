import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ApiError, type Item } from "./api";
export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const keys: Record<string, string> = {
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
export function Fixture({
  item,
  kind = "event",
  timezone,
}: {
  item: Item;
  kind?: string;
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  const date = item.scheduledStart ? new Date(item.scheduledStart) : null;
  const valid = date && !Number.isNaN(date.getTime());
  const image = item.logoUrl ?? item.imageUrl;
  const safeImage = image && /^https?:\/\//.test(image) ? image : undefined;
  return (
    <Link className="fixture" to={`/catalog/${kind}/${item.id}`}>
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
      ) : (
        <div className="fixture-emblem">
          {safeImage ? (
            <img
              src={safeImage}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : (
            <span aria-hidden="true">{item.name.slice(0, 2)}</span>
          )}
        </div>
      )}
      <div className="fixture-name">
        <h3>{item.name}</h3>
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
