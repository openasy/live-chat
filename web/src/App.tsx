import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  Switch,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  AppWindow,
  BarChart3,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  MessagesSquare,
  MoonStar,
  Plug,
  Settings as SettingsIcon,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Chat, Member, Overview, ProductLink, Settings } from "./api.ts";
import { ChatsPage } from "./chats.tsx";
import { LiveProvider, useApi, useLive, visitorName } from "./common.tsx";
import { useT } from "./i18n.ts";
import { AfterHoursPage, IntegrationsPage, OverviewPage, ReportsPage, SettingsFilePage, WindowPage } from "./pages.tsx";

const PAGES = ["chats", "after-hours", "window", "reports", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "chat"; number: number };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "chats" && id && /^\d+$/.test(id)) return { page: "chat", number: Number(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Away or available, beside the chats: away members are not counted as answering. */
function AwaySwitch() {
  const t = useT();
  const call = useApi();
  const { can } = useAuth();
  const [away, setAway] = useState<boolean | null>(null);
  useEffect(() => {
    void call<{ away: boolean }>("/api/v1/me").then(
      (r) => setAway(r.away),
      () => {},
    );
  }, [call]);
  if (!can("editor") || away === null) return null;
  return (
    <Switch
      checked={!away}
      label={t("team.availableSwitch")}
      onCheckedChange={(on) => {
        setAway(!on);
        void call("/api/v1/me/away", { method: "PUT", body: JSON.stringify({ away: !on }) }).catch(() => setAway(on));
      }}
    />
  );
}

/** The tab's title counts visitors waiting, so a new chat is seen from another tab. */
function useWaitingTitle(chats: Chat[]) {
  const t = useT();
  useEffect(() => {
    const waiting = chats.filter((c) => c.status === "open" && c.waitingSince).length;
    document.title = waiting ? `(${waiting}) ${t("title")}` : t("title");
  }, [chats, t]);
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [overview, setOverview] = useState<Overview>();
  const [settings, setSettings] = useState<Settings>();
  const [members, setMembers] = useState<Member[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const live = useLive();
  useWaitingTitle(live.chats);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "live-chat" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Overview>("/api/v1/overview").then(setOverview, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
    void call<{ members: Member[] }>("/api/v1/team").then(
      (r) => setMembers(r.members),
      () => {},
    );
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds chats by visitor, email, page or what was said.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ chats: Chat[] }>(`/api/v1/chats?${new URLSearchParams({ q, status: "all", limit: "10" })}`, { signal });
      return r.chats.map((x) => ({
        id: `chat:${x.number}`,
        label: visitorName(x, msg),
        detail: `${x.page} · ${x.last?.text ?? ""}`,
        kind: msg("search.chat"),
        icon: MessagesSquare,
        href: `/chats/${x.number}`,
      }));
    },
    [call, msg],
  );

  const open = live.chats.filter((c) => c.status === "open").length;
  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "chats", label: msg("nav.chats"), icon: MessagesSquare, count: open || undefined },
    { id: "after-hours", label: msg("nav.afterHours"), icon: MoonStar, count: overview?.questions || undefined },
    { id: "window", label: msg("nav.window"), icon: AppWindow },
    { id: "reports", label: msg("nav.reports"), icon: BarChart3 },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "chat" ? "chats" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? settings : undefined;

  return (
    <AppShell
      product="live-chat"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {overview?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {overview.file.error}
        </Callout>
      )}
      {(route.page === "chats" || route.page === "chat") && (
        <div className="lc-away mb-1.5 flex justify-end">
          <AwaySwitch />
        </div>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ready ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "chats" || route.page === "chat" ? (
        <ChatsPage call={call} number={route.page === "chat" ? route.number : null} settings={ready} members={members} />
      ) : route.page === "after-hours" ? (
        <AfterHoursPage call={call} />
      ) : route.page === "window" ? (
        <WindowPage settings={ready} />
      ) : route.page === "reports" ? (
        <ReportsPage call={call} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage call={call} settings={ready} />
      ) : route.page === "settings" ? (
        <SettingsFilePage settings={ready} />
      ) : (
        <OverviewPage call={call} settings={ready} />
      )}
    </AppShell>
  );
}

function Signed() {
  const call = useApi();
  return (
    <LiveProvider call={call}>
      <Product />
    </LiveProvider>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Live Chat">
        <Signed />
      </AuthGate>
    </BrandProvider>
  );
}
