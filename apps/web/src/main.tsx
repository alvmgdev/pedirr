import { Administration, UserDetail } from "./admin";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import "./i18n";
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./style.css";
import { api, ApiError, client, setSession, type User } from "./api";
import { Account, Language, LinkBrand, Login } from "./auth";
import { CatalogDetail, Discover } from "./catalog";
import { RequestDetail, Requests } from "./requests";
import { ErrorMessage, Loading } from "./ui";
function App() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<User>("/auth/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 300000,
  });
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", "POST"),
    onSuccess: () => {
      setSession(null);
    },
  });
  useEffect(() => {
    const expired = () => {
      setSession(null);
    };
    window.addEventListener("pedirr:session-expired", expired);
    return () => window.removeEventListener("pedirr:session-expired", expired);
  }, []);
  useEffect(() => {
    if (me.data?.locale) void i18n.changeLanguage(me.data.locale);
  }, [me.data?.locale, i18n]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  if (me.isPending) return <Loading />;
  if (me.error)
    return (
      <main className="panel">
        <ErrorMessage error={me.error} />
        <button onClick={() => void me.refetch()}>{t("retry")}</button>
      </main>
    );
  if (!me.data) return <Login />;
  const user = me.data;
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        {t("skipContent")}
      </a>
      <header className="app-header">
      <div className="app-nav">
        <NavLink to="/" aria-label="Pedirr">
          <LinkBrand />
        </NavLink>
        <nav aria-label={t("mainNavigation")}>
          <NavLink end to="/">
            {t("discover")}
          </NavLink>
          <NavLink to="/requests">{t("requests")}</NavLink>
          <NavLink to="/account">{t("account")}</NavLink>
          {user.role === "ADMIN" && <NavLink to="/admin">{t("admin")}</NavLink>}
        </nav>
        <div className="nav-bottom">
          <span>{user.email}</span>
          <button disabled={logout.isPending} onClick={() => logout.mutate()}>
            {t("logout")}
          </button>
          <ErrorMessage error={logout.error} />
        </div>
      </div>
      <div className="topbar">
        <span>{t("scheduleNote", { timezone: user.timezone })}</span>
        <Language user={user} />
      </div>
      </header>
      <div className="app-content">
        <main id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<Discover user={user} />} />
            <Route
              path="/catalog/:kind/:id"
              element={<CatalogDetail key={location.pathname} user={user} />}
            />
            <Route path="/requests" element={<Requests />} />
            <Route
              path="/requests/:id"
              element={<RequestDetail key={location.pathname} user={user} />}
            />
            <Route path="/account" element={<Account user={user} />} />
            <Route path="/admin/users/:id" element={<UserDetail key={location.pathname} user={user} />} />
            <Route path="/admin" element={<Administration user={user} />} />
            <Route path="*" element={<h1>{t("notFound")}</h1>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
