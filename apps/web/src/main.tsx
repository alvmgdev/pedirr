import { Administration, UserDetail } from "./admin";
import { PlanDetail } from "./plans";
import { PackageDetail, ResellerDetail } from "./resellers";
import { ClientDetail, ResellerPanel } from "./reseller-panel";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import "./i18n";
// Manrope for the interface; Barlow Condensed only for the "pedirr" wordmark.
import "@fontsource-variable/manrope";
import "@fontsource/barlow-condensed/latin-600.css";
import "./style.css";
import { api, ApiError, client, setSession, type User } from "./api";
import { Account, Login } from "./auth";
import { TopBar } from "./shell";
import { CatalogDetail, Discover } from "./catalog";
import { RequestDetail, Requests } from "./requests";
import { IssueDetail, Issues } from "./issues";
import { ErrorMessage, Loading, PageHeader } from "./ui";
import { basename } from "./environment";
import { applyTheme } from "./theme";
function App() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<User>("/auth/me");
      } catch (error) {
        // Signed out, or an address that is no service: the sign-in page explains which.
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.code === "TENANT_NOT_FOUND")
        ) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 300000,
  });
  useEffect(() => {
    const expired = () => {
      setSession(null);
    };
    window.addEventListener("pedirr:session-expired", expired);
    return () => window.removeEventListener("pedirr:session-expired", expired);
  }, []);
  useEffect(() => {
    if (me.data?.locale) {
      void i18n.changeLanguage(me.data.locale);
    }
  }, [me.data?.locale, i18n]);
  // The profile's theme follows the person to every device.
  useEffect(() => {
    if (me.data?.theme) {
      applyTheme(me.data.theme);
    }
  }, [me.data?.theme]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  if (me.isPending) {
    return <Loading />;
  }
  if (me.error) {
    return (
      <main className="panel">
        <ErrorMessage error={me.error} />
        <button onClick={() => void me.refetch()}>{t("retry")}</button>
      </main>
    );
  }
  if (!me.data) {
    return <Login />;
  }
  const user = me.data;
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        {t("skipContent")}
      </a>
      <TopBar user={user} />
      <div className="app-content">
        <main id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<Discover user={user} />} />
            <Route
              path="/catalog/:kind/:id"
              element={<CatalogDetail key={location.pathname} user={user} />}
            />
            <Route path="/requests" element={<Requests user={user} />} />
            <Route
              path="/requests/:id"
              element={<RequestDetail key={location.pathname} user={user} />}
            />
            <Route path="/issues" element={<Issues user={user} />} />
            <Route
              path="/issues/:id"
              element={<IssueDetail key={location.pathname} user={user} />}
            />
            <Route path="/account" element={<Account user={user} />} />
            <Route
              path="/admin/users/:id"
              element={<UserDetail key={location.pathname} user={user} />}
            />
            <Route
              path="/admin/plans/:id"
              element={<PlanDetail key={location.pathname} user={user} />}
            />
            <Route
              path="/admin/resellers/:id"
              element={<ResellerDetail key={location.pathname} user={user} />}
            />
            <Route
              path="/admin/packages/:id"
              element={<PackageDetail key={location.pathname} user={user} />}
            />
            <Route
              path="/admin/clients/:id"
              element={<ClientDetail key={location.pathname} user={user} />}
            />
            <Route
              path="/admin"
              element={
                // A reseller's administrator manages its clients; the platform's, everything.
                user.role === "RESELLER" ? <ResellerPanel /> : <Administration user={user} />
              }
            />
            <Route path="*" element={<PageHeader title={t("notFound")} />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
