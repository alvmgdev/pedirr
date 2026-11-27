import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, client, type Item, type Plan, type PlanGrant, type User } from "./api";
import { ErrorMessage, Loading, PageHeader } from "./ui";

export const usePlans = (enabled = true) =>
  useQuery({ queryKey: ["plans"], queryFn: () => api<Plan[]>("/admin/plans"), enabled });

/** What a plan includes, in a few words: "Every sport" or its first sports and leagues. */
function contentSummary(plan: Plan, t: TFunction) {
  if (plan.allContent) {
    return t("planAllContentShort");
  }
  const names = plan.grants.map((grant) => grant.name);
  return names.length > 3
    ? `${names.slice(0, 3).join(", ")} +${names.length - 3}`
    : names.join(", ");
}

export function Plans() {
  const { t } = useTranslation();
  const plans = usePlans();
  return (
    <>
      <p className="muted">{t("plansHint")}</p>
      {plans.isPending ? (
        <Loading />
      ) : plans.error ? (
        <ErrorMessage error={plans.error} />
      ) : plans.data.length === 0 ? (
        <p className="empty">{t("noPlans")}</p>
      ) : (
        <div className="user-list">
          {plans.data.map((plan) => (
            <Link className="user-row plan-row" key={plan.id} to={`/admin/plans/${plan.id}`}>
              <strong>{plan.name}</strong>
              <span>{contentSummary(plan, t)}</span>
              <span>{t("planUsers", { count: plan.users })}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function PlanDetail({ user }: { user: User }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const creating = id === "new";
  const detail = useQuery({
    queryKey: ["plan", id],
    queryFn: () => api<Plan>(`/admin/plans/${id}`),
    enabled: user.role === "ADMIN" && !creating,
  });
  if (user.role !== "ADMIN") {
    return <p role="alert">{t("unauthorized")}</p>;
  }
  return (
    <>
      <PageHeader
        title={t(creating ? "createPlan" : "editPlan")}
        trail={[
          { label: t("admin"), to: "/admin" },
          { label: t("plans"), to: "/admin?tab=plans" },
        ]}
      />
      {creating ? (
        <PlanEditor />
      ) : detail.isPending ? (
        <Loading />
      ) : detail.error ? (
        <ErrorMessage error={detail.error} />
      ) : (
        <PlanEditor key={detail.data.id} plan={detail.data} />
      )}
    </>
  );
}

const sameGrant = (left: PlanGrant) => (right: PlanGrant) =>
  left.kind === right.kind && left.hubId === right.hubId;

function PlanEditor({ plan }: { plan?: Plan }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [allContent, setAllContent] = useState(plan?.allContent ?? false);
  // Kept while "every sport" is chosen, so switching back does not lose the selection.
  const [grants, setGrants] = useState<PlanGrant[]>(plan?.grants ?? []);
  const sports = useQuery({
    queryKey: ["plan-sports"],
    queryFn: () => api<{ id: string; name: string }[]>("/admin/plans/sports"),
    enabled: !allContent,
    staleTime: 3600000,
  });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      plan
        ? api<Plan>(`/admin/plans/${plan.id}`, "PUT", body)
        : api<Plan>("/admin/plans", "POST", body),
    onSuccess: (value) => {
      void client.invalidateQueries({ queryKey: ["plans"] });
      client.setQueryData(["plan", value.id], value);
      if (!plan) {
        navigate(`/admin/plans/${value.id}`, { replace: true });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/plans/${plan!.id}`, "DELETE"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["plans"] });
      navigate("/admin?tab=plans", { replace: true });
    },
  });
  const toggle = (grant: PlanGrant) =>
    setGrants((current) =>
      current.some(sameGrant(grant))
        ? current.filter((item) => !sameGrant(grant)(item))
        : [...current, grant],
    );
  const selectedLeagues = grants.filter((grant) => grant.kind === "LEAGUE");
  return (
    <form
      className="panel compact-form plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          name: new FormData(event.currentTarget).get("name"),
          allContent,
          grants: allContent ? [] : grants.map(({ kind, hubId }) => ({ kind, hubId })),
        });
      }}
    >
      <label>
        {t("planName")}
        <input name="name" defaultValue={plan?.name} required maxLength={80} />
      </label>
      <fieldset className="limits">
        <legend>{t("planContent")}</legend>
        <label className="check">
          <input
            type="radio"
            name="content"
            checked={allContent}
            onChange={() => setAllContent(true)}
          />
          {t("planAllContent")}
        </label>
        <label className="check">
          <input
            type="radio"
            name="content"
            checked={!allContent}
            onChange={() => setAllContent(false)}
          />
          {t("planSelectedContent")}
        </label>
      </fieldset>
      {!allContent && (
        <>
          <fieldset className="limits">
            <legend>{t("sports")}</legend>
            <p className="muted">{t("planSportsHint")}</p>
            {sports.isPending ? (
              <Loading />
            ) : sports.error ? (
              <ErrorMessage error={sports.error} />
            ) : (
              <div className="sport-grid">
                {sports.data.map((sport) => {
                  const grant = { kind: "SPORT" as const, hubId: sport.id, name: sport.name };
                  return (
                    <label className="check" key={sport.id}>
                      <input
                        type="checkbox"
                        checked={grants.some(sameGrant(grant))}
                        onChange={() => toggle(grant)}
                      />
                      {sport.name}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          <LeaguePicker selected={selectedLeagues} onToggle={toggle} />
        </>
      )}
      <ErrorMessage error={save.error} />
      {save.isSuccess && (
        <p className="notice" role="status">
          {t("saved")}
        </p>
      )}
      <button disabled={save.isPending}>{t(plan ? "save" : "createPlan")}</button>
      {plan && (
        <div className="plan-delete">
          {plan.users > 0 ? (
            <p className="muted">{t("planInUse", { count: plan.users })}</p>
          ) : plan.packages > 0 ? (
            <p className="muted">{t("planInPackages", { count: plan.packages })}</p>
          ) : (
            <button
              type="button"
              className="quiet danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("deletePlan")}
            </button>
          )}
          <ErrorMessage error={remove.error} />
        </div>
      )}
    </form>
  );
}

/** Finds leagues in the catalog by name and adds them to the plan, or removes them. */
function LeaguePicker({
  selected,
  onToggle,
}: {
  selected: PlanGrant[];
  onToggle: (grant: PlanGrant) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const path = `/catalog/search?q=${encodeURIComponent(query)}`;
  const results = useQuery({
    queryKey: ["catalog", path],
    queryFn: () => api<{ results: Item[] }>(path),
    enabled: query.length >= 2,
  });
  const leagues = (results.data?.results ?? []).filter((item) => item.entityType === "league");
  return (
    <fieldset className="limits">
      <legend>{t("leagues")}</legend>
      <p className="muted">{t("planLeaguesHint")}</p>
      {selected.length > 0 && (
        <ul className="grant-list" aria-label={t("planSelectedLeagues")}>
          {selected.map((grant) => (
            <li key={grant.hubId}>
              <span>{grant.name}</span>
              <button
                type="button"
                className="quiet"
                aria-label={t("removeNamed", { name: grant.name })}
                onClick={() => onToggle(grant)}
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        {t("searchLeagues")}
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          minLength={2}
          maxLength={100}
        />
      </label>
      {query.length >= 2 &&
        (results.isPending ? (
          <Loading />
        ) : results.error ? (
          <ErrorMessage error={results.error} />
        ) : leagues.length === 0 ? (
          <p className="muted">{t("noLeagueResults")}</p>
        ) : (
          <ul className="grant-list" aria-label={t("searchResults")}>
            {leagues.map((league) => {
              const grant = { kind: "LEAGUE" as const, hubId: league.id, name: league.name };
              const added = selected.some(sameGrant(grant));
              return (
                <li key={league.id}>
                  <span>{league.name}</span>
                  <button
                    type="button"
                    className="quiet"
                    aria-label={t(added ? "removeNamed" : "addNamed", { name: league.name })}
                    onClick={() => onToggle(grant)}
                  >
                    {t(added ? "remove" : "add")}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
    </fieldset>
  );
}
