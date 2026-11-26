import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "./api";

/** A date input value (local calendar day) for an instant, and back as the end of that day. */
export const toDay = (value: string) => {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
export const endOfDay = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();
/**
 * An optional limit: switched off it means no limit, switched on it asks for the value. The
 * explanation stays visible under the switch so it also works on touch screens.
 */
export function OptionalLimit({
  name,
  type,
  value,
  max = 1000,
}: {
  /** Field name and translation key prefix (`<name>`, `<name>On`, `<name>Off`, `<name>Value`). */
  name: string;
  type: "number" | "date";
  value: string;
  /** Largest number accepted. */
  max?: number;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(value !== "");
  const id = useId();
  return (
    <div className="optional-limit">
      <label className="check">
        <input
          name={name + "Enabled"}
          type="checkbox"
          checked={enabled}
          aria-describedby={id + "-hint"}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        {t(name)}
      </label>
      <p className="muted" id={id + "-hint"}>
        {t(name + (enabled ? "On" : "Off"))}
      </p>
      {enabled && (
        <label>
          {t(name + "Value")}
          <input
            name={name}
            type={type}
            defaultValue={value}
            required
            {...(type === "number" ? { min: 0, max, step: 1, inputMode: "numeric" } : {})}
          />
        </label>
      )}
    </div>
  );
}
/** Reads the optional limits back from a user form; a switched-off limit is sent as null. */
export const limits = (data: FormData) => ({
  planId: data.get("planId") ? String(data.get("planId")) : null,
  weeklyRequestLimit: data.has("weeklyRequestLimitEnabled")
    ? Number(data.get("weeklyRequestLimit"))
    : null,
  expiresAt: data.has("expiresAtEnabled") ? endOfDay(String(data.get("expiresAt"))) : null,
});
export function UserLimits({ user }: { user?: User }) {
  const { t } = useTranslation();
  return (
    <fieldset className="limits">
      <legend>{t("limits")}</legend>
      <p className="muted">{t("limitsHint")}</p>
      <OptionalLimit
        name="weeklyRequestLimit"
        type="number"
        value={
          user?.weeklyRequestLimit === null || user?.weeklyRequestLimit === undefined
            ? ""
            : String(user.weeklyRequestLimit)
        }
      />
      <OptionalLimit
        name="expiresAt"
        type="date"
        value={user?.expiresAt ? toDay(user.expiresAt) : ""}
      />
    </fieldset>
  );
}
