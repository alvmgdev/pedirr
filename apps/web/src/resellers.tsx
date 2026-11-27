import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  api,
  client,
  resellerAddress,
  type PlanPackage,
  type Plan,
  type Reseller,
  type User,
  PASSWORD_MIN_LENGTH,
} from "./api";
import { OptionalLimit } from "./fields";
import { ErrorMessage, Loading, PageHeader } from "./ui";

export const useResellers = (enabled = true) =>
  useQuery({
    queryKey: ["resellers"],
    queryFn: () => api<Reseller[]>("/admin/resellers"),
    enabled,
  });
/** The plans a reseller's package holds, for its clients. */
export function useResellerPlans(tenantId: string | undefined) {
  const resellers = useResellers(Boolean(tenantId));
  const packageId = resellers.data?.find((item) => item.id === tenantId)?.package?.id;
  const pack = useQuery({
    queryKey: ["package", packageId],
    queryFn: () => api<PlanPackage>(`/admin/packages/${packageId}`),
    enabled: Boolean(packageId),
  });
  return {
    pending: resellers.isPending || (Boolean(packageId) && pack.isPending),
    error: resellers.error ?? pack.error,
    plans: pack.data?.plans ?? [],
    packageName: pack.data?.name ?? null,
  };
}
const usePackages = () =>
  useQuery({ queryKey: ["packages"], queryFn: () => api<PlanPackage[]>("/admin/packages") });

/** Reads the client limit back from a form: switched off, no limit. */
const maxUsers = (data: FormData) =>
  data.has("maxUsersEnabled") ? Number(data.get("maxUsers")) : null;

export function Resellers() {
  const { t } = useTranslation();
  const resellers = useResellers();
  return (
    <>
      <div className="content-toolbar">
        <p>{t("resellersHint")}</p>
        <Link className="button-link" to="/admin/resellers/new">
          {t("createReseller")}
        </Link>
      </div>
      {resellers.isPending ? (
        <Loading />
      ) : resellers.error ? (
        <ErrorMessage error={resellers.error} />
      ) : resellers.data.length === 0 ? (
        <p className="empty">{t("noResellers")}</p>
      ) : (
        <div className="user-list">
          {resellers.data.map((reseller) => (
            <Link
              className="user-row reseller-row"
              key={reseller.id}
              to={`/admin/resellers/${reseller.id}`}
            >
              <strong>{reseller.name}</strong>
              <span className="code">/{reseller.code}/</span>
              <span>{reseller.package?.name ?? t("noPackage")}</span>
              <span>
                {reseller.maxUsers === null
                  ? t("clients", { count: reseller.clients })
                  : t("clientsOf", { count: reseller.clients, max: reseller.maxUsers })}
              </span>
              <span className={reseller.active ? undefined : "off"}>
                {t(reseller.active ? "resellerActive" : "resellerDisabled")}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function ResellerDetail({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const creating = id === "new";
  const detail = useQuery({
    queryKey: ["reseller", id],
    queryFn: () => api<Reseller>(`/admin/resellers/${id}`),
    enabled: user.role === "ADMIN" && !creating,
  });
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={creating ? t("createReseller") : (detail.data?.name ?? t("reseller"))}
        trail={[
          { label: t("admin"), to: "/admin" },
          { label: t("resellers"), to: "/admin?tab=resellers" },
        ]}
      />
      {creating ? (
        <NewReseller />
      ) : detail.isPending ? (
        <Loading />
      ) : detail.error ? (
        <ErrorMessage error={detail.error} />
      ) : (
        <ResellerEditor key={detail.data.id} reseller={detail.data} />
      )}
    </>
  );
}

function PackageSelect({ value }: { value?: string }) {
  const { t } = useTranslation();
  const packages = usePackages();
  return (
    <label>
      {t("package")}
      <select
        name="packageId"
        defaultValue={value ?? ""}
        disabled={packages.isPending}
        key={packages.isPending ? "loading" : "ready"}
        aria-describedby="package-hint"
      >
        <option value="">{t("noPackage")}</option>
        {packages.data?.map((pack) => (
          <option key={pack.id} value={pack.id}>
            {pack.name}
          </option>
        ))}
      </select>
      <span className="muted field-hint" id="package-hint">
        {t("packageHint")}
      </span>
      <ErrorMessage error={packages.error} />
    </label>
  );
}

function NewReseller() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: unknown) => api<Reseller>("/admin/resellers", "POST", body),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["resellers"] });
      client.setQueryData(["reseller", value.id], value);
      navigate(`/admin/resellers/${value.id}`, { replace: true });
    },
  });
  return (
    <form
      className="panel compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        create.mutate({
          name: data.get("name"),
          ...(data.get("code") ? { code: data.get("code") } : {}),
          packageId: data.get("packageId") || null,
          maxUsers: maxUsers(data),
          admin: { email: data.get("email"), password: data.get("password") },
        });
      }}
    >
      <label>
        {t("resellerName")}
        <input name="name" required maxLength={80} />
      </label>
      <label>
        {t("resellerCode")}
        <input
          name="code"
          maxLength={20}
          pattern="[a-z0-9][a-z0-9\-]{1,18}[a-z0-9]"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="code-hint"
        />
        <span className="muted field-hint" id="code-hint">
          {t("resellerCodeHint")}
        </span>
      </label>
      <PackageSelect />
      <OptionalLimit name="maxUsers" type="number" value="" max={100000} />
      <fieldset className="limits">
        <legend>{t("resellerAdmin")}</legend>
        <p className="muted">{t("resellerAdminHint")}</p>
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
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            required
          />
        </label>
        <p className="muted">{t("passwordHint")}</p>
      </fieldset>
      <ErrorMessage error={create.error} />
      <button disabled={create.isPending}>{t("createReseller")}</button>
    </form>
  );
}

/** The address to give the reseller, with a button to copy it. */
export function Address({
  code,
  hint = "resellerAddressHint",
}: {
  code: string;
  /** Who the address is for: the reseller (platform view) or its clients (reseller view). */
  hint?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const address = resellerAddress(code);
  return (
    <section className="panel address-panel">
      <h2>{t("resellerAddress")}</h2>
      <p className="muted">{t(hint)}</p>
      <div className="address-row">
        <code>{address}</code>
        <button
          type="button"
          className="quiet"
          onClick={() =>
            void navigator.clipboard?.writeText(address).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {t("copy")}
        </button>
      </div>
      {copied && (
        <p className="muted" role="status">
          {t("copied")}
        </p>
      )}
    </section>
  );
}

function ResellerEditor({ reseller }: { reseller: Reseller }) {
  const { t } = useTranslation();
  const update = useMutation({
    mutationFn: (body: unknown) => api<Reseller>(`/admin/resellers/${reseller.id}`, "PATCH", body),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["resellers"] });
      client.setQueryData(["reseller", value.id], value);
    },
  });
  const password = useMutation({
    mutationFn: (body: unknown) =>
      api(`/admin/resellers/${reseller.id}/admin-password`, "POST", body),
  });
  return (
    <div className="form-stack">
      <Address code={reseller.code} />
      <form
        className="panel compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          update.mutate({
            name: data.get("name"),
            active: data.has("active"),
            packageId: data.get("packageId") || null,
            maxUsers: maxUsers(data),
          });
        }}
      >
        <label>
          {t("resellerName")}
          <input name="name" defaultValue={reseller.name} required maxLength={80} />
        </label>
        <label className="check">
          <input
            name="active"
            type="checkbox"
            defaultChecked={reseller.active}
            aria-describedby="active-hint"
          />
          {t("resellerActiveToggle")}
        </label>
        <p className="muted field-hint" id="active-hint">
          {t("resellerActiveHint")}
        </p>
        <PackageSelect value={reseller.package?.id} />
        <OptionalLimit
          name="maxUsers"
          type="number"
          value={reseller.maxUsers === null ? "" : String(reseller.maxUsers)}
          max={100000}
        />
        <p className="muted">{t("clientsNow", { count: reseller.clients })}</p>
        <ErrorMessage error={update.error} />
        {update.isSuccess && (
          <p className="notice" role="status">
            {t("saved")}
          </p>
        )}
        <button disabled={update.isPending}>{t("save")}</button>
      </form>
      {reseller.admin && (
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
          <h2>{t("resellerAdmin")}</h2>
          <p>{reseller.admin.email}</p>
          <label>
            {t("newPassword")}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={128}
              required
            />
          </label>
          <p className="muted">{t("resellerPasswordHint")}</p>
          <ErrorMessage error={password.error} />
          {password.isSuccess && (
            <p className="notice" role="status">
              {t("passwordSet")}
            </p>
          )}
          <button disabled={password.isPending}>{t("setPassword")}</button>
        </form>
      )}
    </div>
  );
}

export function Packages() {
  const { t } = useTranslation();
  const packages = usePackages();
  return (
    <>
      <div className="content-toolbar">
        <p>{t("packagesHint")}</p>
        <Link className="button-link" to="/admin/packages/new">
          {t("createPackage")}
        </Link>
      </div>
      {packages.isPending ? (
        <Loading />
      ) : packages.error ? (
        <ErrorMessage error={packages.error} />
      ) : packages.data.length === 0 ? (
        <p className="empty">{t("noPackages")}</p>
      ) : (
        <div className="user-list">
          {packages.data.map((pack) => (
            <Link className="user-row plan-row" key={pack.id} to={`/admin/packages/${pack.id}`}>
              <strong>{pack.name}</strong>
              <span>{pack.plans.map((plan) => plan.name).join(", ") || t("noPlansInPackage")}</span>
              <span>{t("packageResellers", { count: pack.resellers })}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function PackageDetail({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const creating = id === "new";
  const detail = useQuery({
    queryKey: ["package", id],
    queryFn: () => api<PlanPackage>(`/admin/packages/${id}`),
    enabled: user.role === "ADMIN" && !creating,
  });
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={t(creating ? "createPackage" : "editPackage")}
        trail={[
          { label: t("admin"), to: "/admin" },
          { label: t("packages"), to: "/admin?tab=packages" },
        ]}
      />
      {creating ? (
        <PackageEditor />
      ) : detail.isPending ? (
        <Loading />
      ) : detail.error ? (
        <ErrorMessage error={detail.error} />
      ) : (
        <PackageEditor key={detail.data.id} pack={detail.data} />
      )}
    </>
  );
}

function PackageEditor({ pack }: { pack?: PlanPackage }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => api<Plan[]>("/admin/plans") });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      pack
        ? api<PlanPackage>(`/admin/packages/${pack.id}`, "PUT", body)
        : api<PlanPackage>("/admin/packages", "POST", body),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["packages"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      client.setQueryData(["package", value.id], value);
      if (!pack) {
        navigate(`/admin/packages/${value.id}`, { replace: true });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/packages/${pack!.id}`, "DELETE"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["packages"] });
      navigate("/admin?tab=packages", { replace: true });
    },
  });
  const chosen = new Set(pack?.plans.map((plan) => plan.id));
  return (
    <form
      className="panel compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save.mutate({ name: data.get("name"), planIds: data.getAll("planIds") });
      }}
    >
      <label>
        {t("packageName")}
        <input name="name" defaultValue={pack?.name} required maxLength={80} />
      </label>
      <fieldset className="limits">
        <legend>{t("plans")}</legend>
        <p className="muted">{t("packagePlansHint")}</p>
        {plans.isPending ? (
          <Loading />
        ) : plans.error ? (
          <ErrorMessage error={plans.error} />
        ) : plans.data.length === 0 ? (
          <p className="muted">
            {t("noPlansYet")} <Link to="/admin/plans/new">{t("createPlan")}</Link>
          </p>
        ) : (
          <div className="sport-grid">
            {plans.data.map((plan) => (
              <label className="check" key={plan.id}>
                <input
                  type="checkbox"
                  name="planIds"
                  value={plan.id}
                  defaultChecked={chosen.has(plan.id)}
                />
                {plan.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <ErrorMessage error={save.error} />
      {save.isSuccess && (
        <p className="notice" role="status">
          {t("saved")}
        </p>
      )}
      <button disabled={save.isPending}>{t(pack ? "save" : "createPackage")}</button>
      {pack && (
        <div className="plan-delete">
          {pack.resellers > 0 ? (
            <p className="muted">{t("packageInUse", { count: pack.resellers })}</p>
          ) : (
            <button
              type="button"
              className="quiet danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("deletePackage")}
            </button>
          )}
          <ErrorMessage error={remove.error} />
        </div>
      )}
    </form>
  );
}
