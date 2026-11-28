import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, client, setSession, type User } from "./api";
import { ErrorMessage, timezoneOf } from "./ui";
import { applyTheme, storedTheme, THEMES, type ThemeChoice } from "./theme";

/** The mark and wordmark. */
export function LinkBrand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 30 34" fill="none" aria-hidden="true">
        <path
          d="M3 3h24v9a5 5 0 0 0 0 10v9H3v-9a5 5 0 0 0 0-10V3Z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="m12 11 9 6-9 6V11Z" fill="currentColor" />
      </svg>
      pedirr
    </div>
  );
}
const LANGUAGES = { en: "English", es: "Español" } as const;
type Locale = keyof typeof LANGUAGES;

/** Drawn flags: emoji flags show as two letters on Windows. */
export function Flag({ locale }: { locale: Locale }) {
  return (
    <span className="flag" aria-hidden="true">
      {locale === "es" ? (
        <svg viewBox="0 0 60 40">
          <rect width="60" height="40" fill="#AA151B" />
          <rect y="10" width="60" height="20" fill="#F1BF00" />
        </svg>
      ) : (
        <svg viewBox="0 0 60 40">
          <rect width="60" height="40" fill="#012169" />
          <path d="M0 0L60 40M60 0L0 40" stroke="#fff" strokeWidth="8" />
          <path d="M0 0L60 40M60 0L0 40" stroke="#C8102E" strokeWidth="3" />
          <path d="M30 0V40M0 20H60" stroke="#fff" strokeWidth="12" />
          <path d="M30 0V40M0 20H60" stroke="#C8102E" strokeWidth="7" />
        </svg>
      )}
    </span>
  );
}
const Chevron = () => (
  <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
);
const Check = () => (
  <svg className="check-mark" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m3 8.5 3.2 3L13 5" />
  </svg>
);

/**
 * A button that opens a small panel below it. The panel closes with Escape (returning focus to the
 * button), on a click outside, or when one of its actions runs.
 */
function Dropdown({
  className,
  label,
  button,
  children,
}: {
  className: string;
  /** The button's name when its content has no text, as with an avatar. */
  label?: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className={`dropdown ${className}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {button}
      </button>
      {open && (
        <div className="dropdown-panel" id={id}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** The interface language, saved to the profile when signed in. */
export function LanguageMenu({ user }: { user?: User | null }) {
  const { t, i18n } = useTranslation();
  const current: Locale = i18n.language.startsWith("es") ? "es" : "en";
  const change = useMutation({
    mutationFn: (locale: string) => api<User>("/me", "PATCH", { locale }),
    onSuccess: (updated) => client.setQueryData(["me"], updated),
  });
  return (
    <>
      <Dropdown
        className="language-menu"
        button={
          <>
            <Flag locale={current} />
            {/* Named by its text, the visible code included, so voice control can say it. */}
            <span className="sr-only">{t("languageCurrent", { name: LANGUAGES[current] })}</span>
            <span className="language-code">{current.toUpperCase()}</span>
            <Chevron />
          </>
        }
      >
        {(close) =>
          (Object.keys(LANGUAGES) as Locale[]).map((locale) => (
            <button
              key={locale}
              type="button"
              lang={locale}
              className="dropdown-item"
              aria-current={locale === current ? "true" : undefined}
              onClick={() => {
                void i18n.changeLanguage(locale);
                if (user) {
                  change.mutate(locale);
                }
                close();
              }}
            >
              <Flag locale={locale} />
              <span>{LANGUAGES[locale]}</span>
              {locale === current && <Check />}
            </button>
          ))
        }
      </Dropdown>
      <ErrorMessage error={change.error} />
    </>
  );
}

/** Sun, moon or screen: the icon of each theme choice. */
function ThemeIcon({ theme }: { theme: ThemeChoice }) {
  return (
    <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      {theme === "light" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      ) : theme === "dark" ? (
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      ) : (
        <>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </>
      )}
    </svg>
  );
}

/** The colour theme, saved in this browser and to the profile when signed in. */
export function ThemeMenu({ user }: { user?: User | null }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ThemeChoice>(() =>
    user && THEMES.includes(user.theme as ThemeChoice)
      ? (user.theme as ThemeChoice)
      : storedTheme(),
  );
  const change = useMutation({
    mutationFn: (theme: ThemeChoice) => api<User>("/me", "PATCH", { theme }),
    onSuccess: (updated) => client.setQueryData(["me"], updated),
  });
  return (
    <>
      <Dropdown
        className="theme-menu"
        button={
          <>
            <ThemeIcon theme={current} />
            <span className="sr-only">{t("themeCurrent", { name: t(`theme_${current}`) })}</span>
          </>
        }
      >
        {(close) =>
          THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              className="dropdown-item"
              aria-current={theme === current ? "true" : undefined}
              onClick={() => {
                setCurrent(theme);
                applyTheme(theme);
                if (user) {
                  change.mutate(theme);
                }
                close();
              }}
            >
              <ThemeIcon theme={theme} />
              <span>{t(`theme_${theme}`)}</span>
              {theme === current && <Check />}
            </button>
          ))
        }
      </Dropdown>
      <ErrorMessage error={change.error} />
    </>
  );
}

/** Who is signed in, where dates come from, the account page and signing out. */
function AccountMenu({ user }: { user: User }) {
  const { t } = useTranslation();
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", "POST"),
    onSuccess: () => setSession(null),
  });
  return (
    <>
      <Dropdown
        className="account-menu"
        label={t("accountMenu")}
        button={
          <>
            <span className="avatar" aria-hidden="true">
              {user.email.charAt(0).toUpperCase()}
            </span>
            <Chevron />
          </>
        }
      >
        {(close) => (
          <>
            <div className="dropdown-identity">
              <strong>{user.email}</strong>
              {user.tenant?.code && <span>{user.tenant.name}</span>}
            </div>
            <p className="dropdown-note">{t("scheduleNote", { timezone: timezoneOf(user) })}</p>
            <Link className="dropdown-item" to="/account" onClick={close}>
              {t("account")}
            </Link>
            <button
              type="button"
              className="dropdown-item"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t("logout")}
            </button>
          </>
        )}
      </Dropdown>
      <ErrorMessage error={logout.error} />
    </>
  );
}

const icons = {
  discover: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </>
  ),
  requests: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </>
  ),
  issues: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </>
  ),
  admin: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
};
function NavItem({
  to,
  icon,
  end,
  children,
  label,
}: {
  to: string;
  icon: keyof typeof icons;
  end?: boolean;
  children: ReactNode;
  label?: string;
}) {
  return (
    <NavLink to={to} end={end} aria-label={label}>
      {/* Icons show on phones, where the navigation sits at the bottom. */}
      <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
        {icons[icon]}
      </svg>
      {children}
    </NavLink>
  );
}

/** The one bar above every page; on phones its sections move to a bar at the bottom. */
export function TopBar({ user }: { user: User }) {
  const { t } = useTranslation();
  // Issues waiting for the viewer's answer. A reseller's administrator only reads its clients'
  // issues, so it sees how many of them are active instead.
  const openIssues = useQuery({
    queryKey: ["issues", "open"],
    queryFn: () => api<{ open: number; awaiting: number }>("/issues/open"),
    refetchInterval: 60000,
  });
  const reader = user.role === "RESELLER";
  const open = (reader ? openIssues.data?.open : openIssues.data?.awaiting) ?? 0;
  return (
    <header className="app-header">
      <NavLink to="/" aria-label="Pedirr" className="app-brand">
        <LinkBrand />
      </NavLink>
      <nav className="app-nav" aria-label={t("mainNavigation")}>
        <NavItem to="/" end icon="discover">
          {t("discover")}
        </NavItem>
        <NavItem to="/requests" icon="requests">
          {t("requests")}
        </NavItem>
        <NavItem to="/issues" icon="issues">
          {t("issues")}
          {open > 0 && (
            <span className="nav-count">
              <span aria-hidden="true">{open}</span>
              <span className="sr-only">
                {t(reader ? "openIssues" : "awaitingIssues", { count: open })}
              </span>
            </span>
          )}
        </NavItem>
        {(user.role === "ADMIN" || user.role === "RESELLER") && (
          // Phones show the short label so the sections fit; the name stays complete.
          <NavItem to="/admin" icon="admin" label={t("admin")}>
            <span className="label-long">{t("admin")}</span>
            <span className="label-short" aria-hidden="true">
              {t("adminShort")}
            </span>
          </NavItem>
        )}
      </nav>
      <div className="app-tools">
        <ThemeMenu user={user} />
        <LanguageMenu user={user} />
        <AccountMenu user={user} />
      </div>
    </header>
  );
}
