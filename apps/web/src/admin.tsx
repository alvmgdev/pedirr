import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
/** Turns a channel on or off, with a line on what it sends. */
function SwitchRow({ name, checked, hint }: { name: string; checked: boolean; hint: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <label className="switch-row">
      <span className="switch-copy">
        <span className="switch-label" id={`${id}-label`}>
          {t(name)}
        </span>
        <span className="muted" id={`${id}-hint`}>
          {hint}
        </span>
      </span>
      <input
        className="switch"
        name={name}
        type="checkbox"
        role="switch"
        defaultChecked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
      />
    </label>
  );
}
type Channel = "email" | "discord" | "telegram";
const channelIcons: Record<Channel, ReactNode> = {
  email: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="m3 6 7 5 7-5" />
    </>
  ),
  discord: <path d="M4 5.5h12v8H9l-3.5 3v-3H4z" />,
  telegram: (
    <>
      <path d="m17 3.5-14 5.5 4.5 1.7L9 16l2.6-3.7 3.9 2.7z" />
      <path d="m7.5 10.7 6-4.2" />
    </>
  ),
};
/** Tabs for the channels, each showing whether it is on; arrow keys move between them. */
function ChannelTabs({
  channels,
  selected,
  onSelect,
}: {
  channels: { id: Channel; label: string; on: boolean }[];
  selected: Channel;
  onSelect: (channel: Channel) => void;
}) {
  const { t } = useTranslation();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={t("channels")} className="channel-tabs">
      {channels.map((channel, index) => (
        <button
          key={channel.id}
          ref={(element) => {
            tabs.current[index] = element;
          }}
          type="button"
          role="tab"
          id={`channel-tab-${channel.id}`}
          aria-selected={selected === channel.id}
          aria-controls={`channel-${channel.id}`}
          tabIndex={selected === channel.id ? 0 : -1}
          onClick={() => onSelect(channel.id)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (step) {
              event.preventDefault();
              const next = (index + step + channels.length) % channels.length;
              onSelect(channels[next].id);
              tabs.current[next]?.focus();
            }
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            {channelIcons[channel.id]}
          </svg>
          {channel.label}
          <span className={`channel-state${channel.on ? " on" : ""}`}>
            <span className="channel-state-text">{t(channel.on ? "channelOn" : "channelOff")}</span>
          </span>
        </button>
      ))}
    </div>
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
/** The administration sections, grouped as the side menu shows them. */
const ADMIN_SECTIONS = [
  ["adminAccounts", ["users", "resellers"]],
  ["adminContent", ["plans", "packages"]],
  ["adminPlatform", ["policies", "sportarr", "notifications"]],
] as const;
/** The sections whose title row offers creating one more. */
const ADMIN_CREATE: Record<string, [string, string]> = {
  users: ["/admin/users/new", "createUser"],
  resellers: ["/admin/resellers/new", "createReseller"],
  plans: ["/admin/plans/new", "createPlan"],
  packages: ["/admin/packages/new", "createPackage"],
};
export function Administration({ user }: { user: User }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "users";
  const menu = useRef<HTMLElement>(null);
  // On narrow screens the menu is one scrolling row: keep the open section in view.
  useEffect(() => {
    menu.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={t(tab)}
        trail={[{ label: t("admin"), to: "/admin" }]}
        actions={
          tab in ADMIN_CREATE && (
            <Link className="button-link" to={ADMIN_CREATE[tab][0]}>
              {t(ADMIN_CREATE[tab][1])}
            </Link>
          )
        }
      />
      <div className="admin-layout">
        <nav className="admin-menu" aria-label={t("admin")} ref={menu}>
          {ADMIN_SECTIONS.map(([group, items]) => (
            <div key={group} className="admin-menu-group">
              <h2>{t(group)}</h2>
              <ul>
                {items.map((item) => (
                  <li key={item}>
                    <Link
                      to={`/admin?tab=${item}`}
                      aria-current={tab === item ? "page" : undefined}
                    >
                      {t(item)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="admin-content">
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
        </div>
      </div>
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
  hidden,
}: {
  value: NotificationsConfig;
  base: string;
  platform: boolean;
  hidden: boolean;
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
    <section
      role="tabpanel"
      id="channel-telegram"
      aria-labelledby="channel-tab-telegram"
      className="channel-panel"
      hidden={hidden}
    >
      {available && (
        <SwitchRow
          name="telegramEnabled"
          checked={value.telegramEnabled}
          hint={t("telegramEnabledHint")}
        />
      )}
      {!available && !platform && <p className="notice">{t("telegramNotAvailable")}</p>}
      {(platform || available) && (
        <div className="field-grid">
          {platform && (
            <div className="field-with-hint">
              <Field name="telegramToken" type="password" secret />
              <p className="muted">
                {value.telegramBot
                  ? t("telegramBotIs", { bot: value.telegramBot })
                  : t("telegramTokenHint")}
              </p>
            </div>
          )}
          {available && (
            <label>
              {t("telegramLocale")}
              <select name="telegramLocale" defaultValue={value.telegramLocale}>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
          )}
        </div>
      )}
      {available && (
        <section className="linked-chat-section" aria-labelledby="telegram-chat-title">
          <h2 id="telegram-chat-title">{t("telegramChatHeading")}</h2>
          {link ? (
            <div className="telegram-steps" role="status">
              <p>{t("telegramStepAdd", { bot: link.bot })}</p>
              <p>{t("telegramStepPost")}</p>
              <code>/link {link.code}</code>
              <p className="muted">{t("telegramWaiting")}</p>
            </div>
          ) : (
            <div className="linked-chat">
              <span className="linked-chat-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <circle cx="7" cy="7" r="3" />
                  <circle cx="14" cy="8" r="2.4" />
                  <path d="M2 16c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3M12.5 12c2.2-.3 4.6.8 5.5 3.5" />
                </svg>
              </span>
              <p className="linked-chat-name">
                {chat ? (
                  <>
                    <strong>{chat.title}</strong>
                    <span>{t("telegramLinkedHint")}</span>
                  </>
                ) : (
                  <span>{t("telegramNotLinked")}</span>
                )}
              </p>
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
                  className="text-danger"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate()}
                >
                  {t("telegramUnlink")}
                </button>
              )}
            </div>
          )}
          <ErrorMessage error={start.error ?? unlink.error} />
        </section>
      )}
    </section>
  );
}
/**
 * Email, Discord and Telegram settings, a tab each: the platform's at
 * /admin/settings/notifications, a reseller's own at /reseller/notifications. The tabs share one
 * form, so switching tabs keeps what was typed and one save covers all three.
 */
export function NotificationSettings({
  base = "/admin/settings/notifications",
}: {
  base?: string;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<Channel>("email");
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
      <ChannelTabs
        selected={channel}
        onSelect={setChannel}
        channels={[
          { id: "email", label: t("email"), on: value.emailEnabled },
          { id: "discord", label: "Discord", on: value.discordEnabled },
          {
            id: "telegram",
            label: "Telegram",
            on: value.telegramEnabled && Boolean(value.telegramChat && value.telegramBot),
          },
        ]}
      />
      <p className="muted channel-help">{t("notificationHelp")}</p>
      <form
        className="channel-form"
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
        <section
          role="tabpanel"
          id="channel-email"
          aria-labelledby="channel-tab-email"
          className="channel-panel"
          hidden={channel !== "email"}
        >
          <SwitchRow
            name="emailEnabled"
            checked={value.emailEnabled}
            hint={t("emailEnabledHint")}
          />
          <div className="field-grid">
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
        <section
          role="tabpanel"
          id="channel-discord"
          aria-labelledby="channel-tab-discord"
          className="channel-panel"
          hidden={channel !== "discord"}
        >
          <SwitchRow
            name="discordEnabled"
            checked={value.discordEnabled}
            hint={t("discordEnabledHint")}
          />
          <div className="field-grid">
            <Field name="discordWebhook" type="password" secret />
            <label>
              {t("discordLocale")}
              <select name="discordLocale" defaultValue={value.discordLocale}>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
          </div>
        </section>
        <TelegramSettings
          value={value}
          base={base}
          platform={base === "/admin/settings/notifications"}
          hidden={channel !== "telegram"}
        />
        <div className="form-actions">
          <Feedback pending={save.isPending} error={save.error} saved={save.isSuccess} />
          <p className="muted">{t("credentialsHint")}</p>
        </div>
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
