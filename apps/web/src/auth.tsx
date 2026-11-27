import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, setSession, type AuthConfig, type User } from "./api";
import { ErrorMessage, formatDateTime, PageHeader, QuotaNote, timezoneOf, useQuota } from "./ui";
import { LanguageMenu, LinkBrand } from "./shell";
export function Login() {
  const { t, i18n } = useTranslation();
  const [registerSelected, setRegister] = useState(false);
  // The server enforces the policy; this only hides an option that would be refused.
  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api<AuthConfig>("/auth/config"),
  });
  const registrationOpen = config.data?.registrationEnabled === true;
  const environment = config.data?.environment ?? null;
  const unknown = config.error instanceof ApiError && config.error.code === "TENANT_NOT_FOUND";
  const register = registerSelected && registrationOpen;
  const action = useMutation({
    mutationFn: async (body: { email: string; password: string }) => {
      if (register) {
        await api("/auth/register", "POST", body);
      }
      const user = await api<User>("/auth/login", "POST", body);
      return api<User>("/me", "PATCH", {
        locale: i18n.language.startsWith("es") ? "es" : "en",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? user.timezone,
      });
    },
    onSuccess: (user) => {
      setSession(user);
    },
    onError: (error) => {
      // An administrator may have closed registration after this page loaded.
      if (error instanceof ApiError && error.code === "REGISTRATION_CLOSED") {
        void config.refetch();
      }
    },
  });
  return (
    <main className="login-page">
      <section className="login-story">
        <LinkBrand />
        <div>
          {environment && <p className="environment-name">{environment.name}</p>}
          <h1>{t("welcome")}</h1>
          <p>{t("intro")}</p>
        </div>
        <div className="pitch" aria-hidden="true">
          <div className="pitch-circle" />
          <div className="pitch-box" />
        </div>
      </section>
      <div className="login-main">
        <LanguageMenu />
        {unknown ? (
          <div className="login-form" role="alert">
            <h2>{t("unknownEnvironment")}</h2>
            <p>{t("unknownEnvironmentHelp")}</p>
          </div>
        ) : environment && !environment.active ? (
          <div className="login-form" role="alert">
            <h2>{t("environmentDisabled")}</h2>
            <p>{t("environmentDisabledHelp", { name: environment.name })}</p>
          </div>
        ) : (
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
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
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
              {register && <p className="muted">{t("passwordHint")}</p>}
              <ErrorMessage error={action.error} />
              <button disabled={action.isPending}>
                {t(action.isPending ? "loading" : register ? "register" : "login")}
              </button>
            </form>
            {registrationOpen && (
              <button
                className="text-button"
                onClick={() => {
                  setRegister(!register);
                  action.reset();
                }}
              >
                {t(register ? "login" : "register")}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
/** What limits the account has, so users are not surprised by them. Hidden for administrators. */
function AccountLimits({ user }: { user: User }) {
  const { t, i18n } = useTranslation();
  const quota = useQuota(user);
  if (user.role !== "USER") {
    return null;
  }
  return (
    <section className="panel">
      <h2>{t("yourLimits")}</h2>
      {user.plan && <p>{t("yourPlan", { name: user.plan.name })}</p>}
      {typeof user.weeklyRequestLimit !== "number" ? (
        <p>{t("quotaUnlimited")}</p>
      ) : (
        <>
          {quota.error ? (
            <ErrorMessage error={quota.error} />
          ) : (
            <QuotaNote quota={quota.data} user={user} />
          )}
          <p className="muted">{t("quotaHelp")}</p>
        </>
      )}
      <p>
        {user.expiresAt
          ? t("accountExpiresOn", {
              date: formatDateTime(user.expiresAt, i18n.language, timezoneOf(user)),
            })
          : t("accountNeverExpires")}
      </p>
    </section>
  );
}
export function Account({ user }: { user: User }) {
  const { t } = useTranslation();
  const password = useMutation({
    mutationFn: (body: unknown) => api("/me/password", "POST", body),
    onSuccess: () => {
      setSession(null);
    },
  });
  return (
    <>
      <PageHeader title={t("account")}>
        <p>
          {user.email}
          <span className="header-note">{t("timezoneAuto", { timezone: timezoneOf(user) })}</span>
        </p>
      </PageHeader>
      <div className="account-cards">
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
        <AccountLimits user={user} />
      </div>
    </>
  );
}
