import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, client, setSession, type User } from "./api";
import { ErrorMessage } from "./ui";
export function Language({ user }: { user?: User | null }) {
  const { t, i18n } = useTranslation();
  const change = useMutation({
    mutationFn: (locale: string) => api<User>("/me", "PATCH", { locale }),
    onSuccess: (user) => client.setQueryData(["me"], user),
  });
  return (
    <div className="language">
      <label htmlFor="language">{t("language")}</label>
      <select
        id="language"
        value={i18n.language.startsWith("es") ? "es" : "en"}
        onChange={(event) => {
          const locale = event.target.value;
          void i18n.changeLanguage(locale);
          if (user) change.mutate(locale);
        }}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
      <ErrorMessage error={change.error} />
    </div>
  );
}
export function Login() {
  const { t, i18n } = useTranslation();
  const [register, setRegister] = useState(false);
  const action = useMutation({
    mutationFn: async (body: { email: string; password: string }) => {
      if (register) await api("/auth/register", "POST", body);
      const user = await api<User>("/auth/login", "POST", body);
      return api<User>("/me", "PATCH", {
        locale: i18n.language.startsWith("es") ? "es" : "en",
        timezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? user.timezone,
      });
    },
    onSuccess: (user) => {
      setSession(user);
    },
  });
  return (
    <div className="login-page">
      <section className="login-story">
        <LinkBrand />
        <div>
          <h1>{t("welcome")}</h1>
          <p>{t("intro")}</p>
        </div>
        <div className="pitch" aria-hidden="true">
          <div className="pitch-circle" />
          <div className="pitch-box" />
        </div>
      </section>
      <main className="login-main">
        <Language />
        <div className="login-form">
          <h2>{t(register ? "register" : "login")}</h2>
          <p>{t("loginHelp")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              action.mutate({
                email: String(data.get("email")),
                password: String(data.get("password")),
              });
            }}
          >
            <label>
              {t("email")}
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              {t("password")}
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            {register && (
              <p className="muted">
                {t("passwordHint")} {t("registerHelp")}
              </p>
            )}
            <ErrorMessage error={action.error} />
            <button disabled={action.isPending}>
              {t(
                action.isPending ? "loading" : register ? "register" : "login",
              )}
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              setRegister(!register);
              action.reset();
            }}
          >
            {t(register ? "login" : "register")}
          </button>
        </div>
      </main>
    </div>
  );
}
export function LinkBrand() {
  return (
    <div className="brand">
      pedirr<span aria-hidden="true">/</span>
    </div>
  );
}
export function Account({ user }: { user: User }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const profile = useMutation({
    mutationFn: (body: unknown) => api<User>("/me", "PATCH", body),
    onSuccess: (updated) => {
      client.setQueryData(["me"], updated);
      setSaved(true);
    },
  });
  const password = useMutation({
    mutationFn: (body: unknown) => api("/me/password", "POST", body),
    onSuccess: () => {
      setSession(null);
    },
  });
  return (
    <>
      <header className="page-heading">
        <h1>{t("account")}</h1>
        <p>{user.email}</p>
      </header>
      <div className="form-columns">
        <section className="panel">
          <h2>{t("profile")}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              profile.mutate({
                timezone: String(
                  new FormData(event.currentTarget).get("timezone"),
                ),
              });
            }}
          >
            <label>
              {t("timezone")}
              <input
                name="timezone"
                defaultValue={user.timezone}
                required
                list="timezones"
              />
              <datalist id="timezones">
                {Intl.supportedValuesOf("timeZone").map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
            <ErrorMessage error={profile.error} />
            {saved && <p role="status">{t("saved")}</p>}
            <button disabled={profile.isPending}>{t("save")}</button>
          </form>
        </section>
        <section className="panel">
          <h2>{t("changePassword")}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              password.mutate({
                currentPassword: data.get("currentPassword"),
                newPassword: data.get("newPassword"),
              });
            }}
          >
            <label>
              {t("currentPassword")}
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            <label>
              {t("newPassword")}
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <p className="muted">{t("passwordHint")}</p>
            <ErrorMessage error={password.error} />
            <button disabled={password.isPending}>{t("changePassword")}</button>
          </form>
        </section>
      </div>
    </>
  );
}
