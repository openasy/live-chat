// Chats: the open chats with the page each visitor is on, one conversation, and the visitor beside it with their pages
// from Analytics, a lead for CRM, a ticket for Helpdesk and suggested articles. Several chats at once: the list follows
// the stream, and the chat on screen gets its lines as they are said.
import { useAuth } from "@openasy/auth/react";
import { Badge, Button, EmptyState, IconButton, navigate, PageHeader, Panel, SelectField } from "@openasy/ui";
import { FileSearch, Handshake, LifeBuoy, Monitor, Paperclip, SendHorizontal, Smartphone, Tablet, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Chat, ChatDetail, Integrations, Line, Member, Settings, VisitorInfo } from "./api.ts";
import { clientId, duration, fmt, Notice, time, useLive, useLoad, useNow, visitorName, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const waitingFor = (c: Chat, now: number) => (c.waitingSince ? now - Date.parse(c.waitingSince) : null);

/** A system line, as the team reads it. */
function systemText(l: Line, t: T): string {
  const d = (l.data ?? {}) as Record<string, string | number | null | boolean>;
  switch (l.event) {
    case "started":
      return d.rule
        ? t("line.startedRule", { page: String(d.page), team: String(d.team), rule: String(d.rule) })
        : t("line.started", { page: String(d.page), team: String(d.team) });
    case "joined":
      return t("line.joined", { name: String(d.name) });
    case "handed":
      return [
        d.to
          ? t("line.handedTo", { by: String(d.by), to: String(d.to) })
          : d.team
            ? t("line.handedTeam", { by: String(d.by), team: String(d.team) })
            : t("line.released", { by: String(d.by) }),
        d.to && d.team ? t("line.andTeam", { team: String(d.team) }) : "",
        l.text ? `: ${l.text}` : "",
      ].join("");
    case "closed":
      return d.by === "visitor" ? t("line.closedVisitor") : d.by === "idle" ? t("line.closedIdle") : t("line.closedAgent", { name: String(d.name ?? "") });
    case "ticket":
      return t("line.ticket", { number: Number(d.number) });
    case "ticket-asked":
      return t("line.ticketAsked", { by: String(d.by) });
    case "lead":
      return t("line.lead", { by: String(d.by) });
    case "ask-email":
      return t("line.askEmail");
    case "articles":
      return t("line.articles", { count: Array.isArray(d.articles) ? (d.articles as unknown[]).length : 0 });
    default:
      return l.event ?? "";
  }
}

// ---------------------------------------------------------------- the list

function ChatList({ chats, active, now }: { chats: Chat[]; active: number | null; now: number }) {
  const t = useT();
  if (!chats.length) return <p className="px-3 py-3 text-sm text-fg-muted">{t("chats.none")}</p>;
  return (
    <ul className="lc-list flex flex-col py-1">
      {chats.map((c) => {
        const wait = waitingFor(c, now);
        const unanswered = !c.firstAnswerAt && c.status === "open";
        return (
          <li key={c.number}>
            <a
              href={`/chats/${c.number}`}
              aria-current={c.number === active ? "true" : undefined}
              className={`lc-chat flex w-full flex-col gap-0.5 px-3 py-2 text-left no-underline ${c.number === active ? "bg-accent-soft" : ""}`}
            >
              <span className="flex items-center gap-2">
                <span className={`truncate text-sm font-medium ${c.number === active ? "text-accent-text" : "text-fg"}`}>{visitorName(c, t)}</span>
                {c.status === "closed" ? (
                  <Badge className="ml-auto">{t("chats.closed")}</Badge>
                ) : wait !== null && (unanswered || wait > 60_000) ? (
                  <Badge tone="warning" className="ml-auto">
                    {t("chats.waiting", { time: duration(wait, t) })}
                  </Badge>
                ) : (
                  <span className="ml-auto text-2xs text-fg-muted">{duration(now - Date.parse(c.createdAt), t)}</span>
                )}
              </span>
              <span className="truncate font-mono text-2xs text-fg-muted">{c.pageNow ?? c.page}</span>
              <span className="truncate text-2xs text-fg-muted">
                {c.team.name} · {c.agent?.name ?? t("chats.notAnswered")}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- the conversation

function Conversation({ lines, label }: { lines: Line[]; label: string }) {
  const t = useT();
  const end = useRef<HTMLLIElement>(null);
  // A block body: scrollIntoView returns a promise in newer browsers, and an effect may return only its clean-up.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lines.length]);
  return (
    <ol aria-label={label} className="lc-list lc-conversation flex flex-col gap-2 p-3">
      {lines.map((l) =>
        l.kind === "system" ? (
          <li key={l.id} className="text-center text-2xs text-fg-muted">
            {time(l.at)} · {systemText(l, t)}
            {!l.shown && <span className="sr-only"> ({t("chat.teamOnly")})</span>}
          </li>
        ) : (
          <li key={l.id} className={`lc-line flex flex-col gap-0.5 ${l.kind === "agent" ? "lc-mine items-end" : ""}`}>
            <span className="text-2xs text-fg-muted">
              {l.kind === "visitor" ? l.author?.name || t("chat.visitorShort") : l.author?.name} ·{" "}
              {l.state === "sending" ? t("chat.sending") : l.state === "failed" ? t("chat.notSent") : time(l.at)}
            </span>
            <span
              className={`lc-bubble rounded-lg px-3 py-2 text-sm ${l.kind === "agent" ? "bg-accent text-accent-contrast" : "bg-subtle text-fg"} ${l.state ? "opacity-50" : ""}`}
            >
              {l.file ? (
                <a href={`/api/v1/files/${l.file.id}`} target="_blank" rel="noopener noreferrer" className="lc-file">
                  {l.file.type.startsWith("image/") ? (
                    <img src={`/api/v1/files/${l.file.id}`} alt={l.file.name} className="lc-image" />
                  ) : (
                    `${l.file.name} (${Math.max(1, Math.round(l.file.size / 1024))} KB)`
                  )}
                </a>
              ) : (
                l.text
              )}
            </span>
          </li>
        ),
      )}
      <li ref={end} aria-hidden className="h-px" />
    </ol>
  );
}

function Composer({
  disabled,
  answers,
  files,
  agent,
  visitor,
  onSend,
  onFile,
}: {
  disabled: boolean;
  answers: ChatDetail["answers"];
  files: { types: string[]; maxSize: number };
  agent: string;
  visitor: string;
  onSend: (text: string) => void;
  onFile: (f: File) => void;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form onSubmit={submit} className="border-t border-line p-2.5">
      {error && (
        <p role="alert" className="mb-1.5 text-xs text-danger-text">
          {error}
        </p>
      )}
      <div className="lc-composer flex flex-col rounded-md border border-line bg-surface">
        <label htmlFor={id} className="sr-only">
          {t("chat.message")}
        </label>
        <textarea
          id={id}
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e as unknown as FormEvent);
          }}
          placeholder={disabled ? t("chat.closedPlaceholder") : t("chat.placeholder")}
          maxLength={5000}
          className="lc-textarea w-full bg-transparent px-2.5 pt-2 text-sm text-fg outline-none"
        />
        <span className="flex items-center gap-1 px-1.5 pb-1.5">
          {files.types.length > 0 && (
            <>
              <IconButton label={t("chat.attach")} size="xs" disabled={disabled} onClick={() => file.current?.click()}>
                <Paperclip className="size-3.5" />
              </IconButton>
              <input
                ref={file}
                type="file"
                hidden
                accept={files.types.join(",")}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (!files.types.includes(f.type)) return setError(t("chat.wrongType", { types: files.types.join(", ") }));
                  if (f.size > files.maxSize) return setError(t("chat.tooBig", { mb: Math.round(files.maxSize / 1048576) }));
                  setError(null);
                  onFile(f);
                }}
              />
            </>
          )}
          {answers.length > 0 && (
            <SelectField
              aria-label={t("chat.savedAnswers")}
              value=""
              disabled={disabled}
              className="lc-answers"
              onChange={(e) => {
                const a = answers.find((x) => x.id === e.target.value);
                if (a) setText((x) => (x ? `${x}\n` : "") + a.text.replaceAll("{agent}", agent).replaceAll("{name}", visitor));
              }}
              options={[{ value: "", label: t("chat.savedAnswers") }, ...answers.map((a) => ({ value: a.id, label: a.title }))]}
            />
          )}
          <span className="grow" />
          <Button type="submit" size="xs" variant="primary" icon={<SendHorizontal />} disabled={disabled || !text.trim()}>
            {t("chat.send")}
          </Button>
        </span>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the visitor beside it

function VisitorPanel({
  call,
  chat,
  links,
  onLead,
  onTicket,
  busy,
}: {
  call: Call;
  chat: ChatDetail;
  links: Integrations | null | undefined;
  onLead: () => void;
  onTicket: () => void;
  busy: boolean;
}) {
  const t = useT();
  const { can } = useAuth();
  const [info] = useLoad<VisitorInfo>(call, `/api/v1/chats/${chat.number}/visitor`, 60_000);
  const visit = info?.visit ?? null;
  const pages = visit?.pages.length ? visit.pages : (info?.pages ?? chat.pages).map((p) => ({ ...p, seconds: null }));
  const from =
    visit?.utm.source || visit?.utm.campaign
      ? [visit.utm.source, visit.utm.medium, visit.utm.campaign].filter(Boolean).join(" · ")
      : (visit?.source ?? chat.referrer ?? t("visitor.direct"));
  const DeviceIcon = chat.visitor.device === "phone" ? Smartphone : chat.visitor.device === "tablet" ? Tablet : Monitor;
  const now = pages.at(-1);
  return (
    <Panel title={t("visitor.title")} aria-label={t("visitor.title")}>
      <div className="flex flex-col gap-2">
        <dl className="lc-facts grid gap-x-2 gap-y-1 text-xs">
          <dt className="text-fg-muted">{t("visitor.from")}</dt>
          <dd className="m-0 text-fg">{from}</dd>
          <dt className="text-fg-muted">{t("visitor.where")}</dt>
          <dd className="m-0 flex items-center gap-1 text-fg">
            <DeviceIcon aria-hidden className="size-3" />
            {[chat.visitor.device ? t(`visitor.device.${chat.visitor.device}`) : null, visit?.browser, visit?.os].filter(Boolean).join(" · ") ||
              t("visitor.unknown")}
          </dd>
          <dt className="text-fg-muted">{t("visitor.email")}</dt>
          <dd className="m-0 truncate font-mono text-fg">{chat.visitor.email ?? t("visitor.notGiven")}</dd>
          <dt className="text-fg-muted">{t("visitor.site")}</dt>
          <dd className="m-0 text-fg">{chat.site}</dd>
        </dl>
        <section className="flex flex-col gap-1 border-t border-line pt-2">
          <h3 className="text-xs font-semibold text-fg-muted">{info?.linked && info.ids ? t("visitor.pagesAnalytics") : t("visitor.pagesWindow")}</h3>
          <ol aria-label={t("visitor.pagesVisited")} className="lc-list flex flex-col gap-1">
            {pages.map((v) => (
              <li key={v.at + v.path} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 font-mono whitespace-nowrap text-fg-muted">{time(v.at)}</span>
                <span className="min-w-0 grow truncate font-mono text-fg" title={v.title ?? undefined}>
                  {v.path}
                </span>
                <span className="shrink-0 text-2xs text-fg-muted">
                  {v.seconds !== null ? duration(v.seconds * 1000, t) : v === now && chat.status === "open" ? t("visitor.hereNow") : ""}
                </span>
              </li>
            ))}
          </ol>
          {info?.error && <p className="text-2xs text-warning-text">{info.error}</p>}
          {info && !info.linked && <p className="text-2xs text-fg-muted">{t("visitor.analyticsOff")}</p>}
        </section>
        {can("editor") && (links?.crm.linked || links?.helpdesk.linked) && (
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
            {links.crm.linked &&
              (chat.lead ? (
                chat.lead.url ? (
                  <a href={chat.lead.url} target="_blank" rel="noopener noreferrer" className="text-xs">
                    {t("visitor.leadOpen")}
                  </a>
                ) : (
                  <Badge tone="success">{t("visitor.leadDone")}</Badge>
                )
              ) : (
                <Button size="sm" icon={<Handshake />} onClick={onLead} disabled={busy}>
                  {t("visitor.lead")}
                </Button>
              ))}
            {links.helpdesk.linked &&
              (chat.ticket?.number ? (
                <Badge mono>{t("visitor.ticketBadge", { number: chat.ticket.number })}</Badge>
              ) : (
                <Button size="sm" variant="ghost" icon={<LifeBuoy />} onClick={onTicket} disabled={busy || (!!chat.ticket && !chat.ticket.error)}>
                  {chat.ticket ? t("visitor.ticketPending") : t("visitor.ticket")}
                </Button>
              ))}
          </div>
        )}
        {chat.ticket?.error && <p className="text-2xs text-warning-text">{t("visitor.ticketError", { error: chat.ticket.error })}</p>}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the page

export function ChatsPage({ call, number, settings, members }: { call: Call; number: number | null; settings: Settings; members: Member[] }) {
  const t = useT();
  const now = useNow(10_000);
  const { me, can } = useAuth();
  const live = useLive();
  const [links] = useLoad<Integrations>(call, "/api/v1/integrations", 120_000);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [busy, setBusy] = useState(false);
  const config = settings.config!;

  // The oldest unanswered first, then the rest by their last line; chats closed while the screen is open stay listed.
  const chats = useMemo(
    () =>
      [...live.chats].sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        if (!!a.waitingSince !== !!b.waitingSince) return a.waitingSince ? -1 : 1;
        if (a.waitingSince && b.waitingSince) return Date.parse(a.waitingSince) - Date.parse(b.waitingSince);
        return Date.parse(b.lastAt) - Date.parse(a.lastAt);
      }),
    [live.chats],
  );
  const active = number ?? chats.find((c) => c.status === "open")?.number ?? null;

  const load = useCallback(
    (n: number) =>
      call<ChatDetail>(`/api/v1/chats/${n}`).then(
        (d) => (setDetail(d), setFailed(false)),
        () => setFailed(true),
      ),
    [call],
  );
  useEffect(() => {
    setDetail(null);
    setNotice(null);
    if (active !== null) void load(active);
  }, [active, load]);

  // The chat on screen: its lines as they are said, each once, in order.
  useEffect(
    () =>
      live.listen((e) => {
        if (e.chat !== active) return;
        setDetail((d) => {
          if (!d || e.seq <= d.seq) return d;
          if (e.type === "chat") return { ...d, ...e.summary, seq: e.seq };
          if (d.lines.some((l) => l.id === e.line.id)) return { ...d, seq: e.seq };
          const lines = d.lines.filter((l) => !(l.state && l.clientId && l.clientId === e.line.clientId));
          return { ...d, lines: [...lines, e.line].sort((a, b) => a.seq - b.seq), seq: e.seq };
        });
      }),
    [live, active],
  );

  const pending = (l: Partial<Line>): Line => ({
    id: `local-${clientId()}`,
    seq: Number.MAX_SAFE_INTEGER,
    kind: "agent",
    author: { id: me.user.id, name: me.user.name },
    text: "",
    at: new Date().toISOString(),
    file: null,
    event: null,
    data: null,
    shown: true,
    clientId: clientId(),
    state: "sending",
    ...l,
  });
  const settle = (local: Line, sent: Promise<Line>) => {
    setDetail((d) => d && { ...d, lines: [...d.lines, local] });
    void sent.then(
      (line) =>
        setDetail((d) => {
          if (!d) return d;
          const lines = d.lines.filter((l) => l.id !== local.id);
          return { ...d, lines: lines.some((l) => l.id === line.id) ? lines : [...lines, line].sort((a, b) => a.seq - b.seq) };
        }),
      (err: Error) => {
        setDetail((d) => d && { ...d, lines: d.lines.map((l) => (l.id === local.id ? { ...l, state: "failed" } : l)) });
        setNotice({ text: err.message, tone: "danger" });
      },
    );
  };
  const send = (text: string) => {
    const local = pending({ text });
    settle(local, call<Line>(`/api/v1/chats/${active}/messages`, { method: "POST", body: JSON.stringify({ text, client_id: local.clientId }) }));
  };
  const sendFile = (f: File) => {
    const local = pending({ text: f.name });
    settle(
      local,
      call<Line>(`/api/v1/chats/${active}/files`, {
        method: "POST",
        body: f,
        headers: { "content-type": f.type, "x-file-name": encodeURIComponent(f.name), "x-client-id": local.clientId! },
      }),
    );
  };
  const act = async (path: string, body: unknown, done: (c: Chat) => string) => {
    setBusy(true);
    try {
      const c = await call<Chat>(`/api/v1/chats/${active}/${path}`, { method: "POST", body: JSON.stringify(body) });
      live.put(c);
      setDetail((d) => d && { ...d, ...c });
      setNotice({ text: done(c) });
    } catch (err) {
      setNotice({ text: (err as Error).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const cur = detail && detail.number === active ? detail : null;
  const closed = cur?.status === "closed";
  const others = members.filter((m) => m.id !== cur?.agent?.id);
  const teams = config.teams.filter((x) => x.id !== cur?.team.id);

  return (
    <>
      <PageHeader
        title={t("chats.title")}
        description={t("chats.description")}
        meta={!live.connected && live.ready ? <Badge tone="warning">{t("chats.reconnecting")}</Badge> : undefined}
      />
      {notice && <Notice tone={notice.tone === "danger" ? "danger" : "success"}>{notice.text}</Notice>}
      <div className="lc-inbox grid gap-2.5">
        <Panel flush aria-label={t("chats.open")} className="lc-column">
          <ChatList chats={chats} active={active} now={now} />
        </Panel>
        {active === null ? (
          <Panel aria-label={t("chats.chat")}>
            <EmptyState title={t("chats.noneTitle")}>{t("chats.noneDetail")}</EmptyState>
          </Panel>
        ) : !cur ? (
          <Panel aria-label={t("chats.chat")}>
            {failed ? <EmptyState title={t("common.loadFailed")} /> : <p className="text-sm text-fg-muted">{t("loading")}</p>}
          </Panel>
        ) : (
          <Panel
            flush
            aria-label={t("chats.chat")}
            title={visitorName(cur, t)}
            description={[t("chats.on", { page: cur.pageNow ?? cur.page }), cur.team.name, cur.agent?.name].filter(Boolean).join(" · ")}
            actions={
              !closed &&
              can("editor") && (
                <>
                  <SelectField
                    aria-label={t("chats.handTo")}
                    value=""
                    disabled={busy}
                    className="lc-hand"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      const [kind, id] = v.split(":");
                      const name = kind === "agent" ? members.find((m) => m.id === id)?.name : config.teams.find((x) => x.id === id)?.name;
                      void act("assign", kind === "agent" ? { agent: id } : { team: id }, () =>
                        t(kind === "agent" ? "chats.handed" : "chats.handedTeam", { name: name ?? "" }),
                      );
                    }}
                    options={[
                      { value: "", label: t("chats.handToColleague") },
                      ...others.map((m) => ({ value: `agent:${m.id}`, label: `${m.name}${m.state === "available" ? "" : ` (${t(`team.${m.state}`)})`}` })),
                      ...teams.map((x) => ({ value: `team:${x.id}`, label: t("chats.toTeam", { team: x.name }) })),
                    ]}
                  />
                  <IconButton
                    label={t("chats.close")}
                    disabled={busy}
                    onClick={() => void act("close", {}, () => t("chats.closedNotice", { name: visitorName(cur, t) }))}
                  >
                    <X className="size-4" />
                  </IconButton>
                </>
              )
            }
            className="lc-column"
          >
            <Conversation lines={cur.lines} label={t("chats.conversation")} />
            <Composer
              disabled={closed || !can("editor")}
              answers={cur.answers}
              files={config.files}
              agent={me.user.name}
              visitor={cur.visitor.name ?? ""}
              onSend={send}
              onFile={sendFile}
            />
          </Panel>
        )}
        {cur && (
          <div className="flex min-w-0 flex-col gap-2.5">
            <VisitorPanel
              call={call}
              chat={cur}
              links={links}
              busy={busy}
              onLead={() => void act("lead", {}, (c) => t("chats.leadNotice", { name: visitorName(c, t), owner: me.user.name }))}
              onTicket={() =>
                void act("ticket", {}, (c) =>
                  c.ticket?.number
                    ? t("chats.ticketNotice", { number: c.ticket.number, team: c.team.name })
                    : t("chats.ticketLater", { error: c.ticket?.error ?? "" }),
                )
              }
            />
            {(cur.articles.length > 0 || links?.knowledgeBase.linked) && (
              <Panel title={t("articles.title")} description={t("articles.detail")}>
                {cur.articles.length ? (
                  <ul aria-label={t("articles.title")} className="lc-list flex flex-col gap-1">
                    {cur.articles.map((a) => (
                      <li key={a.url} className="flex items-center gap-2 text-sm">
                        <FileSearch aria-hidden className="size-3.5 shrink-0 text-accent" />
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="truncate">
                          {a.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-fg-muted">{t("articles.none")}</p>
                )}
              </Panel>
            )}
            <p className="px-1 text-2xs text-fg-muted">
              {t("chats.started", { time: time(cur.createdAt), lines: fmt(cur.lines.filter((l) => l.kind !== "system").length) })}
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/** Opens the chat that was clicked in a notification or the search. */
export const openChat = (n: number) => navigate(`/chats/${n}`);
