// Overview, After hours, Window, Reports, Integrations and the read-only Settings page.
import {
  Avatar,
  Badge,
  BarList,
  Callout,
  DataTable,
  EmptyState,
  Heatmap,
  IconButton,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Tabs,
  TimeSeriesChart,
  type Column,
  useLocalePreference,
} from "@openasy/ui";
import { Copy, FileSearch, Globe, Handshake, LifeBuoy, MessageCircle } from "lucide-react";
import { useState } from "react";
import type { Integrations, LinkState, Overview, Question, Report, Settings } from "./api.ts";
import { ago, Code, duration, fmt, useLoad, when, type Call } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT, type T } from "./i18n.ts";

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
/** Monday first, in the page's language. */
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 2 + i)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));
/** The hours anything happened in, at least 08:00 to 19:00. */
function hoursUsed(rows: number[][]) {
  const used = [...Array(24).keys()].filter((h) => rows.some((d) => d[h]! > 0));
  const from = Math.min(8, ...used);
  const to = Math.max(19, ...used);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ---------------------------------------------------------------- Overview

export function OverviewPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const [o] = useLoad<Overview>(call, "/api/v1/overview", 30_000);
  const [links] = useLoad<Integrations>(call, "/api/v1/integrations");
  if (o === null) return <EmptyState title={t("common.loadFailed")} />;
  if (!o) return <PageHeader title={t("overview.title")} />;
  const c = settings.config!;
  const hours = hoursUsed([o.perHour.today, o.perHour.lastWeek]);
  const diff = o.chats - o.chatsLastWeek;
  const sites = c.sites.flatMap((s) => s.origins.map((x) => new URL(x).host));
  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.description", {
          sites: sites.length ? sites.join(", ") : t("overview.noSites"),
          hours: c.hours.text === "always" ? t("overview.always") : `${c.hours.described} (${c.hours.timeZone})`,
        })}
        meta={<StatusBadge tone={o.hours.open ? "success" : "neutral"}>{o.hours.open ? t("overview.openNow") : t("overview.closedNow")}</StatusBadge>}
      />
      <KpiGrid minWidth={160} className="mb-2.5">
        <KpiCard
          label={t("overview.chats")}
          value={fmt(o.chats)}
          icon={MessageCircle}
          delta={{
            label: t("overview.vsLastWeek", { change: `${diff > 0 ? "+" : ""}${diff}` }),
            direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
            intent: "neutral",
          }}
        />
        <KpiCard
          label={t("overview.firstAnswer")}
          value={o.firstAnswer === null ? "–" : duration(o.firstAnswer, t)}
          unit={t("overview.median")}
          trend={o.firstAnswerTrend.some((x) => x > 0) ? o.firstAnswerTrend.map((x) => Math.round(x / 1000)) : undefined}
        />
        <KpiCard label={t("overview.slow", { time: duration(o.slowAfter, t) })} value={fmt(o.slow)} tone={o.slow ? "warning" : undefined} />
        <KpiCard
          label={t("overview.tickets")}
          value={fmt(o.tickets)}
          icon={LifeBuoy}
          delta={{
            label: links?.helpdesk.linked === false ? t("overview.helpdeskOff") : t("overview.afterHours", { count: o.ticketsAfterHours }),
            intent: "neutral",
          }}
        />
        <KpiCard
          label={t("overview.leads")}
          value={fmt(o.leads)}
          icon={Handshake}
          delta={{ label: links?.crm.linked ? t("overview.inCrm") : t("overview.crmOff"), intent: links?.crm.linked ? "good" : "neutral" }}
        />
      </KpiGrid>
      <div className="lc-side mb-2.5 grid gap-2.5">
        <Panel title={t("overview.perHour")} description={t("overview.perHourDetail")}>
          <TimeSeriesChart
            label={t("overview.perHourLabel")}
            labels={hours.map(hh)}
            height={190}
            area={false}
            format={(v) => fmt(Math.round(v))}
            series={[
              { id: "today", name: t("overview.today"), data: hours.map((h) => o.perHour.today[h]!), color: "var(--oa-chart-1)" },
              { id: "last", name: t("overview.lastWeek"), data: hours.map((h) => o.perHour.lastWeek[h]!), color: "var(--oa-chart-2)" },
            ]}
          />
        </Panel>
        <Panel title={t("overview.startedOn")} description={t("overview.today")}>
          {o.startedOn.length ? (
            <BarList
              label={t("overview.byPage")}
              items={o.startedOn.map((p) => ({ id: p.page, label: <span className="font-mono">{p.page}</span>, value: p.chats }))}
            />
          ) : (
            <p className="text-sm text-fg-muted">{t("overview.noChats")}</p>
          )}
        </Panel>
      </div>
      <Panel title={t("overview.teamNow")} flush>
        {o.team.length ? (
          <ul aria-label={t("overview.teamNow")} className="lc-list lc-team grid">
            {o.team.map((a) => (
              <li key={a.id} className="flex items-center gap-2 border-b border-subtle px-3 py-2">
                <Avatar name={a.name} size="sm" />
                <span className="flex min-w-0 grow flex-col">
                  <span className="truncate text-sm text-fg">{a.name}</span>
                  <span className="text-2xs text-fg-muted">
                    {a.teams.join(", ") || t("team.noTeam")} · {t("team.chats", { count: a.chats })}
                  </span>
                </span>
                <StatusBadge tone={a.state === "available" ? "success" : a.state === "away" ? "warning" : "neutral"}>{t(`team.${a.state}`)}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-3 text-sm text-fg-muted">{t("team.none")}</p>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- After hours

export function AfterHoursPage({ call }: { call: Call }) {
  const t = useT();
  const [days, setDays] = useState<"7" | "30" | "90">("7");
  const [data] = useLoad<{ questions: Question[] }>(call, `/api/v1/questions?days=${days}`, 60_000);
  const cols: Column<Question>[] = [
    { id: "at", header: t("after.asked"), sortValue: (q) => q.at, cell: (q) => <span className="text-xs whitespace-nowrap">{when(q.at, t)}</span> },
    {
      id: "who",
      header: t("after.visitor"),
      cell: (q) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{q.name ?? q.email}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">{q.email}</span>
        </span>
      ),
    },
    { id: "page", header: t("after.on"), cell: (q) => <span className="font-mono text-xs">{q.page ?? "–"}</span> },
    { id: "q", header: t("after.question"), width: "34%", cell: (q) => <span className="lc-wrap text-xs">{q.question}</span> },
    {
      id: "ticket",
      header: t("after.ticket"),
      cell: (q) =>
        q.ticket ? (
          <Badge mono>#{q.ticket}</Badge>
        ) : (
          <span title={q.error ?? undefined}>
            <Badge tone={q.error ? "warning" : "neutral"}>{q.error ? t("after.retrying") : t("after.pending")}</Badge>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader title={t("after.title")} description={t("after.description")}>
        <Tabs
          label={t("reports.period")}
          value={days}
          onChange={setDays}
          items={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t("reports.days", { count: Number(d) }) }))}
        />
      </PageHeader>
      {data === null && <EmptyState title={t("common.loadFailed")} />}
      {data && (
        <Panel flush title={t("after.table")}>
          {data.questions.length ? (
            <DataTable label={t("after.table")} columns={cols} rows={data.questions} getRowId={(q) => q.id} minWidth={820} />
          ) : (
            <p className="px-3 py-3 text-sm text-fg-muted">{t("after.none")}</p>
          )}
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Window

/** The window as visitors see it, drawn here from the settings; the real one is in a shadow root on the site's pages. */
function Preview({ settings, open, lang }: { settings: Settings; open: boolean; lang: "en" | "de" | "tr" }) {
  const t = useT();
  const c = settings.config!;
  const site = c.sites[0];
  const host = site ? site.origins[0]! : "https://www.example.com";
  return (
    <div className="lc-preview relative overflow-hidden bg-canvas">
      <div aria-hidden className="absolute inset-0 flex flex-col gap-3 p-6 opacity-50">
        <div className="h-5 w-24 rounded bg-subtle" />
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="lc-block rounded-lg bg-subtle" />
          ))}
        </div>
      </div>
      <div
        role="dialog"
        aria-label={t("window.dialog")}
        className={`lc-window absolute flex w-72 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-modal ${c.window.position === "left" ? "lc-left" : ""}`}
      >
        <div className="flex flex-col px-3 py-2.5" style={{ background: c.window.colour, color: textOn(c.window.colour) }}>
          <span className="text-sm font-semibold">{site?.title ?? c.window.title}</span>
          <span className="text-xs">{open ? t("window.soon") : t("window.back", { time: "09:00" })}</span>
        </div>
        <div className="flex flex-col gap-2 p-3 text-sm">
          {open ? (
            <>
              <span className="rounded-lg bg-subtle px-3 py-2 text-fg">{c.window.greeting?.[lang] ?? c.window.greeting?.en ?? t("window.hello")}</span>
              {c.window.suggestArticles && c.knowledgeBase && (
                <>
                  <span className="text-2xs font-semibold text-fg-muted">{t("window.maybe")}</span>
                  <span className="flex items-center gap-1.5 text-xs text-fg">
                    <FileSearch aria-hidden className="size-3 text-accent" />
                    {t("window.sampleArticle")}
                  </span>
                </>
              )}
              {site?.askEmail !== false && <span className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted">{t("window.email")}</span>}
              <span className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted">{t("window.message")}</span>
            </>
          ) : c.hours.outside === "form" ? (
            <>
              <span className="text-xs text-fg">{t("window.outside")}</span>
              <span className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted">{t("window.email")}</span>
              <span className="h-14 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted">{t("window.question")}</span>
              <span className="self-end rounded-md px-2.5 py-1 text-xs" style={{ background: c.window.colour, color: textOn(c.window.colour) }}>
                {t("window.send")}
              </span>
            </>
          ) : (
            <span className="text-xs text-fg-muted">{t("window.hidden")}</span>
          )}
          <span className="text-2xs text-fg-muted">
            {t("window.privacy")} {c.window.privacy && t("window.privacyLink")}
          </span>
        </div>
      </div>
      <span className="sr-only">{host}</span>
    </div>
  );
}

/** Black or white, whichever reads better on the colour, as the window picks it. */
function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#111" : "#fff";
}

export function WindowPage({ settings }: { settings: Settings }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [state, setState] = useState<"open" | "closed">("open");
  const [copied, setCopied] = useState(false);
  const c = settings.config!;
  const [site, setSite] = useState(c.sites[0]?.id ?? "");
  const tag = `<script src="${window.location.origin}/w/${site || "<site>"}.js" defer></script>`;
  const lang = (["en", "de", "tr"] as const).find((l) => locale.startsWith(l)) ?? "en";
  const rule = (pages: string[]) => pages.map((p) => (p === "*" ? t("window.everything") : p)).join(", ");
  const asking = c.sites.filter((s) => s.consent);
  return (
    <>
      <PageHeader title={t("window.title")} description={t("window.description")} />
      <div className="mb-2.5">
        <SegmentedControl
          label={t("window.show")}
          value={state}
          onChange={setState}
          options={[
            { value: "open", label: t("window.inHours") },
            { value: "closed", label: t("window.outsideHours") },
          ]}
        />
      </div>
      <div className="lc-side-wide grid gap-2.5">
        <Panel flush aria-label={t("window.preview")}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs text-fg-muted">
            <Globe aria-hidden className="size-3.5" />
            <span className="truncate font-mono">{`${c.sites.find((s) => s.id === site)?.origins[0] ?? "https://www.example.com"}/pricing`}</span>
          </div>
          <Preview settings={settings} open={state === "open"} lang={lang} />
        </Panel>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("window.install")} description={t("window.installDetail")}>
            <div className="flex flex-col gap-2">
              {c.sites.length > 1 && (
                <SelectField
                  aria-label={t("window.site")}
                  value={site}
                  onChange={(e) => (setSite(e.target.value), setCopied(false))}
                  options={c.sites.map((s) => ({ value: s.id, label: `${s.id} (${s.origins.map((o) => new URL(o).host).join(", ")})` }))}
                />
              )}
              {c.sites.length === 0 ? (
                <p className="text-xs text-fg-muted">{t("window.noSites")}</p>
              ) : (
                <span className="flex items-start gap-1 rounded-md bg-canvas px-2 py-1.5">
                  <code className="min-w-0 grow font-mono text-2xs break-all text-fg">{tag}</code>
                  <IconButton label={t("window.copy")} size="xs" onClick={() => void navigator.clipboard?.writeText(tag).finally(() => setCopied(true))}>
                    <Copy className="size-3.5" />
                  </IconButton>
                </span>
              )}
              {copied && (
                <p role="status" className="text-xs text-success">
                  {t("window.copied")}
                </p>
              )}
            </div>
          </Panel>
          <Panel title={t("window.rules")} description={t("window.rulesDetail")}>
            <ul aria-label={t("window.rulesLabel")} className="lc-list flex flex-col gap-1.5 text-xs">
              {c.routes.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-fg">{rule(r.pages)}</span>
                  <Badge>{c.teams.find((x) => x.id === r.team)?.name ?? r.team}</Badge>
                </li>
              ))}
              {!c.routes.some((r) => r.pages.includes("*")) && (
                <li className="flex items-center justify-between gap-2">
                  <span className="text-fg">{t("window.everythingElse")}</span>
                  <Badge>{c.teams[0]!.name}</Badge>
                </li>
              )}
            </ul>
            <p className="mt-2 text-2xs text-fg-muted">
              {asking.length
                ? t("window.consent", { sites: asking.map((s) => s.id).join(", "), purposes: [...new Set(asking.map((s) => s.consent))].join(", ") })
                : t("window.noConsent")}
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Reports

export function ReportsPage({ call }: { call: Call }) {
  const t = useT();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [r] = useLoad<Report>(call, `/api/v1/report?days=${days}`);
  type Row = Report["byTeam"][number];
  const cols: Column<Row>[] = [
    { id: "team", header: t("reports.team"), sortValue: (x) => x.name, cell: (x) => <span className="font-medium">{x.name}</span> },
    { id: "chats", header: t("reports.chats"), align: "right", mono: true, sortValue: (x) => x.chats, cell: (x) => fmt(x.chats) },
    {
      id: "first",
      header: t("reports.firstAnswer"),
      align: "right",
      sortValue: (x) => x.firstAnswer ?? -1,
      cell: (x) => <span className="text-xs">{x.firstAnswer === null ? "–" : duration(x.firstAnswer, t)}</span>,
    },
    { id: "tickets", header: t("reports.tickets"), align: "right", mono: true, sortValue: (x) => x.tickets, cell: (x) => fmt(x.tickets) },
    { id: "leads", header: t("reports.leads"), align: "right", mono: true, sortValue: (x) => x.leads, cell: (x) => fmt(x.leads) },
  ];
  const hours = r ? hoursUsed(r.byHour) : [];
  const tk = r?.totals.tickets;
  return (
    <>
      <PageHeader title={t("reports.title")} description={t("reports.description", { days })}>
        <Tabs
          label={t("reports.period")}
          value={days}
          onChange={setDays}
          items={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t("reports.days", { count: Number(d) }) }))}
        />
      </PageHeader>
      {r === null && <EmptyState title={t("common.loadFailed")} />}
      {r && tk && (
        <>
          <KpiGrid minWidth={160} className="mb-2.5">
            <KpiCard
              label={t("reports.chats")}
              value={fmt(r.totals.chats)}
              delta={{ label: t("reports.answered", { count: r.totals.answered }), intent: "neutral" }}
            />
            <KpiCard
              label={t("reports.firstAnswer")}
              value={r.totals.firstAnswer === null ? "–" : duration(r.totals.firstAnswer, t)}
              unit={t("overview.median")}
            />
            <KpiCard label={t("reports.slow")} value={fmt(r.totals.slow)} tone={r.totals.slow ? "warning" : undefined} />
            <KpiCard
              label={t("reports.tickets")}
              value={fmt(tk.unanswered + tk.leftOpen + tk.agent + tk.afterHours)}
              delta={{
                label: t("reports.ticketsSplit", { unanswered: tk.unanswered, left: tk.leftOpen, agent: tk.agent, after: tk.afterHours }),
                intent: "neutral",
              }}
            />
            <KpiCard label={t("reports.leads")} value={fmt(r.totals.leads)} />
          </KpiGrid>
          <Panel title={t("reports.perDay")} className="mb-2.5">
            <TimeSeriesChart
              label={t("reports.perDayLabel")}
              labels={r.series.map((d) => shortDay(d.day))}
              height={190}
              area={false}
              xTicks={7}
              format={(v) => fmt(Math.round(v))}
              series={[
                { id: "chats", name: t("reports.chats"), data: r.series.map((d) => d.chats), color: "var(--oa-chart-1)" },
                { id: "tickets", name: t("reports.tickets"), data: r.series.map((d) => d.tickets), color: "var(--oa-chart-2)" },
                { id: "leads", name: t("reports.leads"), data: r.series.map((d) => d.leads), color: "var(--oa-success)" },
              ]}
            />
          </Panel>
          <div className="lc-halves mb-2.5 grid gap-2.5">
            <Panel title={t("reports.byHour")} description={t("reports.byHourDetail", { zone: r.timeZone })}>
              <Heatmap
                label={t("reports.byHourLabel")}
                rows={weekdays()}
                columns={hours.map((h) => String(h).padStart(2, "0"))}
                values={r.byHour.map((d) => hours.map((h) => d[h]!))}
                unit={` ${t("reports.chatsUnit")}`}
              />
            </Panel>
            <Panel title={t("reports.byPage")}>
              {r.byPage.length ? (
                <BarList
                  label={t("reports.byPage")}
                  items={r.byPage.map((p) => ({ id: p.page, label: <span className="font-mono">{p.page}</span>, value: p.chats }))}
                />
              ) : (
                <p className="text-sm text-fg-muted">{t("overview.noChats")}</p>
              )}
            </Panel>
          </div>
          <Panel flush title={t("reports.byTeam")}>
            <DataTable label={t("reports.byTeam")} columns={cols} rows={r.byTeam} getRowId={(x) => x.id} minWidth={560} />
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Integrations

function linkBadge(l: LinkState, t: T, locale: string) {
  if (!l.linked) return <StatusBadge tone="neutral">{t("integrations.notLinked")}</StatusBadge>;
  if (!l.secretSet) return <StatusBadge tone="danger">{t("integrations.noSecret", { name: l.secret ?? "" })}</StatusBadge>;
  if (l.errorAt && (!l.okAt || l.errorAt > l.okAt))
    return <StatusBadge tone="danger">{t("integrations.failing", { when: ago(l.errorAt, locale) })}</StatusBadge>;
  if (l.okAt) return <StatusBadge tone="success">{t("integrations.worked", { when: ago(l.okAt, locale) })}</StatusBadge>;
  return <StatusBadge tone="neutral">{t("integrations.notYet")}</StatusBadge>;
}

export function IntegrationsPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [l] = useLoad<Integrations>(call, "/api/v1/integrations", 30_000);
  const c = settings.config!;
  const origin = window.location.origin;
  const site = c.sites[0]?.id ?? "www";
  const panel = (key: keyof Integrations, title: string, detail: string, code: string) => (
    <Panel title={title} description={detail} actions={l && linkBadge(l[key], t, locale)}>
      {l?.[key].url && <p className="mb-1.5 font-mono text-2xs text-fg-muted">{l[key].url}</p>}
      {l?.[key].error && l[key].errorAt && (!l[key].okAt || l[key].errorAt! > l[key].okAt!) && (
        <p className="mb-1.5 text-xs text-danger-text">{l[key].error}</p>
      )}
      {key === "helpdesk" && l && l.helpdesk.pending > 0 && (
        <p className="mb-1.5 text-xs text-warning-text">{t("integrations.pending", { count: l.helpdesk.pending })}</p>
      )}
      <Code label={title}>{code}</Code>
    </Panel>
  );
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="lc-halves grid gap-2.5">
        <Panel title={t("integrations.script")} description={t("integrations.scriptDetail")}>
          <Code label={t("integrations.script")}>
            {c.sites.length
              ? c.sites
                  .map((s) => `<!-- ${s.origins.map((o) => new URL(o).host).join(", ")} -->\n<script src="${origin}/w/${s.id}.js" defer></script>`)
                  .join("\n")
              : `<script src="${origin}/w/${site}.js" defer></script>`}
          </Code>
          <p className="mt-2 text-xs text-fg-muted">{t("integrations.scriptCsp", { origin })}</p>
        </Panel>
        {panel(
          "helpdesk",
          "Helpdesk",
          t("integrations.helpdeskDetail"),
          `# helpdesk.yaml, in Helpdesk
sources:
  live-chat: { channel: chat, key: HELPDESK_LIVE_CHAT_KEY }

# live-chat.yaml
helpdesk:
  url: ${c.helpdesk?.url ?? "http://helpdesk:8080"}
  key: ${c.helpdesk?.key ?? "LIVE_CHAT_HELPDESK_KEY"}   # the same key as HELPDESK_LIVE_CHAT_KEY`,
        )}
        {panel(
          "analytics",
          "Analytics",
          t("integrations.analyticsDetail"),
          `analytics:
  url: ${c.analytics?.url ?? "https://analytics.example.com"}
  token: ${c.analytics?.token ?? "LIVE_CHAT_ANALYTICS_TOKEN"}   # an API token with the viewer role
# The window sends openasy.ids() when Analytics' script is on the page.`,
        )}
        {panel(
          "crm",
          "CRM",
          t("integrations.crmDetail"),
          `POST ${c.crm?.url ?? "https://crm.example.com"}/api/v1/leads
Authorization: Bearer $${c.crm?.token ?? "LIVE_CHAT_CRM_TOKEN"}

{ "external_id": "live-chat-<chat id>", "source": "live-chat", "name", "email",
  "page", "title", "owner": { "name", "email" }, "referrer", "utm",
  "pages": [{ "at", "path" }], "transcript": [{ "from", "name", "at", "text" }], "chat_url" }

201 { "lead": { "id", "url" } }   200 for the same external_id again`,
        )}
        {panel(
          "knowledgeBase",
          "Knowledge Base",
          t("integrations.kbDetail"),
          `knowledge_base:
  url: ${c.knowledgeBase?.url ?? "https://kb.example.com"}
# GET /api/v1/suggest?place=live-chat`,
        )}
        <Panel title="Consent" description={t("integrations.consentDetail")}>
          <Code label="Consent">{`sites:
  ${site}:
    consent: { purpose: ${c.sites.find((s) => s.consent)?.consent ?? "support"} }
# The window waits for OpenAsyConsent.get("<purpose>") or the openasy:consent event.`}</Code>
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <p className="text-xs">
            <a href="/api/docs/">{t("integrations.reference")}</a>
          </p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const c = settings.config!;
  const [locale] = useLocalePreference();
  const file = settings.file;
  const name = file?.path.split("/").pop() ?? "live-chat.yaml";
  const linked = (v: { url: string } | null) => v?.url ?? t("settings.notLinked");
  return (
    <FileSettingsPage
      file={name}
      applied={file?.appliedAt ? ago(file.appliedAt, locale) : t("settings.notYet")}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        file && (file.error || file.warnings.length > 0) ? (
          <Callout tone={file.error ? "danger" : "warning"} title={file.error ? t("settings.notApplied") : t("settings.warnings")} className="mb-2.5">
            <ul className="lc-list flex flex-col gap-1">
              {[...(file.error ? [file.error] : []), ...file.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : undefined
      }
      groups={[
        {
          title: t("settings.sites"),
          items: c.sites.length
            ? c.sites.map((s) => ({
                label: s.id,
                value: (
                  <span className="flex flex-col">
                    <span className="font-mono">{s.origins.map((o) => new URL(o).host).join(", ")}</span>
                    <span className="text-2xs text-fg-muted">
                      {[
                        s.askEmail ? t("settings.asksEmail") : t("settings.noEmail"),
                        s.consent ? t("settings.waitsFor", { purpose: s.consent }) : null,
                        s.analytics ? t("settings.analyticsSite", { site: s.analytics }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                ),
                path: `sites.${s.id}`,
              }))
            : [{ label: t("settings.sites"), value: t("settings.none"), path: "sites" }],
        },
        {
          title: t("settings.hours"),
          items: [
            {
              label: t("settings.workingHours"),
              value: c.hours.text === "always" ? t("overview.always") : `${c.hours.described}, ${c.hours.timeZone}`,
              path: "hours",
            },
            {
              label: t("settings.outside"),
              value: c.hours.outside === "form" ? t("settings.outsideForm") : t("settings.outsideHidden"),
              path: "hours.outside",
            },
            { label: t("settings.holidays"), value: c.hours.holidays.length ? c.hours.holidays.join(", ") : t("settings.none"), path: "hours.holidays" },
          ],
        },
        {
          title: t("settings.teams"),
          items: [
            ...c.teams.map((x) => ({
              label: x.name,
              value: [
                x.groups.length ? t("settings.groups", { groups: x.groups.join(", ") }) : null,
                x.members.length ? t("settings.members", { count: x.members.length }) : null,
                !x.groups.length && !x.members.length ? t("settings.everyone") : null,
                x.queue ? t("settings.queue", { queue: x.queue }) : null,
              ]
                .filter(Boolean)
                .join("; "),
              path: `teams.${x.id}`,
            })),
            {
              label: t("settings.routes"),
              value: c.routes.length
                ? c.routes.map((r) => `${r.pages.join(", ")} → ${c.teams.find((x) => x.id === r.team)?.name}`).join("; ")
                : t("settings.firstTeam", { team: c.teams[0]!.name }),
              path: "routes",
            },
          ],
        },
        {
          title: t("settings.window"),
          items: [
            { label: t("settings.windowTitle"), value: c.window.title, path: "window.title" },
            {
              label: t("settings.colour"),
              value: (
                <span className="flex items-center gap-1.5 font-mono">
                  <span aria-hidden className="lc-swatch rounded" style={{ background: c.window.colour }} />
                  {c.window.colour}
                </span>
              ),
              path: "window.colour",
            },
            {
              label: t("settings.articles"),
              value: c.window.suggestArticles && c.knowledgeBase ? t("settings.articlesOn") : t("settings.articlesOff"),
              path: "window.suggest_articles",
            },
            { label: t("settings.answers"), value: c.answers.length ? c.answers.map((a) => a.title).join(", ") : t("settings.none"), path: "answers" },
          ],
        },
        {
          title: t("settings.chats"),
          items: [
            { label: t("settings.ticketAfter"), value: duration(c.chats.ticketAfter, t), path: "chats.ticket_after" },
            { label: t("settings.closeAfter"), value: duration(c.chats.closeAfter, t), path: "chats.close_after" },
            {
              label: t("settings.files"),
              value: c.files.types.length
                ? `${c.files.types.join(", ")}; ${t("settings.upTo", { mb: Math.round(c.files.maxSize / 1048576) })}`
                : t("settings.filesOff"),
              path: "files",
            },
            { label: t("settings.kept"), value: duration(c.keepChats, t), path: "keep_chats" },
          ],
        },
        {
          title: t("settings.links"),
          items: [
            { label: "Helpdesk", value: linked(c.helpdesk), path: "helpdesk.url" },
            { label: "Analytics", value: linked(c.analytics), path: "analytics.url" },
            { label: "CRM", value: linked(c.crm), path: "crm.url" },
            { label: "Knowledge Base", value: linked(c.knowledgeBase), path: "knowledge_base.url" },
          ],
        },
      ]}
    />
  );
}
