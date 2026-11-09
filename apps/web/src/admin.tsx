import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, client, type User } from "./api";
import { ErrorMessage, Loading, Pager } from "./ui";

function Toggle({ name, checked }: { name: string; checked: boolean }) {
  const { t } = useTranslation();
  return (
    <label className="check">
      <input name={name} type="checkbox" defaultChecked={checked} />
      {t(name)}
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
  if (user.role !== "ADMIN") return <p role="alert">{t("unauthorized")}</p>;
  return (
    <>
      <header className="page-heading">
        <h1>{t("admin")}</h1>
      </header>
      <nav className="tabs admin-tabs" aria-label={t("admin")}>
        {["users", "policies", "sportarr", "notifications"].map((item) => (
          <button
            key={item}
            className={tab === item ? "selected" : ""}
            onClick={() => setParams({ tab: item })}
          >
            {t(item)}
          </button>
        ))}
      </nav>
      {tab === "users" ? (
        <Users />
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
function Users() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const users = useQuery({
    queryKey: ["users", page],
    queryFn: () => api<{ items: User[]; total: number }>(`/admin/users?page=${page}`),
  });
  return (
    <>
      <div className="section-actions">
        <h2>{t("users")}</h2>
        <Link className="button-link" to="/admin/users/new">
          {t("createUser")}
        </Link>
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.error ? (
        <ErrorMessage error={users.error} />
      ) : (
        <div className="user-list">
          {users.data?.items.map((user) => (
            <Link className="user-row" key={user.id} to={`/admin/users/${user.id}`}>
              <strong>{user.email}</strong>
              <span>{t(user.role)}</span>
              <span>{t(user.active ? "active" : "inactive")}</span>
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
          role: data.get("role"),
          active: data.has("active"),
          autoApprove: approval === "inherit" ? null : approval === "true",
        });
      }}
    >
      <p>{user.email}</p>
      <div className="user-controls">
        <label>
          {t("role")}
          <select name="role" defaultValue={user.role}>
            <option value="USER">{t("USER")}</option>
            <option value="ADMIN">{t("ADMIN")}</option>
          </select>
        </label>
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
  if (user.role !== "ADMIN") return <p role="alert">{t("unauthorized")}</p>;
  return (
    <>
      <Link className="back" to="/admin?tab=users">
        {t("users")}
      </Link>
      <header className="page-heading">
        <h1>{t(creating ? "createUser" : "editUser")}</h1>
      </header>
      {creating ? (
        <form
          className="panel compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            create.mutate({ email: data.get("email"), password: data.get("password") });
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
  if (policy.isPending) return <Loading />;
  if (policy.error) return <ErrorMessage error={policy.error} />;
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
  url: string;
  rootFolderId: number | null;
  qualityProfileId: number | null;
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
  const credentials = (form: HTMLFormElement) => {
    const data = new FormData(form);
    return {
      url: String(data.get("url")),
      ...(data.get("apiKey") ? { apiKey: String(data.get("apiKey")) } : {}),
    };
  };
  if (settings.isPending) return <Loading />;
  if (settings.error) return <ErrorMessage error={settings.error} />;
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
          <select name="rootFolderId" defaultValue={settings.data!.rootFolderId ?? ""} required>
            <option value="">{t("selectOption")}</option>
            {!connection && settings.data!.rootFolderId && (
              <option value={settings.data!.rootFolderId}>{t("currentSelection")}</option>
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
            required
          >
            <option value="">{t("selectOption")}</option>
            {!connection && settings.data!.qualityProfileId && (
              <option value={settings.data!.qualityProfileId}>{t("currentSelection")}</option>
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
};
function NotificationSettings() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["notification-settings"],
    queryFn: () => api<NotificationsConfig>("/admin/settings/notifications"),
  });
  const deliveries = useQuery({
    queryKey: ["deliveries"],
    queryFn: () =>
      api<
        {
          id: string;
          channel: string;
          recipient: string;
          status: string;
          attempts: number;
        }[]
      >("/admin/settings/notifications/deliveries"),
  });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<NotificationsConfig>("/admin/settings/notifications", "PUT", body),
    onSuccess: (value) => client.setQueryData(["notification-settings"], value),
  });
  if (settings.isPending) return <Loading />;
  if (settings.error) return <ErrorMessage error={settings.error} />;
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
          body.smtpPort = Number(data.get("smtpPort"));
          if (!body.smtpPassword) delete body.smtpPassword;
          if (!body.discordWebhook) delete body.discordWebhook;
          save.mutate(body, {
            onSuccess: () => {
              for (const name of ["smtpPassword", "discordWebhook"])
                (form.elements.namedItem(name) as HTMLInputElement).value = "";
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
                    <td>{item.channel === "email" ? t("email") : "Discord"}</td>
                    <td>{item.channel === "discord" ? t("discordDestination") : item.recipient}</td>
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
