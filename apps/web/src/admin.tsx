import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, client, isExpired, type User } from "./api";
import { ErrorMessage, Loading, PageHeader, Pager } from "./ui";
import { limits, UserLimits } from "./fields";
import { Plans, usePlans } from "./plans";
import { Packages, Resellers, useResellerPlans, useResellers } from "./resellers";

function Toggle({ name, checked }: { name: string; checked: boolean }) {
  const { t } = useTranslation();
  return (
    <label className="check">
      <input name={name} type="checkbox" defaultChecked={checked} />
      {t(name)}
    </label>
  );
}
/** Which plan the user is on; "No plan" lets them request everything. */
/**
 * Which plan the user is on. At the platform, "No plan" lets them request everything; a
 * reseller's clients only get plans of the reseller's package, and without one request nothing.
 */
function PlanSelect({ user }: { user?: User }) {
  const { t } = useTranslation();
  const reseller = user?.tenant.code ? user.tenantId : undefined;
  const platformPlans = usePlans(!reseller);
  const resellerPlans = useResellerPlans(reseller);
  const pending = reseller ? resellerPlans.pending : platformPlans.isPending;
  const options = reseller ? resellerPlans.plans : (platformPlans.data ?? []);
  return (
    <label>
      {t("plan")}
      <select
        name="planId"
        defaultValue={user?.plan?.id ?? ""}
        aria-describedby="plan-hint"
        disabled={pending}
        key={pending ? "loading" : "ready"}
      >
        <option value="">{t(reseller ? "noPlanReseller" : "noPlan")}</option>
        {options.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.name}
          </option>
        ))}
      </select>
      <span className="muted field-hint" id="plan-hint">
        {reseller
          ? resellerPlans.packageName
            ? t("planHintReseller", { name: resellerPlans.packageName })
            : t("resellerWithoutPackage")
          : t("planHint")}
      </span>
      <ErrorMessage error={reseller ? resellerPlans.error : platformPlans.error} />
    </label>
  );
}
function Field({
  name,
  value = "",
  type = "text",
  required = false,
  secret = false,
}: {
  name: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  secret?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label>
      {t(name)}
      <input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        autoComplete={secret ? "new-password" : undefined}
        min={type === "number" ? 1 : undefined}
      />
      {secret && <small>{t("keepSecret")}</small>}
    </label>
  );
}
function Feedback({ pending, error, saved }: { pending: boolean; error: unknown; saved: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <ErrorMessage error={error} />
      {saved && !pending && (
        <p role="status" className="notice">
          {t("saved")}
        </p>
      )}
      <button disabled={pending}>{t(pending ? "loading" : "save")}</button>
    </>
  );
}
export function Administration({ user }: { user: User }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "users";
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <header className="page-heading">
        <h1>{t("admin")}</h1>
      </header>
      <nav className="tabs admin-tabs" aria-label={t("admin")}>
        {["users", "resellers", "plans", "packages", "policies", "sportarr", "notifications"].map(
          (item) => (
            <button
              key={item}
              className={tab === item ? "selected" : ""}
              onClick={() => setParams({ tab: item })}
            >
              {t(item)}
            </button>
          ),
        )}
      </nav>
      {tab === "users" ? (
        <Users />
      ) : tab === "resellers" ? (
        <Resellers />
      ) : tab === "plans" ? (
        <Plans />
      ) : tab === "packages" ? (
        <Packages />
      ) : tab === "policies" ? (
        <Policies />
      ) : tab === "sportarr" ? (
        <SportarrSettings />
      ) : tab === "notifications" ? (
        <NotificationSettings />
      ) : (
        <p>{t("notFound")}</p>
      )}
    </>
  );
}
/** Where an account lives: the platform or a reseller's name. */
const environmentName = (user: User, platform: string) =>
  user.tenant.code ? user.tenant.name : platform;

function Users() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [tenant, setTenant] = useState("");
  const resellers = useResellers();
  const path = `/admin/users?page=${page}${tenant ? `&tenant=${tenant}` : ""}`;
  const users = useQuery({
    queryKey: ["users", page, tenant],
    queryFn: () => api<{ items: User[]; total: number }>(path),
  });
  return (
    <>
      <div className="section-actions">
        <h2>{t("users")}</h2>
        <Link className="button-link" to="/admin/users/new">
          {t("createUser")}
        </Link>
      </div>
      <label className="sort-control">
        {t("environment")}
        <select
          value={tenant}
          onChange={(event) => {
            setTenant(event.currentTarget.value);
            setPage(1);
          }}
        >
          <option value="">{t("allEnvironments")}</option>
          <option value="platform">{t("platform")}</option>
          {resellers.data?.map((reseller) => (
            <option key={reseller.id} value={reseller.id}>
              {reseller.name}
            </option>
          ))}
        </select>
      </label>
      {users.isPending ? (
        <Loading />
      ) : users.error ? (
        <ErrorMessage error={users.error} />
      ) : (
        <div className="user-list">
          {users.data?.items.map((user) => (
            <Link className="user-row account-row" key={user.id} to={`/admin/users/${user.id}`}>
              <strong>{user.email}</strong>
              <span>{environmentName(user, t("platform"))}</span>
              <span>
                {user.role === "USER" ? (user.plan?.name ?? t("noPlanShort")) : t(user.role)}
              </span>
              <span>{t(!user.active ? "inactive" : isExpired(user) ? "expired" : "active")}</span>
              <span>{t("editUser")}</span>
            </Link>
          ))}
        </div>
      )}
      <Pager page={page} more={page * 50 < (users.data?.total ?? 0)} onChange={setPage} />
    </>
  );
}
function UserEditor({ user }: { user: User }) {
  const { t } = useTranslation();
  const reseller = user.tenant.code !== null;
  const update = useMutation({
    mutationFn: (body: unknown) => api(`/admin/users/${user.id}`, "PATCH", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["me"] });
      void client.invalidateQueries({ queryKey: ["user", user.id] });
    },
  });
  return (
    <form
      className="panel compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const approval = data.get("autoApprove");
        update.mutate({
          // A reseller's accounts keep their role.
          ...(reseller ? {} : { role: data.get("role") }),
          active: data.has("active"),
          autoApprove: approval === "inherit" ? null : approval === "true",
          ...limits(data),
        });
      }}
    >
      <p>{user.email}</p>
      <dl className="account-facts">
        <div>
          <dt>{t("environment")}</dt>
          <dd>{environmentName(user, t("platform"))}</dd>
        </div>
        {reseller && (
          <div>
            <dt>{t("role")}</dt>
            <dd>{t(user.role)}</dd>
          </div>
        )}
      </dl>
      <div className="user-controls">
        {!reseller && (
          <label>
            {t("role")}
            <select name="role" defaultValue={user.role} aria-describedby="role-hint">
              <option value="USER">{t("USER")}</option>
              <option value="ADMIN">{t("ADMIN")}</option>
            </select>
            <span className="muted field-hint" id="role-hint">
              {t("roleHint")}
            </span>
          </label>
        )}
        <label>
          {t("autoApprove")}
          <select
            name="autoApprove"
            defaultValue={user.autoApprove === null ? "inherit" : String(user.autoApprove)}
          >
            <option value="inherit">{t("inherit")}</option>
            <option value="true">{t("always")}</option>
            <option value="false">{t("never")}</option>
          </select>
        </label>
        <Toggle name="active" checked={user.active} />
        <PlanSelect user={user} />
        <UserLimits user={user} />
        <button disabled={update.isPending}>{t("save")}</button>
      </div>
      <ErrorMessage error={update.error} />
      {update.isSuccess && (
        <p className="notice" role="status">
          {t("saved")}
        </p>
      )}
    </form>
  );
}
export function UserDetail({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const creating = id === "new";
  const detail = useQuery({
    queryKey: ["user", id],
    queryFn: () => api<User>(`/admin/users/${id}`),
    enabled: user.role === "ADMIN" && !creating,
  });
  const create = useMutation({
    mutationFn: (body: unknown) => api<User>("/admin/users", "POST", body),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["users"] });
      navigate(`/admin/users/${value.id}`, { replace: true });
    },
  });
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={t(creating ? "createUser" : "editUser")}
        trail={[
          { label: t("admin"), to: "/admin" },
          { label: t("users"), to: "/admin?tab=users" },
        ]}
      />
      {creating ? (
        <form
          className="panel compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            create.mutate({
              email: data.get("email"),
              password: data.get("password"),
              ...limits(data),
            });
          }}
        >
          <Field name="email" type="email" required />
          <label>
            {t("password")}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <p className="muted">{t("passwordHint")}</p>
          <PlanSelect />
          <UserLimits />
          <ErrorMessage error={create.error} />
          <button disabled={create.isPending}>{t("createUser")}</button>
        </form>
      ) : detail.isPending ? (
        <Loading />
      ) : detail.error ? (
        <ErrorMessage error={detail.error} />
      ) : (
        <UserEditor key={id} user={detail.data!} />
      )}
    </>
  );
}
type Policy = {
  registrationEnabled: boolean;
  userAutoApprove: boolean;
  adminAutoApprove: boolean;
};
function Policies() {
  const { t } = useTranslation();
  const policy = useQuery({
    queryKey: ["policies"],
    queryFn: () => api<Policy>("/admin/policies"),
  });
  const save = useMutation({
    mutationFn: (body: unknown) => api<Policy>("/admin/policies", "PATCH", body),
    onSuccess: (value) => client.setQueryData(["policies"], value),
  });
  if (policy.isPending) {
    return <Loading />;
  }
  if (policy.error) {
    return <ErrorMessage error={policy.error} />;
  }
  return (
    <section className="panel compact-form">
      <h2>{t("policies")}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          save.mutate(
            Object.fromEntries(
              ["registrationEnabled", "userAutoApprove", "adminAutoApprove"].map((key) => [
                key,
                data.has(key),
              ]),
            ),
          );
        }}
      >
        {(Object.keys(policy.data!) as (keyof Policy)[]).map((key) => (
          <Toggle key={key + String(policy.data![key])} name={key} checked={policy.data![key]} />
        ))}
        <Feedback pending={save.isPending} error={save.error} saved={save.isSuccess} />
      </form>
    </section>
  );
}
type SportarrConfig = {
  configured: boolean;
  url: string;
  rootFolderId: number | null;
  qualityProfileId: number | null;
  /** Names as they were when saved, for display while Sportarr's lists load. */
  rootFolderPath: string | null;
  qualityProfileName: string | null;
  hasApiKey: boolean;
};
type Connection = {
  version: string;
  rootFolders: { id: number; path: string }[];
  qualityProfiles: { id: number; name: string }[];
};
function SportarrSettings() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["sportarr-settings"],
    queryFn: () => api<SportarrConfig>("/admin/settings/sportarr"),
  });
  const [connection, setConnection] = useState<Connection>();
  const test = useMutation({
    mutationFn: (body: unknown) => api<Connection>("/admin/settings/sportarr/test", "POST", body),
    onSuccess: setConnection,
  });
  const save = useMutation({
    mutationFn: (body: unknown) => api<SportarrConfig>("/admin/settings/sportarr", "PUT", body),
    onSuccess: (value) => {
      client.setQueryData(["sportarr-settings"], value);
    },
  });
  // The saved settings only hold IDs; ask Sportarr for its folders and profiles right away, so
  // the form shows their names without pressing "Test connection" first.
  const loaded = useRef(false);
  useEffect(() => {
    if (settings.data?.configured && !loaded.current) {
      loaded.current = true;
      test.mutate({ url: settings.data.url });
    }
  }, [settings.data, test]);
  /** The saved choice while Sportarr's lists are not available: its saved name, if known. */
  const saved = (name: string | null) =>
    name ? t("savedName", { name }) : t(test.isPending ? "loading" : "currentSelection");
  const credentials = (form: HTMLFormElement) => {
    const data = new FormData(form);
    return {
      url: String(data.get("url")),
      ...(data.get("apiKey") ? { apiKey: String(data.get("apiKey")) } : {}),
    };
  };
  if (settings.isPending) {
    return <Loading />;
  }
  if (settings.error) {
    return <ErrorMessage error={settings.error} />;
  }
  return (
    <section className="panel compact-form">
      <h2>{t("sportarr")}</h2>
      <p>{t("sportarrHelp")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          save.mutate(
            {
              ...credentials(form),
              rootFolderId: Number(data.get("rootFolderId")),
              qualityProfileId: Number(data.get("qualityProfileId")),
            },
            {
              onSuccess: () => {
                (form.elements.namedItem("apiKey") as HTMLInputElement).value = "";
              },
            },
          );
        }}
      >
        <Field name="url" type="url" value={settings.data!.url} required />
        <Field name="apiKey" type="password" secret />
        <button
          className="quiet"
          type="button"
          disabled={test.isPending}
          onClick={(event) => test.mutate(credentials(event.currentTarget.form!))}
        >
          {t(test.isPending ? "loading" : "testConnection")}
        </button>
        <ErrorMessage error={test.error} />
        {connection && (
          <p role="status" className="notice">
            {t("connected")} · {connection.version}
          </p>
        )}
        <label>
          {t("rootFolder")}
          <select
            name="rootFolderId"
            defaultValue={settings.data!.rootFolderId ?? ""}
            // Remount when the lists arrive so the saved choice stays selected.
            key={connection ? "loaded" : "saved"}
            required
          >
            <option value="">{t("selectOption")}</option>
            {!connection && settings.data!.rootFolderId && (
              <option value={settings.data!.rootFolderId}>
                {saved(settings.data!.rootFolderPath)}
              </option>
            )}
            {connection?.rootFolders.map((root) => (
              <option key={root.id} value={root.id}>
                {root.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("qualityProfile")}
          <select
            name="qualityProfileId"
            defaultValue={settings.data!.qualityProfileId ?? ""}
            key={connection ? "loaded" : "saved"}
            required
          >
            <option value="">{t("selectOption")}</option>
            {!connection && settings.data!.qualityProfileId && (
              <option value={settings.data!.qualityProfileId}>
                {saved(settings.data!.qualityProfileName)}
              </option>
            )}
            {connection?.qualityProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <Feedback pending={save.isPending} error={save.error} saved={save.isSuccess} />
      </form>
    </section>
  );
}
type NotificationsConfig = {
  emailEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  smtpUser: string;
  emailFrom: string;
  discordEnabled: boolean;
  discordLocale: string;
  telegramEnabled: boolean;
  telegramLocale: string;
  /** The platform bot's @username; null until the platform sets a bot. */
  telegramBot: string | null;
  hasTelegramToken: boolean;
  telegramChat: { title: string } | null;
  telegramLinkPending: boolean;
};
/**
 * Telegram: the platform sets one bot for everyone; each environment links its own group or
 * channel by posting a one-time code there.
 */
function TelegramSettings({
  value,
  base,
  platform,
}: {
  value: NotificationsConfig;
  base: string;
  platform: boolean;
}) {
  const { t } = useTranslation();
  const key = ["notification-settings", base];
  const [issued, setIssued] = useState<{ code: string; bot: string } | null>(null);
  // The code stays on screen until the server says it was used or expired.
  const link = value.telegramLinkPending ? issued : null;
  const start = useMutation({
    mutationFn: () => api<{ code: string; bot: string }>(`${base}/telegram/link`, "POST"),
    onSuccess: (code) => {
      client.setQueryData<NotificationsConfig>(key, (old) =>
        old ? { ...old, telegramLinkPending: true } : old,
      );
      setIssued(code);
    },
  });
  const unlink = useMutation({
    mutationFn: () => api<NotificationsConfig>(`${base}/telegram/link`, "DELETE"),
    onSuccess: (updated) => client.setQueryData(key, updated),
  });
  useQuery({
    queryKey: key,
    queryFn: () => api<NotificationsConfig>(base),
    enabled: link !== null,
    refetchInterval: 3000,
  });
  const chat = value.telegramChat;
  const available = Boolean(value.telegramBot);
  return (
    <section className="panel">
      <h2>Telegram</h2>
      <div className="form-stack">
        {platform && (
          <>
            <Field name="telegramToken" type="password" secret />
            <p className="muted">
              {value.telegramBot
                ? t("telegramBotIs", { bot: value.telegramBot })
                : t("telegramTokenHint")}
            </p>
          </>
        )}
        {!available && !platform && <p className="muted">{t("telegramNotAvailable")}</p>}
        {available && (
          <>
            <Toggle name="telegramEnabled" checked={value.telegramEnabled} />
            <label>
              {t("telegramLocale")}
              <select name="telegramLocale" defaultValue={value.telegramLocale}>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
            <p>{chat ? t("telegramLinked", { title: chat.title }) : t("telegramNotLinked")}</p>
            {link ? (
              <div className="telegram-steps" role="status">
                <p>{t("telegramStepAdd", { bot: link.bot })}</p>
                <p>{t("telegramStepPost")}</p>
                <code>/link {link.code}</code>
                <p className="muted">{t("telegramWaiting")}</p>
              </div>
            ) : (
              <div className="address-row">
                <button
                  type="button"
                  className="quiet"
                  disabled={start.isPending}
                  onClick={() => start.mutate()}
                >
                  {t(chat ? "telegramRelink" : "telegramLink")}
                </button>
                {chat && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate()}
                  >
                    {t("telegramUnlink")}
                  </button>
                )}
              </div>
            )}
            <ErrorMessage error={start.error ?? unlink.error} />
          </>
        )}
      </div>
    </section>
  );
}
/**
 * Email and Discord settings: the platform's at /admin/settings/notifications, a reseller's own
 * at /reseller/notifications.
 */
export function NotificationSettings({
  base = "/admin/settings/notifications",
}: {
  base?: string;
}) {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["notification-settings", base],
    queryFn: () => api<NotificationsConfig>(base),
  });
  const deliveries = useQuery({
    queryKey: ["deliveries", base],
    queryFn: () =>
      api<
        {
          id: string;
          channel: string;
          recipient: string;
          status: string;
          attempts: number;
        }[]
      >(`${base}/deliveries`),
  });
  const save = useMutation({
    mutationFn: (body: unknown) => api<NotificationsConfig>(base, "PUT", body),
    onSuccess: (value) => client.setQueryData(["notification-settings", base], value),
  });
  if (settings.isPending) {
    return <Loading />;
  }
  if (settings.error) {
    return <ErrorMessage error={settings.error} />;
  }
  const value = settings.data!;
  return (
    <>
      <p>{t("notificationHelp")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const body: Record<string, unknown> = Object.fromEntries(data);
          body.emailEnabled = data.has("emailEnabled");
          body.discordEnabled = data.has("discordEnabled");
          body.telegramEnabled = data.has("telegramEnabled");
          body.smtpPort = Number(data.get("smtpPort"));
          if (!body.smtpPassword) {
            delete body.smtpPassword;
          }
          if (!body.discordWebhook) {
            delete body.discordWebhook;
          }
          if (!body.telegramToken) {
            delete body.telegramToken;
          }
          save.mutate(body, {
            onSuccess: () => {
              for (const name of ["smtpPassword", "discordWebhook", "telegramToken"]) {
                const input = form.elements.namedItem(name) as HTMLInputElement | null;
                if (input) {
                  input.value = "";
                }
              }
            },
          });
        }}
      >
        <div className="form-columns">
          <section className="panel">
            <h2>{t("email")}</h2>
            <div className="form-stack">
              <Toggle name="emailEnabled" checked={value.emailEnabled} />
              <Field name="smtpHost" value={value.smtpHost} />
              <Field name="smtpPort" value={value.smtpPort} type="number" required />
              <label>
                {t("smtpSecurity")}
                <select name="smtpSecurity" defaultValue={value.smtpSecurity}>
                  {["starttls", "tls", "plain"].map((mode) => (
                    <option key={mode} value={mode}>
                      {t(mode)}
                    </option>
                  ))}
                </select>
              </label>
              <Field name="smtpUser" value={value.smtpUser} />
              <Field name="smtpPassword" type="password" secret />
              <Field name="emailFrom" type="email" value={value.emailFrom} />
            </div>
          </section>
          <section className="panel">
            <h2>Discord</h2>
            <div className="form-stack">
              <Toggle name="discordEnabled" checked={value.discordEnabled} />
              <Field name="discordWebhook" type="password" secret />
              <label>
                {t("discordLocale")}
                <select name="discordLocale" defaultValue={value.discordLocale}>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </label>
              <p className="muted">{t("credentialsHint")}</p>
            </div>
          </section>
          <TelegramSettings
            value={value}
            base={base}
            platform={base === "/admin/settings/notifications"}
          />
        </div>
        <Feedback pending={save.isPending} error={save.error} saved={save.isSuccess} />
      </form>
      <section className="delivery-list">
        <h2>{t("deliveryHistory")}</h2>
        <ErrorMessage error={deliveries.error} />
        {deliveries.isPending ? (
          <Loading />
        ) : !deliveries.data?.length ? (
          <p className="empty">{t("empty")}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {["channel", "recipient", "status", "attempts"].map((key) => (
                    <th key={key}>{t(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.channel === "email"
                        ? t("email")
                        : item.channel === "discord"
                          ? "Discord"
                          : "Telegram"}
                    </td>
                    <td>
                      {item.channel === "discord"
                        ? t("discordDestination")
                        : item.channel === "telegram"
                          ? t("telegramDestination")
                          : item.recipient}
                    </td>
                    <td>{t(item.status)}</td>
                    <td>{item.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
