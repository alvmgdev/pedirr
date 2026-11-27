import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, client, isExpired, type User } from "./api";
import { limits, UserLimits } from "./fields";
import { Address } from "./resellers";
import { NotificationSettings } from "./admin";
import { ErrorMessage, Loading, PageHeader, Pager } from "./ui";
import { useState } from "react";

/** What a reseller administrator knows about its own reseller. */
type Overview = {
  code: string;
  name: string;
  maxUsers: number | null;
  package: { id: string; name: string; plans: { id: string; name: string }[] } | null;
  clients: number;
};
const useOverview = () =>
  useQuery({ queryKey: ["reseller-overview"], queryFn: () => api<Overview>("/reseller/overview") });

/** The reseller administrator's panel: its address, package and clients. */
export function ResellerPanel() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "notifications" ? "notifications" : "clients";
  const overview = useOverview();
  const [page, setPage] = useState(1);
  const clients = useQuery({
    queryKey: ["clients", page],
    queryFn: () => api<{ items: User[]; total: number }>(`/reseller/clients?page=${page}`),
  });
  if (overview.isPending) {
    return <Loading />;
  }
  if (overview.error) {
    return <ErrorMessage error={overview.error} />;
  }
  const info = overview.data;
  const full = info.maxUsers !== null && info.clients >= info.maxUsers;
  return (
    <>
      <header className="page-heading">
        <h1>{info.name}</h1>
        <p>{t("resellerPanelIntro")}</p>
      </header>
      <nav className="tabs admin-tabs" aria-label={t("admin")}>
        {(["clients", "notifications"] as const).map((item) => (
          <button
            key={item}
            className={tab === item ? "selected" : ""}
            onClick={() => setParams({ tab: item })}
          >
            {t(item === "clients" ? "clientsTitle" : "notifications")}
          </button>
        ))}
      </nav>
      {tab === "notifications" ? (
        <>
          <p className="muted">{t("resellerNotificationsHint")}</p>
          <NotificationSettings base="/reseller/notifications" />
        </>
      ) : (
        <div className="form-stack">
          <Address code={info.code} hint="clientAddressHint" />
          <section className="panel">
            <h2>{t("yourPackage")}</h2>
            {info.package ? (
              <>
                <p>{info.package.name}</p>
                <p className="muted">
                  {info.package.plans.map((plan) => plan.name).join(", ") || t("noPlansInPackage")}
                </p>
              </>
            ) : (
              <p className="muted">{t("noPackageYet")}</p>
            )}
          </section>
          <section>
            <div className="section-actions">
              <h2>{t("clientsTitle")}</h2>
              {full ? (
                <span className="muted">{t("clientLimitReached")}</span>
              ) : (
                <Link className="button-link" to="/admin/clients/new">
                  {t("createClient")}
                </Link>
              )}
            </div>
            <p className="muted">
              {info.maxUsers === null
                ? t("clients", { count: info.clients })
                : t("clientsOf", { count: info.clients, max: info.maxUsers })}
            </p>
            {clients.isPending ? (
              <Loading />
            ) : clients.error ? (
              <ErrorMessage error={clients.error} />
            ) : clients.data.items.length === 0 ? (
              <p className="empty">{t("noClients")}</p>
            ) : (
              <div className="user-list">
                {clients.data.items.map((item) => (
                  <Link className="user-row" key={item.id} to={`/admin/clients/${item.id}`}>
                    <strong>{item.email}</strong>
                    <span>{item.plan?.name ?? t("noPlanShort")}</span>
                    <span>
                      {t(!item.active ? "inactive" : isExpired(item) ? "expired" : "active")}
                    </span>
                    <span>{t("editUser")}</span>
                  </Link>
                ))}
              </div>
            )}
            <Pager page={page} more={page * 50 < (clients.data?.total ?? 0)} onChange={setPage} />
          </section>
        </div>
      )}
    </>
  );
}

/** The plans a client can get: those of the reseller's package; without one, nothing. */
function ClientPlan({ client: current, overview }: { client?: User; overview: Overview }) {
  const { t } = useTranslation();
  return (
    <label>
      {t("plan")}
      <select name="planId" defaultValue={current?.plan?.id ?? ""} aria-describedby="plan-hint">
        <option value="">{t("noPlanReseller")}</option>
        {overview.package?.plans.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.name}
          </option>
        ))}
      </select>
      <span className="muted field-hint" id="plan-hint">
        {overview.package
          ? t("clientPlanHint", { name: overview.package.name })
          : t("noPackageYet")}
      </span>
    </label>
  );
}

export function ClientDetail({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const creating = id === "new";
  const overview = useOverview();
  const detail = useQuery({
    queryKey: ["client", id],
    queryFn: () => api<User>(`/reseller/clients/${id}`),
    enabled: user.role === "RESELLER" && !creating,
  });
  if (user.role !== "RESELLER") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={t(creating ? "createClient" : "editClient")}
        trail={[{ label: t("clientsTitle"), to: "/admin" }]}
      />
      {overview.isPending || (!creating && detail.isPending) ? (
        <Loading />
      ) : overview.error || detail.error ? (
        <ErrorMessage error={overview.error ?? detail.error} />
      ) : creating ? (
        <NewClient overview={overview.data} />
      ) : (
        <ClientEditor key={detail.data!.id} current={detail.data!} overview={overview.data} />
      )}
    </>
  );
}

const refresh = () => {
  void client.invalidateQueries({ queryKey: ["clients"] });
  void client.invalidateQueries({ queryKey: ["reseller-overview"] });
};

function NewClient({ overview }: { overview: Overview }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: unknown) => api<User>("/reseller/clients", "POST", body),
    onSuccess: (value) => {
      refresh();
      navigate(`/admin/clients/${value.id}`, { replace: true });
    },
  });
  return (
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
      <label>
        {t("email")}
        <input name="email" type="email" required maxLength={254} autoComplete="off" />
      </label>
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
      <p className="muted">{t("clientPasswordHint")}</p>
      <ClientPlan overview={overview} />
      <UserLimits />
      <ErrorMessage error={create.error} />
      <button disabled={create.isPending}>{t("createClient")}</button>
    </form>
  );
}

function ClientEditor({ current, overview }: { current: User; overview: Overview }) {
  const { t } = useTranslation();
  const update = useMutation({
    mutationFn: (body: unknown) => api<User>(`/reseller/clients/${current.id}`, "PATCH", body),
    onSuccess: (value) => {
      refresh();
      client.setQueryData(["client", value.id], value);
    },
  });
  const password = useMutation({
    mutationFn: (body: unknown) => api(`/reseller/clients/${current.id}/password`, "POST", body),
  });
  return (
    <div className="form-stack">
      <form
        className="panel compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          update.mutate({ active: data.has("active"), ...limits(data) });
        }}
      >
        <p>{current.email}</p>
        <label className="check">
          <input
            name="active"
            type="checkbox"
            defaultChecked={current.active}
            aria-describedby="client-active-hint"
          />
          {t("active")}
        </label>
        <p className="muted field-hint" id="client-active-hint">
          {t("clientActiveHint")}
        </p>
        <ClientPlan client={current} overview={overview} />
        <UserLimits user={current} />
        <ErrorMessage error={update.error} />
        {update.isSuccess && (
          <p className="notice" role="status">
            {t("saved")}
          </p>
        )}
        <button disabled={update.isPending}>{t("save")}</button>
      </form>
      <form
        className="panel compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          password.mutate(
            { password: new FormData(form).get("password") },
            { onSuccess: () => form.reset() },
          );
        }}
      >
        <h2>{t("changePassword")}</h2>
        <label>
          {t("newPassword")}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <p className="muted">{t("clientNewPasswordHint")}</p>
        <ErrorMessage error={password.error} />
        {password.isSuccess && (
          <p className="notice" role="status">
            {t("passwordSet")}
          </p>
        )}
        <button disabled={password.isPending}>{t("setPassword")}</button>
      </form>
    </div>
  );
}
