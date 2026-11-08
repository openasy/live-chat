// Live Chat: chats from the window on a site, answered by the team, in the order they happen. Every line and every
// change to a chat is an event with a sequence number, kept in the database before anyone is told, so the team's screens
// and the visitor's window resume from the last number they saw and get each event once. Outside working hours the
// window takes a question instead; questions, and chats no one answered or that were left open, become Helpdesk
// tickets. The HTTP layer (app.ts) and the other products (links.ts) are outside; everything here works on the
// database and the applied settings.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { configWarnings, routeFor, type Config, type ConfigFileState, type Language, type Site, type Team } from "./config.ts";
import { closingAt, describeHours, isWorking, localDate, nextOpening, wallClock } from "./hours.ts";
import {
  analyticsBook,
  crmLeads,
  helpdeskDesk,
  kbSuggester,
  LinkError,
  type ArticleSuggester,
  type Lead,
  type LeadBook,
  type SuggestedArticle,
  type TicketDesk,
  type TicketRequest,
  type Visit,
  type VisitBook,
} from "./links.ts";
import { sniff } from "./sniff.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden-origin"
  | "not-found"
  | "conflict"
  | "closed"
  | "rate-limited"
  | "payload-too-large"
  | "unsupported-type"
  | "not-linked"
  | "link-failed"
  | "unavailable"
  | "internal-error";

export class LcError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who does something: a signed-in person, an API token, or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
  email?: string | null;
}

export type Range = 7 | 30 | 90;

export function parseRange(v: string | null): Range {
  if (v === null || v === "") return 30;
  const n = Number(v);
  if (n !== 7 && n !== 30 && n !== 90) throw new LcError(422, "invalid-body", "days is 7, 30 or 90.");
  return n;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Waits between tries to reach Helpdesk: 1 min, 5 min, 15 min, 1 h, 3 h, then every 6 h. */
const RETRY = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR];
/** Events are kept this long for streams to resume from; a client further behind loads the chats again. */
const KEEP_EVENTS = 2 * DAY;
/** At most this many events are replayed to a resuming client; more and it is told to load again. */
const MAX_REPLAY = 1000;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ANALYTICS_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// ------------------------------------------------------------------------------------------------------ rows and views

interface ChatRow {
  number: number;
  id: string;
  token_hash: string;
  site: string;
  team: string;
  routed_by: string | null;
  status: "open" | "closed";
  visitor_name: string | null;
  visitor_email: string | null;
  language: string | null;
  page: string;
  page_title: string | null;
  page_now: string | null;
  referrer: string | null;
  device: "desktop" | "phone" | "tablet" | null;
  analytics_visitor: string | null;
  analytics_session: string | null;
  agent_id: string | null;
  agent_name: string | null;
  created_at: string;
  first_answer_at: string | null;
  last_at: string;
  waiting_since: string | null;
  closed_at: string | null;
  closed_by: "agent" | "visitor" | "idle" | null;
  email_asked_at: string | null;
  ticket_reason: "unanswered" | "left-open" | "agent" | null;
  ticket_number: number | null;
  ticket_error: string | null;
  ticket_attempts: number;
  ticket_next_at: string | null;
  ticket_synced: number;
  lead_id: string | null;
  lead_url: string | null;
  lead_at: string | null;
  lead_by: string | null;
  articles: string | null;
}

interface LineRow {
  id: string;
  chat: number;
  seq: number;
  kind: "visitor" | "agent" | "system";
  author_id: string | null;
  author_name: string | null;
  text: string;
  file: string | null;
  client_id: string | null;
  at: string;
  event: string | null;
  data: string | null;
  visitor: number;
}

interface FileRow {
  id: string;
  chat: number;
  name: string;
  type: string;
  size: number;
  data: Uint8Array;
  at: string;
}

interface QuestionRow {
  id: string;
  site: string;
  team: string;
  name: string | null;
  email: string;
  page: string | null;
  language: string | null;
  question: string;
  at: string;
  ticket_number: number | null;
  ticket_error: string | null;
  attempts: number;
  next_at: string | null;
}

export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** A line as the team sees it. */
export interface LineView {
  id: string;
  seq: number;
  kind: "visitor" | "agent" | "system";
  author: { id: string | null; name: string } | null;
  text: string;
  at: string;
  file: FileView | null;
  /** System lines: what happened, which the UI words, and its values. */
  event: string | null;
  data: Record<string, unknown> | null;
  /** Whether the visitor's window shows it. */
  shown: boolean;
  clientId: string | null;
}

/** A line as the visitor's window gets it: no ids of the team, files by a link that is only theirs. */
export interface VisitorLine {
  id: string;
  seq: number;
  kind: "visitor" | "agent" | "system";
  name: string | null;
  text: string;
  at: string;
  file: (Omit<FileView, "id"> & { url: string }) | null;
  event: string | null;
  data: Record<string, unknown> | null;
  clientId: string | null;
}

export interface ChatSummary {
  number: number;
  site: string;
  team: { id: string; name: string };
  routedBy: string | null;
  status: "open" | "closed";
  visitor: { name: string | null; email: string | null; language: string | null; device: ChatRow["device"] };
  page: string;
  pageTitle: string | null;
  pageNow: string | null;
  referrer: string | null;
  agent: { id: string; name: string } | null;
  createdAt: string;
  lastAt: string;
  firstAnswerAt: string | null;
  /** Since when the visitor's last line has had no answer; null when the team spoke last. */
  waitingSince: string | null;
  closedAt: string | null;
  closedBy: ChatRow["closed_by"];
  ticket: { reason: NonNullable<ChatRow["ticket_reason"]>; number: number | null; error: string | null } | null;
  lead: { id: string; url: string | null; at: string; by: string | null } | null;
  last: { kind: LineView["kind"]; text: string; at: string } | null;
}

/** What the visitor's window knows about its chat. */
export interface VisitorState {
  status: "open" | "closed";
  agent: string | null;
  ticket: number | null;
  /** Whether the visitor has left an email. */
  email: boolean;
}

/** One event of a stream: what the team's screens are sent. */
export type AgentEvent = { seq: number; type: "line"; chat: number; line: LineView } | { seq: number; type: "chat"; chat: number; summary: ChatSummary };
/** What a visitor's window is sent. */
export type VisitorEvent = { seq: number; type: "line"; line: VisitorLine } | { seq: number; type: "chat"; state: VisitorState };

export interface Options {
  /** The address people open Live Chat at, for links in leads. */
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  fileState?: () => ConfigFileState | null;
  /** For tests: stand-ins for the other products. */
  helpdesk?: (c: Config) => TicketDesk | null;
  analytics?: (c: Config) => VisitBook | null;
  crm?: (c: Config) => LeadBook | null;
  kb?: (c: Config) => ArticleSuggester | null;
}

/** The state of each link, for the Integrations page: when it last worked and why it last failed. */
export interface LinkState {
  okAt: string | null;
  errorAt: string | null;
  error: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const sha = (s: string) => createHash("sha256").update(s).digest();
const randomId = (bytes = 12) => randomBytes(bytes).toString("base64url");

export const counters = {
  /** Chats started, questions sent, tickets and leads opened, by result. */
  chats: new Map<string, number>(),
  links: new Map<string, number>(),
};
const count = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);

export function createLiveChat(db: DatabaseSync, opts: Options) {
  const now = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const iso = (ms = now()) => new Date(ms).toISOString();
  let cfg: Config | null = null;
  let yaml = "";
  let desk: TicketDesk | null = null;
  let book: VisitBook | null = null;
  let leads: LeadBook | null = null;
  let kb: ArticleSuggester | null = null;
  const links: Record<"helpdesk" | "analytics" | "crm" | "knowledgeBase", LinkState> = {
    helpdesk: { okAt: null, errorAt: null, error: null },
    analytics: { okAt: null, errorAt: null, error: null },
    crm: { okAt: null, errorAt: null, error: null },
    knowledgeBase: { okAt: null, errorAt: null, error: null },
  };
  const visitCache = new Map<number, { at: number; value: Visit | null; error: string | null }>();

  const q = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as T | undefined;
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

  // ------------------------------------------------------------------ the event log and who listens to it

  type Listener = { chat: number | null; fn: (e: AgentEvent) => void };
  const listeners = new Set<Listener>();
  let pending: AgentEvent[] = [];
  let depth = 0;

  /** Runs work in one transaction; the events it made are told to listeners only once it is committed. */
  function tx<T>(work: () => T): T {
    if (depth > 0) return work();
    depth++;
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      db.exec("COMMIT");
      depth--;
      const told = pending;
      pending = [];
      for (const e of told) for (const l of listeners) if (l.chat === null || l.chat === e.chat) safely(() => l.fn(e));
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      depth--;
      pending = [];
      throw err;
    }
  }
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log("warn", "a stream listener failed", { error: String(err) });
    }
  };

  function emit(chat: number, type: "line" | "chat", shown: boolean, data: LineView | ChatSummary): number {
    const r = run("INSERT INTO events (chat, at, type, visitor, data) VALUES (?, ?, ?, ?, ?)", chat, iso(), type, shown ? 1 : 0, JSON.stringify(data));
    const seq = Number(r.lastInsertRowid);
    pending.push(type === "line" ? { seq, type, chat, line: { ...(data as LineView), seq } } : { seq, type, chat, summary: data as ChatSummary });
    return seq;
  }

  function setting(key: string, make: () => string): string {
    const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    if (row) return row.value;
    const value = make();
    run("INSERT INTO settings (key, value) VALUES (?, ?)", key, value);
    return value;
  }
  /** Signs the links to a visitor's files: made once, kept in the database. */
  const fileSecret = setting("file_secret", () => randomBytes(32).toString("hex"));
  const fileSig = (id: string) => createHmac("sha256", fileSecret).update(id).digest("base64url").slice(0, 32);

  // ------------------------------------------------------------------ settings

  function config(): Config {
    if (!cfg) throw new LcError(503, "unavailable", "The settings file is not applied yet.");
    return cfg;
  }

  function setConfig(next: Config, text: string): string[] {
    cfg = next;
    yaml = text;
    desk = opts.helpdesk ? opts.helpdesk(next) : next.helpdesk ? helpdeskDesk({ url: next.helpdesk.url, key: env[next.helpdesk.key] }) : null;
    book = opts.analytics ? opts.analytics(next) : next.analytics ? analyticsBook({ url: next.analytics.url, token: env[next.analytics.token] }) : null;
    leads = opts.crm ? opts.crm(next) : next.crm ? crmLeads({ url: next.crm.url, token: env[next.crm.token] }) : null;
    kb = opts.kb ? opts.kb(next) : next.knowledgeBase ? kbSuggester({ url: next.knowledgeBase.url, language: next.knowledgeBase.language }) : null;
    visitCache.clear();
    const warnings = configWarnings(next, env);
    const gone = q<{ team: string; n: number }>("SELECT team, COUNT(*) AS n FROM chats WHERE status = 'open' GROUP BY team").filter(
      (r) => !next.teams.some((t) => t.id === r.team),
    );
    for (const g of gone) warnings.push(`${g.n} open chats are with the team ${g.team}, which is no longer in the file; hand them to another team.`);
    return warnings;
  }

  const teamOf = (id: string): Team => {
    const c = config();
    return c.teams.find((t) => t.id === id) ?? { id, name: id, groups: [], members: [], queue: null };
  };
  const siteOf = (id: string): Site | null => config().sites.find((s) => s.id === id) ?? null;
  /** The site whose pages are on this origin, if any. */
  const siteFor = (origin: string | undefined): Site | null => (origin ? (cfg?.sites.find((s) => s.origins.includes(origin)) ?? null) : null);

  function linkOk(name: keyof typeof links) {
    links[name].okAt = iso();
    count(counters.links, `${name}:ok`);
  }
  function linkFailed(name: keyof typeof links, err: unknown) {
    links[name].errorAt = iso();
    links[name].error = err instanceof Error ? err.message : String(err);
    count(counters.links, `${name}:failed`);
  }

  // ------------------------------------------------------------------ views

  const chatRow = (n: number) => one<ChatRow>("SELECT * FROM chats WHERE number = ?", n);
  function mustChat(n: number): ChatRow {
    const c = chatRow(n);
    if (!c) throw new LcError(404, "not-found", `There is no chat ${n}.`);
    return c;
  }
  const fileView = (f: Pick<FileRow, "id" | "name" | "type" | "size">): FileView => ({ id: f.id, name: f.name, type: f.type, size: f.size });

  function lineView(l: LineRow, files: Map<string, FileView>): LineView {
    return {
      id: l.id,
      seq: l.seq,
      kind: l.kind,
      author: l.kind === "system" ? null : { id: l.author_id, name: l.author_name ?? "" },
      text: l.text,
      at: l.at,
      file: l.file ? (files.get(l.file) ?? null) : null,
      event: l.event,
      data: json<Record<string, unknown> | null>(l.data, null),
      shown: l.visitor === 1,
      clientId: l.client_id,
    };
  }

  function summary(c: ChatRow): ChatSummary {
    const last = one<{ kind: LineView["kind"]; text: string; at: string }>(
      "SELECT kind, text, at FROM lines WHERE chat = ? AND kind != 'system' ORDER BY seq DESC LIMIT 1",
      c.number,
    );
    const team = cfg ? teamOf(c.team) : { id: c.team, name: c.team };
    return {
      number: c.number,
      site: c.site,
      team: { id: team.id, name: team.name },
      routedBy: c.routed_by,
      status: c.status,
      visitor: { name: c.visitor_name, email: c.visitor_email, language: c.language, device: c.device },
      page: c.page,
      pageTitle: c.page_title,
      pageNow: c.page_now,
      referrer: c.referrer,
      agent: c.agent_id ? { id: c.agent_id, name: c.agent_name ?? "" } : null,
      createdAt: c.created_at,
      lastAt: c.last_at,
      firstAnswerAt: c.first_answer_at,
      waitingSince: c.waiting_since,
      closedAt: c.closed_at,
      closedBy: c.closed_by,
      ticket: c.ticket_reason ? { reason: c.ticket_reason, number: c.ticket_number, error: c.ticket_error } : null,
      lead: c.lead_id ? { id: c.lead_id, url: c.lead_url, at: c.lead_at!, by: c.lead_by } : null,
      last: last ? { kind: last.kind, text: last.text.slice(0, 160), at: last.at } : null,
    };
  }

  const visitorState = (s: ChatSummary): VisitorState => ({
    status: s.status,
    agent: s.agent?.name ?? null,
    ticket: s.ticket?.number ?? null,
    email: !!s.visitor.email,
  });

  function visitorLine(l: LineView): VisitorLine {
    return {
      id: l.id,
      seq: l.seq,
      kind: l.kind,
      name: l.kind === "agent" ? (l.author?.name ?? null) : null,
      text: l.text,
      at: l.at,
      file: l.file ? { name: l.file.name, type: l.file.type, size: l.file.size, url: `/api/v1/widget/files/${l.file.id}/${fileSig(l.file.id)}` } : null,
      event: l.event,
      data: l.data,
      clientId: l.kind === "visitor" ? l.clientId : null,
    };
  }

  /** What a visitor's window is sent for an event of its chat, or null when it is the team's only. */
  function forVisitor(e: AgentEvent, shown: boolean): VisitorEvent | null {
    if (e.type === "line") return shown ? { seq: e.seq, type: "line", line: visitorLine(e.line) } : null;
    return { seq: e.seq, type: "chat", state: visitorState(e.summary) };
  }

  function linesOf(n: number, visitorOnly = false): LineView[] {
    const rows = q<LineRow>(`SELECT * FROM lines WHERE chat = ?${visitorOnly ? " AND visitor = 1" : ""} ORDER BY seq`, n);
    const files = new Map(q<FileRow>("SELECT id, name, type, size FROM files WHERE chat = ?", n).map((f): [string, FileView] => [f.id, fileView(f)]));
    return rows.map((l) => lineView(l, files));
  }

  // ------------------------------------------------------------------ writing to a chat

  interface NewLine {
    kind: LineView["kind"];
    author?: { id: string | null; name: string } | null;
    text: string;
    file?: FileView | null;
    clientId?: string | null;
    event?: string;
    data?: Record<string, unknown>;
    /** Whether the visitor's window shows it. Visitor and agent lines always are. */
    shown?: boolean;
  }

  /** Adds a line and its event; inside tx. Returns the line, or the one the same client id added before. */
  function addLine(chat: number, l: NewLine): { line: LineView; added: boolean } {
    if (l.clientId) {
      const before = one<LineRow>("SELECT * FROM lines WHERE chat = ? AND client_id = ?", chat, l.clientId);
      if (before) {
        const files = new Map(
          before.file ? q<FileRow>("SELECT id, name, type, size FROM files WHERE id = ?", before.file).map((f) => [f.id, fileView(f)]) : [],
        );
        return { line: lineView(before, files), added: false };
      }
    }
    const shown = l.kind !== "system" || !!l.shown;
    const view: LineView = {
      id: randomId(),
      seq: 0,
      kind: l.kind,
      author: l.kind === "system" ? null : (l.author ?? null),
      text: l.text,
      at: iso(),
      file: l.file ?? null,
      event: l.event ?? null,
      data: l.data ?? null,
      shown,
      clientId: l.clientId ?? null,
    };
    const seq = emit(chat, "line", shown, view);
    view.seq = seq;
    run(
      `INSERT INTO lines (id, chat, seq, kind, author_id, author_name, text, file, client_id, at, event, data, visitor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      view.id,
      chat,
      seq,
      l.kind,
      view.author?.id ?? null,
      view.author?.name ?? null,
      l.text,
      l.file?.id ?? null,
      view.clientId,
      view.at,
      view.event,
      l.data ? JSON.stringify(l.data) : null,
      shown ? 1 : 0,
    );
    return { line: view, added: true };
  }

  function patch(n: number, fields: Record<string, SQLInputValue | undefined>) {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as Array<[string, SQLInputValue]>;
    if (entries.length) run(`UPDATE chats SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE number = ?`, ...entries.map(([, v]) => v), n);
  }

  /** Tells everyone the chat changed; inside tx. */
  function changed(n: number): ChatSummary {
    const s = summary(chatRow(n)!);
    emit(n, "chat", true, s);
    return s;
  }

  const text = (v: unknown, at: string, max: number): string => {
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new LcError(422, "invalid-body", `${at} is a text of 1 to ${max} characters.`);
    return v.trim();
  };
  const optText = (v: unknown, at: string, max: number): string | null => (v === undefined || v === null || v === "" ? null : text(v, at, max));
  const clientId = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !CLIENT_ID.test(v)) throw new LcError(422, "invalid-body", "client_id is 8 to 64 letters, digits, _ and -.");
    return v;
  };
  const emailOf = (v: unknown, required: boolean): string | null => {
    if (v === undefined || v === null || v === "") {
      if (required) throw new LcError(422, "invalid-body", "email is required.");
      return null;
    }
    if (typeof v !== "string" || v.length > 254 || !EMAIL.test(v.trim())) throw new LcError(422, "invalid-body", "email is not an email address.");
    return v.trim().toLowerCase();
  };
  const language = (v: unknown): Language => {
    const l = typeof v === "string" ? v.slice(0, 2).toLowerCase() : "";
    return l === "de" || l === "tr" ? l : "en";
  };

  /** A page of the site, as its path: the address must be on one of the site's origins. Query and fragment are dropped. */
  function pageOf(site: Site, v: unknown): string {
    const u = typeof v === "string" && v.length <= 2000 ? URL.parse(v) : null;
    if (!u || !site.origins.includes(u.origin)) throw new LcError(422, "invalid-body", "page is the address of a page on the site.");
    return u.pathname.slice(0, 500) || "/";
  }

  // ------------------------------------------------------------------ hours

  function hoursNow(at = now()) {
    const c = config();
    const open = isWorking(c.hours.hours, at);
    const opens = open ? null : nextOpening(c.hours.hours, at);
    return {
      open,
      outside: c.hours.outside,
      opensAt: opens === null ? null : iso(opens),
      closesAt: open ? (closingAt(c.hours.hours, at) === null ? null : iso(closingAt(c.hours.hours, at)!)) : null,
      timeZone: c.hours.hours.timeZone,
      /** People answering now: signed in to Live Chat and not away. */
      available: available().length,
    };
  }

  // ------------------------------------------------------------------ the visitor's side

  function widgetState(site: Site) {
    const h = hoursNow();
    return { site: site.id, ...h };
  }

  /** Starts a chat from the window. Nothing about the visitor is kept before this. */
  function startChat(site: Site, body: unknown): { token: string; chat: { state: VisitorState; lines: VisitorLine[] }; seq: number } {
    const c = config();
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is an object.");
    const allowed = ["message", "client_id", "name", "email", "page", "title", "referrer", "language", "device", "analytics"];
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length) throw new LcError(422, "invalid-body", `Unknown ${extra.join(", ")}.`);
    if (!isWorking(c.hours.hours, now())) throw new LcError(409, "closed", "Outside working hours: send the question with the form instead.");
    const message = text(body.message, "message", 5000);
    const cid = clientId(body.client_id);
    const name = optText(body.name, "name", 100);
    const email = emailOf(body.email, site.askEmail);
    const page = pageOf(site, body.page);
    const title = optText(body.title, "title", 200);
    let referrer: string | null = null;
    if (typeof body.referrer === "string" && body.referrer) {
      const r = URL.parse(body.referrer);
      // The referring site only, and not the site itself.
      if (r && (r.protocol === "https:" || r.protocol === "http:") && !site.origins.includes(r.origin)) referrer = r.hostname.slice(0, 200);
    }
    const device = body.device === "phone" || body.device === "tablet" || body.device === "desktop" ? body.device : null;
    let av: string | null = null;
    let as: string | null = null;
    if (body.analytics !== undefined && body.analytics !== null) {
      if (!isObj(body.analytics)) throw new LcError(422, "invalid-body", "analytics is { visitor, session } from openasy.ids().");
      if (typeof body.analytics.visitor === "string" && ANALYTICS_ID.test(body.analytics.visitor)) av = body.analytics.visitor;
      if (typeof body.analytics.session === "string" && ANALYTICS_ID.test(body.analytics.session)) as = body.analytics.session;
    }
    const lang = language(body.language);
    const { team, rule } = routeFor(c, page);
    const id = randomId();
    const secret = randomBytes(24).toString("base64url");
    const at = iso();
    const out = tx(() => {
      const r = run(
        `INSERT INTO chats (id, token_hash, site, team, routed_by, status, visitor_name, visitor_email, language, page, page_title, page_now,
           referrer, device, analytics_visitor, analytics_session, created_at, last_at, waiting_since)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        sha(secret).toString("hex"),
        site.id,
        team.id,
        rule,
        name,
        email,
        lang,
        page,
        title,
        page,
        referrer,
        device,
        av,
        as,
        at,
        at,
        at,
      );
      const n = Number(r.lastInsertRowid);
      run("INSERT INTO pages (chat, at, path, title) VALUES (?, ?, ?, ?)", n, at, page, title);
      addLine(n, { kind: "system", text: "", event: "started", data: { page, team: team.name, rule } });
      addLine(n, { kind: "visitor", author: { id: null, name: name ?? "" }, text: message, clientId: cid });
      const s = changed(n);
      return { n, s };
    });
    count(counters.chats, "started");
    log("info", "chat started", { chat: out.n, site: site.id, team: team.id });
    if (kb && c.window.suggestArticles) void suggestFor(out.n, message, lang);
    const lines = linesOf(out.n, true).map(visitorLine);
    return { token: `${id}.${secret}`, chat: { state: visitorState(out.s), lines }, seq: lines.at(-1)?.seq ?? 0 };
  }

  /** The chat a visitor's token is for. Throws 401 for any other token. */
  function visitorChat(token: string | undefined): ChatRow {
    const m = token ? /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/.exec(token) : null;
    const row = m ? one<ChatRow>("SELECT * FROM chats WHERE id = ?", m[1]!) : undefined;
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, "hex"), sha(m![2]!))) throw new LcError(401, "invalid-token", "This chat's token is not valid.");
    return row;
  }

  function visitorView(c: ChatRow) {
    const lines = linesOf(c.number, true).map(visitorLine);
    const last = one<{ seq: number }>("SELECT MAX(seq) AS seq FROM events WHERE chat = ?", c.number);
    return { state: visitorState(summary(c)), lines, seq: last?.seq ?? 0 };
  }

  function mustBeOpen(c: ChatRow) {
    if (c.status !== "open") throw new LcError(409, "closed", "This chat is closed. Start a new one from the window.");
  }

  function visitorSay(c: ChatRow, body: unknown): { line: VisitorLine; added: boolean } {
    mustBeOpen(c);
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { text, client_id }.");
    const t = text(body.text, "text", 5000);
    const cid = clientId(body.client_id);
    const r = tx(() => {
      const added = addLine(c.number, { kind: "visitor", author: { id: null, name: c.visitor_name ?? "" }, text: t, clientId: cid });
      if (added.added) {
        patch(c.number, { last_at: iso(), waiting_since: c.waiting_since ?? iso() });
        changed(c.number);
      }
      return added;
    });
    if (r.added && c.ticket_number) void syncTickets();
    return { line: visitorLine(r.line), added: r.added };
  }

  /** The visitor's name and email, given in the window. An email lets an unanswered chat become a ticket. */
  function visitorDetails(c: ChatRow, body: unknown) {
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { name, email }.");
    const extra = Object.keys(body).filter((k) => k !== "name" && k !== "email");
    if (extra.length) throw new LcError(422, "invalid-body", `Unknown ${extra.join(", ")}.`);
    const name = body.name === undefined ? undefined : optText(body.name, "name", 100);
    const email = body.email === undefined ? undefined : emailOf(body.email, false);
    tx(() => {
      patch(c.number, {
        visitor_name: name,
        visitor_email: email,
        // A question no one answered waited for this: it can become a ticket now.
        ...(email && c.email_asked_at && !c.ticket_reason && !c.first_answer_at ? { ticket_reason: "unanswered", ticket_next_at: iso() } : {}),
      });
      changed(c.number);
    });
    void tick();
    return visitorView(chatRow(c.number)!).state;
  }

  /** The page the visitor is on now, while the chat is open. */
  function visitorPage(c: ChatRow, body: unknown) {
    if (c.status !== "open") return;
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { page, title }.");
    const site = siteOf(c.site);
    if (!site) throw new LcError(404, "not-found", "This chat's site is no longer in the settings file.");
    const page = pageOf(site, body.page);
    const title = optText(body.title, "title", 200);
    if (page === c.page_now) return;
    tx(() => {
      run("INSERT INTO pages (chat, at, path, title) VALUES (?, ?, ?, ?)", c.number, iso(), page, title);
      patch(c.number, { page_now: page });
      changed(c.number);
    });
  }

  function visitorClose(c: ChatRow) {
    if (c.status !== "open") return visitorView(c).state;
    close(c.number, "visitor", null);
    return visitorView(chatRow(c.number)!).state;
  }

  // ------------------------------------------------------------------ files

  function addFile(c: ChatRow, from: { kind: "visitor" } | { kind: "agent"; who: Actor }, type: string, name: string, data: Buffer, cid: string | null) {
    mustBeOpen(c);
    const conf = config().files;
    const declared = type.split(";")[0]!.trim().toLowerCase();
    if (!conf.types.length) throw new LcError(415, "unsupported-type", "Files are off in the settings file.");
    if (!conf.types.includes(declared))
      throw new LcError(415, "unsupported-type", `Files of type ${declared || "(none)"} are not taken; send ${conf.types.join(", ")}.`);
    if (data.length > conf.maxSize) throw new LcError(413, "payload-too-large", `A file is at most ${Math.round(conf.maxSize / 1024 / 1024)} MB.`);
    if (!data.length) throw new LcError(422, "invalid-body", "The file is empty.");
    // What the bytes are, not what the name or the browser says.
    const actual = sniff(data);
    if (actual !== declared) throw new LcError(415, "unsupported-type", `The file is not the ${declared} it says it is.`);
    const clean =
      name
        .replace(/[\u0000-\u001f\u007f/\\]/g, "")
        .trim()
        .slice(0, 200) || "file";
    const id = randomId();
    const r = tx(() => {
      if (cid) {
        const before = one<{ id: string }>("SELECT id FROM lines WHERE chat = ? AND client_id = ?", c.number, cid);
        if (before) return addLine(c.number, { kind: "visitor", text: "", clientId: cid });
      }
      run("INSERT INTO files (id, chat, name, type, size, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, c.number, clean, actual, data.length, data, iso());
      const file = { id, name: clean, type: actual, size: data.length };
      if (from.kind === "agent") answered(c, from.who);
      const added =
        from.kind === "visitor"
          ? addLine(c.number, { kind: "visitor", author: { id: null, name: c.visitor_name ?? "" }, text: clean, file, clientId: cid })
          : addLine(c.number, { kind: "agent", author: { id: from.who.id, name: from.who.name }, text: clean, file, clientId: cid });
      if (from.kind === "visitor") patch(c.number, { last_at: iso(), waiting_since: c.waiting_since ?? iso() });
      changed(c.number);
      return added;
    });
    return { ...r, visitorLine: visitorLine(r.line) };
  }

  function file(id: string): FileRow {
    const f = one<FileRow>("SELECT * FROM files WHERE id = ?", id);
    if (!f) throw new LcError(404, "not-found", "There is no such file.");
    return f;
  }

  /** A file by the link the visitor's window was given. */
  function visitorFile(id: string, sig: string): FileRow {
    const a = Buffer.from(sig);
    const b = Buffer.from(fileSig(id));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new LcError(404, "not-found", "There is no such file.");
    return file(id);
  }

  // ------------------------------------------------------------------ the team's side

  const team = () => {
    try {
      return q<{ id: string; name: string; email: string; role: string }>(
        "SELECT id, name, email, role FROM auth_users WHERE status = 'active' ORDER BY name COLLATE NOCASE",
      );
    } catch {
      return [];
    }
  };

  /** The teams a member answers for: by their Identity groups, their email, or every team that names no one. */
  function teamsOf(member: { id: string; email: string }): string[] {
    const groups = json<string[]>(one<{ groups: string }>("SELECT groups FROM agents WHERE id = ?", member.id)?.groups ?? null, []);
    return config()
      .teams.filter(
        (t) => (!t.groups.length && !t.members.length) || t.members.includes(member.email.toLowerCase()) || t.groups.some((g) => groups.includes(g)),
      )
      .map((t) => t.id);
  }

  /** Signed-in streams per member, for who is available now. */
  const online = new Map<string, number>();
  const awayOf = (id: string) => one<{ away: number }>("SELECT away FROM agents WHERE id = ?", id)?.away === 1;
  const available = () => team().filter((m) => (online.get(m.id) ?? 0) > 0 && !awayOf(m.id));

  function teamNow() {
    const open = q<{ agent_id: string; n: number }>(
      "SELECT agent_id, COUNT(*) AS n FROM chats WHERE status = 'open' AND agent_id IS NOT NULL GROUP BY agent_id",
    );
    return team()
      .filter((m) => m.role !== "viewer")
      .map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        teams: cfg ? teamsOf(m).map((t) => teamOf(t).name) : [],
        chats: open.find((o) => o.agent_id === m.id)?.n ?? 0,
        state: (online.get(m.id) ?? 0) > 0 ? (awayOf(m.id) ? "away" : "available") : "offline",
      }));
  }

  function setAway(who: Actor, away: boolean) {
    run(
      "INSERT INTO agents (id, away, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET away = excluded.away, updated_at = excluded.updated_at",
      who.id,
      away ? 1 : 0,
      iso(),
    );
    return { away };
  }

  /** The groups an identity provider sent at sign-in (ADR 0033), for the teams' group. */
  function setGroups(userId: string, groups: string[]) {
    run(
      "INSERT INTO agents (id, groups, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET groups = excluded.groups, updated_at = excluded.updated_at",
      userId,
      JSON.stringify(groups.slice(0, 200)),
      iso(),
    );
  }

  /** The team speaks: the first one to answer takes the chat. Inside tx. */
  function answered(c: ChatRow, who: Actor) {
    const fresh = chatRow(c.number)!;
    if (!fresh.agent_id && !who.id.startsWith("token:") && who.id !== "admin-token") {
      patch(c.number, { agent_id: who.id, agent_name: who.name });
      addLine(c.number, { kind: "system", text: "", event: "joined", data: { name: who.name }, shown: true });
    }
    patch(c.number, { last_at: iso(), waiting_since: null, first_answer_at: fresh.first_answer_at ?? iso() });
  }

  function agentSay(who: Actor, number: number, body: unknown) {
    const c = mustChat(number);
    mustBeOpen(c);
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { text, client_id }.");
    const t = text(body.text, "text", 5000);
    const cid = clientId(body.client_id);
    const r = tx(() => {
      const dup = cid !== null && !!one<{ id: string }>("SELECT id FROM lines WHERE chat = ? AND client_id = ?", number, cid);
      // Who takes the chat is said before their first line.
      if (!dup) answered(c, who);
      const added = addLine(number, { kind: "agent", author: { id: who.id, name: who.name }, text: t, clientId: cid });
      if (added.added) changed(number);
      return added;
    });
    if (r.added && c.ticket_number) void syncTickets();
    return r;
  }

  /** Hands the chat to a colleague, or to another team, with everything said so far. */
  function assign(who: Actor, number: number, body: unknown) {
    const c = mustChat(number);
    mustBeOpen(c);
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { agent, team, note }.");
    const extra = Object.keys(body).filter((k) => !["agent", "team", "note"].includes(k));
    if (extra.length) throw new LcError(422, "invalid-body", `Unknown ${extra.join(", ")}.`);
    if (body.agent === undefined && body.team === undefined) throw new LcError(422, "invalid-body", "Send agent, team, or both.");
    let to: { id: string; name: string } | null | undefined;
    if (body.agent !== undefined) {
      if (body.agent === null) to = null;
      else {
        const m = team().find((x) => x.id === body.agent && x.role !== "viewer");
        if (!m) throw new LcError(422, "invalid-body", "agent is the id of a member who answers chats, or null.");
        to = { id: m.id, name: m.name };
      }
    }
    let toTeam: Team | undefined;
    if (body.team !== undefined) {
      toTeam = config().teams.find((t) => t.id === body.team);
      if (!toTeam) throw new LcError(422, "invalid-body", "team is one of the teams in the settings file.");
    }
    const note = optText(body.note, "note", 2000);
    return tx(() => {
      patch(number, {
        ...(to !== undefined ? { agent_id: to?.id ?? null, agent_name: to?.name ?? null } : {}),
        ...(toTeam ? { team: toTeam.id } : {}),
      });
      addLine(number, {
        kind: "system",
        text: note ?? "",
        event: "handed",
        // The visitor is told who answers now; the note and who handed it stay with the team.
        data: { by: who.name, to: to?.name ?? null, team: toTeam?.name ?? null },
        shown: false,
      });
      if (to) addLine(number, { kind: "system", text: "", event: "joined", data: { name: to.name }, shown: true });
      return changed(number);
    });
  }

  function close(number: number, by: "agent" | "visitor" | "idle", who: Actor | null) {
    const c = mustChat(number);
    if (c.status !== "open") return summary(c);
    const out = tx(() => {
      const leftOpen = by !== "agent" && c.waiting_since && !c.ticket_reason;
      patch(number, {
        status: "closed",
        closed_at: iso(),
        closed_by: by,
        // A chat that ended on a question no one answered goes to Helpdesk.
        ...(leftOpen ? { ticket_reason: "left-open", ticket_next_at: iso() } : {}),
      });
      addLine(number, { kind: "system", text: "", event: "closed", data: { by, name: who?.name ?? null }, shown: true });
      return changed(number);
    });
    void tick();
    return out;
  }

  function agentClose(who: Actor, number: number) {
    return close(number, "agent", who);
  }

  /** Makes a Helpdesk ticket of the chat now, with everything said so far. */
  async function makeTicket(who: Actor, number: number) {
    const c = mustChat(number);
    if (!desk) throw new LcError(409, "not-linked", "Helpdesk is not linked in the settings file.");
    if (!c.ticket_reason) {
      tx(() => {
        patch(number, { ticket_reason: "agent", ticket_next_at: iso() });
        addLine(number, { kind: "system", text: "", event: "ticket-asked", data: { by: who.name }, shown: false });
        changed(number);
      });
    }
    await ticketFor(mustChat(number));
    return summary(mustChat(number));
  }

  /** Opens a lead in CRM with the chat, the pages read and the agent as its owner. */
  async function makeLead(who: Actor, number: number) {
    const c = mustChat(number);
    if (!leads) throw new LcError(409, "not-linked", "CRM is not linked in the settings file.");
    if (c.lead_id) return summary(c);
    const site = siteOf(c.site);
    const visit = await visitOf(c).catch(() => null);
    const pages = visit?.pages.length
      ? visit.pages.map((p) => ({ at: p.at, path: p.path }))
      : q<{ at: string; path: string }>("SELECT at, path FROM pages WHERE chat = ? ORDER BY at", number);
    const lines = linesOf(number).filter((l) => l.kind !== "system");
    const member = team().find((m) => m.id === who.id);
    const request = {
      external_id: `live-chat-${c.id}`,
      source: "live-chat" as const,
      name: c.visitor_name,
      email: c.visitor_email,
      page: `${site?.origins[0] ?? ""}${c.page}`,
      title: (lines.find((l) => l.kind === "visitor")?.text ?? c.page).split("\n")[0]!.slice(0, 120),
      owner: { name: who.name, email: member?.email ?? who.email ?? null },
      referrer: visit?.referrer ?? c.referrer,
      utm: visit?.utm ?? null,
      pages,
      transcript: lines.map((l) => ({
        from: l.kind as "visitor" | "agent",
        name: l.author?.name || (l.kind === "visitor" ? "Visitor" : "Agent"),
        at: l.at,
        text: l.file ? `${l.text} (${l.file.type}, ${l.file.size} bytes)` : l.text,
      })),
      chat_url: `${opts.publicUrl}/chats/${number}`,
    };
    let lead: Lead;
    try {
      lead = await leads.open(request);
      linkOk("crm");
      count(counters.chats, "lead");
    } catch (err) {
      linkFailed("crm", err);
      throw new LcError(502, "link-failed", `CRM did not take the lead: ${err instanceof Error ? err.message : String(err)}`);
    }
    return tx(() => {
      patch(number, { lead_id: lead.id, lead_url: lead.url, lead_at: iso(), lead_by: who.name });
      addLine(number, { kind: "system", text: "", event: "lead", data: { by: who.name, id: lead.id, url: lead.url }, shown: false });
      return changed(number);
    });
  }

  // ------------------------------------------------------------------ Helpdesk: chats and questions become tickets

  function transcriptOf(number: number) {
    return linesOf(number)
      .filter((l) => l.kind !== "system")
      .slice(0, 500)
      .map((l) => ({
        from: l.kind === "visitor" ? ("customer" as const) : ("agent" as const),
        name: l.author?.name || (l.kind === "visitor" ? "Visitor" : "Agent"),
        at: l.at,
        text: (l.file ? `${l.text} (file, ${l.file.type})` : l.text).slice(0, 10_000),
      }));
  }

  const retryAt = (attempts: number) => iso(now() + RETRY[Math.min(attempts, RETRY.length - 1)]!);
  let ticketing: Promise<void> | null = null;

  async function ticketFor(c: ChatRow) {
    if (!desk || c.ticket_number || !c.ticket_reason) return;
    // What the transcript holds; lines said while Helpdesk is asked go to the ticket after.
    const lastSeq = one<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM lines WHERE chat = ?", c.number)!.seq;
    const transcript = transcriptOf(c.number);
    const site = siteOf(c.site);
    const request: TicketRequest = {
      external_id: `live-chat-${c.id}`,
      ...(c.visitor_email ? { email: c.visitor_email } : {}),
      ...(c.visitor_name ? { name: c.visitor_name } : {}),
      subject: (transcript.find((l) => l.from === "customer")?.text ?? `Chat on ${c.page}`).split("\n")[0]!.slice(0, 120),
      language: c.language ?? "en",
      ...(teamOf(c.team).queue ? { form: teamOf(c.team).queue! } : {}),
      transcript: transcript.length
        ? transcript
        : [{ from: "customer", name: c.visitor_name ?? "Visitor", at: c.created_at, text: `Chat on ${site?.origins[0] ?? ""}${c.page}` }],
    };
    try {
      const t = await desk.open(request);
      linkOk("helpdesk");
      count(counters.chats, "ticket");
      tx(() => {
        // Asked twice at once (an agent's button and the round): Helpdesk gave the same ticket; it is noted once.
        if (chatRow(c.number)?.ticket_number) return;
        patch(c.number, { ticket_number: t.number, ticket_error: null, ticket_next_at: null, ticket_synced: lastSeq });
        addLine(c.number, {
          kind: "system",
          text: "",
          event: "ticket",
          data: { number: t.number, reason: c.ticket_reason, email: !!c.visitor_email },
          shown: true,
        });
        changed(c.number);
      });
      log("info", "chat became a ticket", { chat: c.number, ticket: t.number, reason: c.ticket_reason });
    } catch (err) {
      linkFailed("helpdesk", err);
      const message = err instanceof Error ? err.message : String(err);
      tx(() => {
        patch(c.number, { ticket_error: message, ticket_attempts: c.ticket_attempts + 1, ticket_next_at: retryAt(c.ticket_attempts) });
        changed(c.number);
      });
      log("warn", "chat could not become a ticket yet", { chat: c.number, error: message, permanent: err instanceof LinkError && err.permanent });
    }
  }

  async function questionTicket(x: QuestionRow) {
    if (!desk) return;
    const site = siteOf(x.site);
    try {
      const t = await desk.open({
        external_id: `live-chat-question-${x.id}`,
        email: x.email,
        ...(x.name ? { name: x.name } : {}),
        subject: x.question.split("\n")[0]!.slice(0, 120),
        message: x.page ? `${x.question}\n\n(${site?.origins[0] ?? ""}${x.page})` : x.question,
        language: x.language ?? "en",
        ...(teamOf(x.team).queue ? { form: teamOf(x.team).queue! } : {}),
      });
      linkOk("helpdesk");
      count(counters.chats, "question-ticket");
      run("UPDATE questions SET ticket_number = ?, ticket_error = NULL, next_at = NULL WHERE id = ?", t.number, x.id);
    } catch (err) {
      linkFailed("helpdesk", err);
      run(
        "UPDATE questions SET ticket_error = ?, attempts = attempts + 1, next_at = ? WHERE id = ?",
        err instanceof Error ? err.message : String(err),
        retryAt(x.attempts),
        x.id,
      );
    }
  }

  /** Lines said after a chat became a ticket go to the ticket too, in order: one round at a time, so none goes twice. */
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  function syncTickets(): Promise<void> {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        await syncRound();
      } while (syncAgain);
    })().finally(() => (syncing = null));
    return syncing;
  }

  async function syncRound() {
    if (!desk) return;
    const chats = q<ChatRow>(
      "SELECT * FROM chats WHERE ticket_number IS NOT NULL AND EXISTS (SELECT 1 FROM lines l WHERE l.chat = chats.number AND l.seq > chats.ticket_synced AND l.kind != 'system') LIMIT 50",
    );
    for (const c of chats) {
      const rows = q<LineRow>("SELECT * FROM lines WHERE chat = ? AND seq > ? AND kind != 'system' ORDER BY seq LIMIT 100", c.number, c.ticket_synced);
      for (const l of rows) {
        try {
          await desk.add(c.ticket_number!, {
            from: l.kind === "visitor" ? "customer" : "agent",
            name: l.author_name || (l.kind === "visitor" ? "Visitor" : "Agent"),
            text: (l.file ? `${l.text} (file)` : l.text).slice(0, 50_000),
          });
          linkOk("helpdesk");
          run("UPDATE chats SET ticket_synced = ? WHERE number = ?", l.seq, c.number);
        } catch (err) {
          linkFailed("helpdesk", err);
          // A ticket Helpdesk no longer takes lines for is left; the rest wait for the next round.
          if (err instanceof LinkError && err.permanent) run("UPDATE chats SET ticket_synced = ? WHERE number = ?", l.seq, c.number);
          else break;
        }
      }
    }
  }

  /** The form outside working hours: the question waits here until Helpdesk has it as a ticket. */
  function ask(site: Site, body: unknown) {
    const c = config();
    if (c.hours.outside !== "form") throw new LcError(409, "closed", "The window takes no questions outside working hours.");
    if (!isObj(body)) throw new LcError(422, "invalid-body", "The body is { email, name, question, page, language }.");
    const extra = Object.keys(body).filter((k) => !["email", "name", "question", "page", "language", "website"].includes(k));
    if (extra.length) throw new LcError(422, "invalid-body", `Unknown ${extra.join(", ")}.`);
    // A filled hidden field: a bot. It is told it worked and nothing is kept.
    if (typeof body.website === "string" && body.website.trim()) return { received: true };
    const email = emailOf(body.email, true)!;
    const question = text(body.question, "question", 5000);
    const name = optText(body.name, "name", 100);
    const page = body.page === undefined ? null : pageOf(site, body.page);
    const recent = one<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE email = ? AND at > ?", email, iso(now() - HOUR))!.n;
    if (recent >= 5) throw new LcError(429, "rate-limited", "Too many questions from this address; try again in an hour.", 3600);
    const id = randomId();
    run(
      "INSERT INTO questions (id, site, team, name, email, page, language, question, at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      site.id,
      routeFor(c, page ?? "/").team.id,
      name,
      email,
      page,
      language(body.language),
      question,
      iso(),
      iso(),
    );
    count(counters.chats, "question");
    void tick();
    return { received: true };
  }

  function questions(days: number) {
    return q<QuestionRow>("SELECT * FROM questions WHERE at > ? ORDER BY at DESC LIMIT 500", iso(now() - days * DAY)).map((x) => ({
      id: x.id,
      site: x.site,
      team: { id: x.team, name: cfg ? teamOf(x.team).name : x.team },
      name: x.name,
      email: x.email,
      page: x.page,
      language: x.language,
      question: x.question,
      at: x.at,
      ticket: x.ticket_number,
      error: x.ticket_error,
    }));
  }

  // ------------------------------------------------------------------ the rounds: tickets, idle chats, clean-up

  /** Unanswered and left-open chats become tickets, idle chats close, and waiting work is tried again. */
  async function tick() {
    if (ticketing) return ticketing;
    ticketing = (async () => {
      if (!cfg) return;
      const c = cfg;
      const at = now();
      // No one answered for chats.ticket_after: a ticket, once the visitor's email is known.
      for (const row of q<ChatRow>(
        "SELECT * FROM chats WHERE status = 'open' AND first_answer_at IS NULL AND ticket_reason IS NULL AND created_at <= ?",
        iso(at - c.chats.ticketAfter),
      )) {
        tx(() => {
          if (row.visitor_email) patch(row.number, { ticket_reason: "unanswered", ticket_next_at: iso() });
          else if (!row.email_asked_at) {
            patch(row.number, { email_asked_at: iso() });
            addLine(row.number, { kind: "system", text: "", event: "ask-email", shown: true });
          } else return;
          changed(row.number);
        });
      }
      for (const row of q<ChatRow>("SELECT * FROM chats WHERE status = 'open' AND last_at <= ?", iso(at - c.chats.closeAfter))) close(row.number, "idle", null);
      if (desk) {
        for (const row of q<ChatRow>(
          "SELECT * FROM chats WHERE ticket_reason IS NOT NULL AND ticket_number IS NULL AND (ticket_next_at IS NULL OR ticket_next_at <= ?) LIMIT 20",
          iso(at),
        ))
          await ticketFor(row);
        for (const x of q<QuestionRow>("SELECT * FROM questions WHERE ticket_number IS NULL AND (next_at IS NULL OR next_at <= ?) LIMIT 20", iso(at)))
          await questionTicket(x);
        await syncTickets();
      }
    })().finally(() => (ticketing = null));
    return ticketing;
  }

  /** Deletes what is older than the file keeps, and the stream's log past what clients resume from. */
  function purge() {
    const c = cfg;
    run("DELETE FROM events WHERE at < ?", iso(now() - KEEP_EVENTS));
    if (!c) return;
    const old = iso(now() - c.keepChats);
    const gone = run("DELETE FROM chats WHERE status = 'closed' AND closed_at < ?", old).changes;
    run("DELETE FROM questions WHERE at < ?", old);
    if (gone) log("info", "old chats deleted", { chats: Number(gone) });
  }

  // ------------------------------------------------------------------ streams

  /**
   * Sends the team's screens every event after `after`, then each new one as it happens. Returns null when `after` is
   * too far behind to replay (older than the kept log, or more than MAX_REPLAY events): load the chats again.
   */
  function subscribe(after: number, chat: number | null, fn: (e: AgentEvent) => void): { replay: AgentEvent[]; stop: () => void } | null {
    const min = one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events")!.seq;
    const top = one<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events")!.seq ?? 0;
    if (after > top) after = top;
    if (after > 0 && min !== null && after < min - 1) return null;
    const rows = q<{ seq: number; chat: number; type: "line" | "chat"; visitor: number; data: string }>(
      `SELECT * FROM events WHERE seq > ?${chat === null ? "" : " AND chat = ?"} ORDER BY seq LIMIT ${MAX_REPLAY + 1}`,
      after,
      ...(chat === null ? [] : [chat]),
    );
    if (rows.length > MAX_REPLAY) return null;
    // Registered in the same turn as the read, so no event falls between the two.
    const l: Listener = { chat, fn };
    listeners.add(l);
    const replay = rows.map((r): AgentEvent => {
      const data = JSON.parse(r.data) as LineView | ChatSummary;
      return r.type === "line"
        ? { seq: r.seq, type: "line", chat: r.chat, line: { ...(data as LineView), seq: r.seq } }
        : { seq: r.seq, type: "chat", chat: r.chat, summary: data as ChatSummary };
    });
    return { replay, stop: () => void listeners.delete(l) };
  }

  /** A visitor's window: its own chat's events after `after`, shown to visitors only. */
  function subscribeVisitor(c: ChatRow, after: number, fn: (e: VisitorEvent) => void) {
    const shown = new Set(q<{ seq: number }>("SELECT seq FROM events WHERE chat = ? AND visitor = 1 AND seq > ?", c.number, after).map((r) => r.seq));
    const s = subscribe(after, c.number, (e) => {
      const v = forVisitor(e, e.type === "chat" || e.line.shown);
      if (v) fn(v);
    });
    if (!s) return null;
    const replay = s.replay.flatMap((e) => {
      const v = forVisitor(e, shown.has(e.seq));
      return v ? [v] : [];
    });
    return { replay, stop: s.stop };
  }

  /** Counts a member's open stream, for who is available now. */
  function connected(who: Actor) {
    online.set(who.id, (online.get(who.id) ?? 0) + 1);
    return () => {
      const n = (online.get(who.id) ?? 1) - 1;
      if (n <= 0) online.delete(who.id);
      else online.set(who.id, n);
    };
  }

  // ------------------------------------------------------------------ reading chats

  function list(params: URLSearchParams): ChatSummary[] {
    const status = params.get("status") ?? "open";
    if (!["open", "closed", "all"].includes(status)) throw new LcError(422, "invalid-body", "status is open, closed or all.");
    const limit = Math.min(500, Math.max(1, Number(params.get("limit")) || 100));
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    if (status !== "all") (where.push("status = ?"), p.push(status));
    const team = params.get("team");
    if (team) (where.push("team = ?"), p.push(team));
    const term = params.get("q")?.trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      where.push(
        "(visitor_name LIKE ? ESCAPE '\\' OR visitor_email LIKE ? ESCAPE '\\' OR page LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) = ? OR EXISTS (SELECT 1 FROM lines l WHERE l.chat = chats.number AND l.text LIKE ? ESCAPE '\\'))",
      );
      p.push(like, like, like, term.replace(/^#/, ""), like);
    }
    // Open chats: the oldest unanswered first, then the rest by their last line. Closed: newest first.
    const order = status === "open" ? "waiting_since IS NULL, waiting_since, last_at DESC" : "last_at DESC";
    return q<ChatRow>(`SELECT * FROM chats${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${limit}`, ...p).map(summary);
  }

  /** The last event's sequence number: a list read after it, then a stream after it, misses nothing. */
  const lastSeq = () => one<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")!.seq;

  function detail(number: number) {
    const c = mustChat(number);
    const s = summary(c);
    const answers = cfg ? cfg.answers.filter((a) => !a.teams.length || a.teams.includes(c.team)) : [];
    const first = c.visitor_name?.split(/\s+/)[0] ?? "";
    return {
      ...s,
      lines: linesOf(number),
      pages: q<{ at: string; path: string; title: string | null }>("SELECT at, path, title FROM pages WHERE chat = ? ORDER BY at", number),
      articles: json<SuggestedArticle[]>(c.articles, []),
      answers: answers.map((a) => ({ id: a.id, title: a.title, text: a.text.replaceAll("{name}", c.visitor_name ?? "").replaceAll("{first_name}", first) })),
      seq: one<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")!.seq,
    };
  }

  async function visitOf(c: ChatRow): Promise<Visit | null> {
    const site = siteOf(c.site);
    if (!book || !site?.analytics || (!c.analytics_session && !c.analytics_visitor)) return null;
    const cached = visitCache.get(c.number);
    if (cached && now() - cached.at < 30_000) {
      if (cached.error) throw new Error(cached.error);
      return cached.value;
    }
    try {
      const value = await book.visit(site.analytics, { visitor: c.analytics_visitor, session: c.analytics_session });
      linkOk("analytics");
      visitCache.set(c.number, { at: now(), value, error: null });
      if (visitCache.size > 500) visitCache.delete(visitCache.keys().next().value!);
      return value;
    } catch (err) {
      linkFailed("analytics", err);
      visitCache.set(c.number, { at: now(), value: null, error: String(err instanceof Error ? err.message : err) });
      throw err;
    }
  }

  /** The visitor beside the chat: their visit from Analytics when linked, and the pages the window saw. */
  async function visitor(number: number) {
    const c = mustChat(number);
    const site = siteOf(c.site);
    const linked = !!book && !!site?.analytics;
    let visit: Visit | null = null;
    let error: string | null = null;
    try {
      visit = await visitOf(c);
    } catch (err) {
      error = `Analytics could not be asked: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      linked,
      ids: !!(c.analytics_session || c.analytics_visitor),
      visit,
      error,
      pages: q<{ at: string; path: string; title: string | null }>("SELECT at, path, title FROM pages WHERE chat = ? ORDER BY at", number),
    };
  }

  /** Articles for what the visitor asked, kept on the chat for the team and shown in the window. */
  async function suggestFor(number: number, question: string, lang: string) {
    if (!kb) return;
    try {
      const articles = await kb.suggest(question, lang);
      linkOk("knowledgeBase");
      if (!articles.length) return;
      tx(() => {
        patch(number, { articles: JSON.stringify(articles) });
        addLine(number, { kind: "system", text: "", event: "articles", data: { articles }, shown: true });
        changed(number);
      });
    } catch (err) {
      linkFailed("knowledgeBase", err);
    }
  }

  /** Articles for what is typed in the window before a chat starts. Nothing about the visitor is sent or kept. */
  async function suggest(q: string, lang: string) {
    if (!kb || !config().window.suggestArticles || q.trim().length < 3) return { articles: [] };
    try {
      const articles = await kb.suggest(q.trim().slice(0, 200), language(lang));
      linkOk("knowledgeBase");
      return { articles };
    } catch (err) {
      linkFailed("knowledgeBase", err);
      return { articles: [] };
    }
  }

  // ------------------------------------------------------------------ overview and reports

  type Done = {
    created_at: string;
    first_answer_at: string | null;
    page: string;
    team: string;
    ticket_number: number | null;
    ticket_reason: string | null;
    lead_id: string | null;
  };
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };
  const waitOf = (c: Done) => (c.first_answer_at ? Date.parse(c.first_answer_at) - Date.parse(c.created_at) : null);
  /** Paths as the reports group them: the first two parts. */
  const pageGroup = (p: string) => {
    const parts = p.split("/").filter(Boolean);
    return parts.length <= 2 ? p || "/" : `/${parts.slice(0, 2).join("/")}/*`;
  };
  function byPage(rows: Done[], limit: number) {
    const m = new Map<string, number>();
    for (const r of rows) m.set(pageGroup(r.page), (m.get(pageGroup(r.page)) ?? 0) + 1);
    return [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([page, chats]) => ({ page, chats }));
  }

  function startOfDay(at: number, tz: string) {
    const w = wallClock(at, tz);
    return at - ((w.hour * 60 + w.minute) * 60 + w.second) * 1000 - (at % 1000);
  }

  function overview() {
    const c = config();
    const tz = c.hours.hours.timeZone;
    const at = now();
    const today = startOfDay(at, tz);
    const lastWeek = today - 7 * DAY;
    const rows = q<Done>("SELECT created_at, first_answer_at, page, team, ticket_number, ticket_reason, lead_id FROM chats WHERE created_at >= ?", iso(today));
    const before = q<Done>(
      "SELECT created_at, first_answer_at, page, team, ticket_number, ticket_reason, lead_id FROM chats WHERE created_at >= ? AND created_at < ?",
      iso(lastWeek),
      iso(lastWeek + DAY),
    );
    const waits = rows.map(waitOf).filter((x): x is number => x !== null);
    const slow = rows.filter((r) => {
      const w = waitOf(r);
      return w === null ? at - Date.parse(r.created_at) > c.chats.slowAnswer : w > c.chats.slowAnswer;
    }).length;
    const hourOf = (iso: string) => wallClock(Date.parse(iso), tz).hour;
    const perHour = (xs: Done[]) => {
      const h = Array<number>(24).fill(0);
      for (const r of xs) h[hourOf(r.created_at)]!++;
      return h;
    };
    const afterHours = one<{ n: number; t: number }>("SELECT COUNT(*) AS n, COUNT(ticket_number) AS t FROM questions WHERE at >= ?", iso(today))!;
    // The first answer's median for each of the last 14 days, for the trend.
    const trend = q<Done>(
      "SELECT created_at, first_answer_at, page, team, ticket_number, ticket_reason, lead_id FROM chats WHERE created_at >= ?",
      iso(today - 13 * DAY),
    );
    const days = Array.from({ length: 14 }, (_, i) => {
      const from = today - (13 - i) * DAY;
      return (
        median(
          trend
            .filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) < from + DAY)
            .map(waitOf)
            .filter((x): x is number => x !== null),
        ) ?? 0
      );
    });
    return {
      timeZone: tz,
      hours: { text: c.hours.text, described: describeHours(c.hours.hours), ...hoursNow(at) },
      chats: rows.length,
      chatsLastWeek: before.length,
      firstAnswer: median(waits),
      firstAnswerTrend: days,
      slow,
      slowAfter: c.chats.slowAnswer,
      tickets: rows.filter((r) => r.ticket_number).length + afterHours.t,
      ticketsAfterHours: afterHours.t,
      leads: rows.filter((r) => r.lead_id).length,
      perHour: { today: perHour(rows), lastWeek: perHour(before) },
      startedOn: byPage(rows, 5),
      team: teamNow(),
      open: one<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE status = 'open'")!.n,
      waiting: one<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE status = 'open' AND waiting_since IS NOT NULL")!.n,
      questions: one<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE at >= ?", iso(at - 7 * DAY))!.n,
      file: opts.fileState?.() ?? null,
    };
  }

  function report(days: Range) {
    const c = config();
    const tz = c.hours.hours.timeZone;
    const at = now();
    const from = startOfDay(at, tz) - (days - 1) * DAY;
    const rows = q<Done>("SELECT created_at, first_answer_at, page, team, ticket_number, ticket_reason, lead_id FROM chats WHERE created_at >= ?", iso(from));
    const qs = q<{ at: string; ticket_number: number | null }>("SELECT at, ticket_number FROM questions WHERE at >= ?", iso(from));
    const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const r of rows) {
      const ms = Date.parse(r.created_at);
      heat[localDate(ms, tz).weekday]![wallClock(ms, tz).hour]!++;
    }
    const waits = rows.map(waitOf).filter((x): x is number => x !== null);
    const series = Array.from({ length: days }, (_, i) => {
      const start = from + i * DAY;
      const day = localDate(start + HOUR * 12, tz);
      const inDay = (s: string) => Date.parse(s) >= start && Date.parse(s) < start + DAY;
      const ds = rows.filter((r) => inDay(r.created_at));
      return {
        day: `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`,
        chats: ds.length,
        tickets: ds.filter((r) => r.ticket_number).length + qs.filter((x) => inDay(x.at) && x.ticket_number).length,
        leads: ds.filter((r) => r.lead_id).length,
      };
    });
    const reasons = (r: string) => rows.filter((x) => x.ticket_number && x.ticket_reason === r).length;
    return {
      days,
      timeZone: tz,
      totals: {
        chats: rows.length,
        answered: waits.length,
        firstAnswer: median(waits),
        slow: rows.filter((r) => (waitOf(r) ?? Infinity) > c.chats.slowAnswer).length,
        questions: qs.length,
        tickets: {
          unanswered: reasons("unanswered"),
          leftOpen: reasons("left-open"),
          agent: reasons("agent"),
          afterHours: qs.filter((x) => x.ticket_number).length,
        },
        leads: rows.filter((r) => r.lead_id).length,
      },
      series,
      byHour: heat,
      byPage: byPage(rows, 10),
      byTeam: c.teams.map((t) => {
        const ts = rows.filter((r) => r.team === t.id);
        return {
          id: t.id,
          name: t.name,
          chats: ts.length,
          firstAnswer: median(ts.map(waitOf).filter((x): x is number => x !== null)),
          tickets: ts.filter((r) => r.ticket_number).length,
          leads: ts.filter((r) => r.lead_id).length,
        };
      }),
    };
  }

  function gauges() {
    return {
      open: one<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE status = 'open'")!.n,
      waiting: one<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE status = 'open' AND waiting_since IS NOT NULL")!.n,
      ticketsPending: one<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE ticket_reason IS NOT NULL AND ticket_number IS NULL")!.n,
      questionsPending: one<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE ticket_number IS NULL")!.n,
      streams: listeners.size,
      agents: available().length,
    };
  }

  function settingsView() {
    const c = cfg;
    return {
      config: c && {
        sites: c.sites,
        hours: {
          text: c.hours.text,
          timeZone: c.hours.hours.timeZone,
          holidays: c.hours.hours.holidays,
          outside: c.hours.outside,
          described: describeHours(c.hours.hours),
        },
        teams: c.teams,
        routes: c.routes,
        window: c.window,
        chats: c.chats,
        files: c.files,
        answers: c.answers,
        keepChats: c.keepChats,
        helpdesk: c.helpdesk,
        analytics: c.analytics,
        crm: c.crm,
        knowledgeBase: c.knowledgeBase,
      },
      yaml,
      file: opts.fileState?.() ?? null,
    };
  }

  function integrations() {
    const c = cfg;
    const set = (name: string | undefined) => !!(name && env[name]);
    const pending = gauges();
    return {
      helpdesk: {
        linked: !!c?.helpdesk,
        url: c?.helpdesk?.url ?? null,
        secret: c?.helpdesk?.key ?? null,
        secretSet: set(c?.helpdesk?.key),
        ...links.helpdesk,
        pending: pending.ticketsPending + pending.questionsPending,
      },
      analytics: {
        linked: !!c?.analytics,
        url: c?.analytics?.url ?? null,
        secret: c?.analytics?.token ?? null,
        secretSet: set(c?.analytics?.token),
        ...links.analytics,
        pending: 0,
      },
      crm: { linked: !!c?.crm, url: c?.crm?.url ?? null, secret: c?.crm?.token ?? null, secretSet: set(c?.crm?.token), ...links.crm, pending: 0 },
      knowledgeBase: { linked: !!c?.knowledgeBase, url: c?.knowledgeBase?.url ?? null, secret: null, secretSet: true, ...links.knowledgeBase, pending: 0 },
    };
  }

  return {
    setConfig,
    config: () => cfg,
    settings: settingsView,
    integrations,
    siteFor,
    team: teamNow,
    setAway,
    setGroups,
    awayOf,
    widgetState,
    startChat,
    visitorChat,
    row: mustChat,
    visitorView,
    visitorSay,
    visitorDetails,
    visitorPage,
    visitorClose,
    visitorFile,
    addFile,
    file,
    ask,
    questions,
    suggest,
    list,
    lastSeq,
    detail,
    visitor,
    agentSay,
    assign,
    agentClose,
    makeTicket,
    makeLead,
    subscribe,
    subscribeVisitor,
    connected,
    tick,
    purge,
    overview,
    report,
    gauges,
    now,
  };
}

export type LiveChat = ReturnType<typeof createLiveChat>;
