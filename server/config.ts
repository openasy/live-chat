// Live Chat's settings, from one YAML file (LIVE_CHAT_CONFIG): the sites the window is on, the working hours, the teams
// and the rules that send a page's chats to a team, the window's colour and words, saved answers, files, how long chats
// are kept, and the links to Helpdesk, Analytics, CRM and Knowledge Base. As in the other products, the file is the only
// way in: no screen or API route changes these. It is applied whole or not at all, read again within a minute of a
// change, and a file with a mistake leaves the last good version in place. Chats themselves are kept in the database.
//
// Secrets are never in the file: it names the environment variables that hold them.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { parseHours, validTimeZone, type Hours } from "./hours.ts";

export const LANGUAGES = ["en", "de", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Site {
  id: string;
  /** Origins whose pages may load the window, such as https://www.example.com. */
  origins: string[];
  /** Ask for the visitor's email before a chat starts. Outside hours the form always asks for it. */
  askEmail: boolean;
  /** The Consent purpose the visitor must accept before the window loads; null: the window loads at once. */
  consent: string | null;
  /** The site's name in Analytics, for the visitor's pages; null when the site is not in Analytics. */
  analytics: string | null;
  /** Overrides window.title for this site. */
  title: string | null;
}

export interface Team {
  id: string;
  name: string;
  /** Identity groups whose members answer this team's chats, as the sign-in sends them. */
  groups: string[];
  /** Members by email, for teams signed in with passwords. With neither, everyone answers. */
  members: string[];
  /** Sent to Helpdesk as the ticket's form, so a Helpdesk rule `match: { form: <this> }` picks its queue. */
  queue: string | null;
}

export interface Route {
  /** Paths, with * for any part: /pricing, /features/*, *. */
  pages: string[];
  team: string;
}

export interface Answer {
  id: string;
  title: string;
  /** May use {name}, {first_name} and {agent}. */
  text: string;
  /** Offered for these teams' chats only; [] is every team. */
  teams: string[];
}

export type Words = Partial<Record<Language, string>>;

export interface Config {
  sites: Site[];
  hours: {
    hours: Hours;
    /** As written, such as weekdays 09:00-18:00. */
    text: string;
    /** Outside hours the window shows a form (its questions become Helpdesk tickets), or nothing. */
    outside: "form" | "hidden";
  };
  teams: Team[];
  routes: Route[];
  window: {
    colour: string;
    title: string;
    /** The first line in the window; the built-in one in the visitor's language when not set. */
    greeting: Words | null;
    position: "right" | "left";
    suggestArticles: boolean;
    privacy: string | null;
  };
  chats: {
    /** A chat no one has answered this long becomes a Helpdesk ticket, and the visitor is told. */
    ticketAfter: number;
    /** A chat with no new line this long is closed; one that ends on an unanswered question becomes a ticket. */
    closeAfter: number;
    /** What the overview counts as answered late. */
    slowAnswer: number;
  };
  files: { types: string[]; maxSize: number };
  answers: Answer[];
  /** Closed chats, their lines and files are deleted after this long. */
  keepChats: number;
  helpdesk: { url: string; key: string } | null;
  analytics: { url: string; token: string } | null;
  crm: { url: string; token: string } | null;
  knowledgeBase: { url: string; language: string | null } | null;
}

/** Files people may send in a chat. Anything else is refused, whatever its name says. */
export const FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"] as const;

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_KEYS = /^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$|^(weekdays|weekend|daily)$/;
const TOP = ["sites", "hours", "teams", "routes", "window", "chats", "files", "answers", "keep_chats", "helpdesk", "analytics", "crm", "knowledge_base"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as LIVE_CHAT_HELPDESK_KEY, never the secret itself.`);
  return v;
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

function list(v: unknown, at: string, max = 100): unknown[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  if (items.length > max) throw new Error(`${at} holds at most ${max} entries.`);
  return items;
}

function strings(v: unknown, at: string, check: (s: string, at: string) => string = (s, a) => text(s, a, 200)): string[] {
  return [...new Set(list(v, at).map((x, i) => check(typeof x === "number" ? String(x) : (x as string), `${at}[${i}]`)))];
}

/** A site's host, or an origin, as the origin pages are served from. http:// only for localhost. */
function origin(raw: unknown, at: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(s) ? "http" : "https"}://${s}`;
  const url = s ? URL.parse(withScheme) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is a host such as www.example.com, or an origin such as https://www.example.com (http:// only for localhost).`);
  return url.origin;
}

function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  // http:// stays inside the install: localhost, or a service name on the same network, such as helpdesk.
  const local = url && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://helpdesk.example.com (http:// only for a host without dots, such as http://helpdesk:8080).`);
  return url.href.replace(/\/$/, "");
}

/** Reads 30s, 5m, 4h, 1d, 2w or 2y into ms. */
export function parseDuration(v: unknown, at: string, min = 1000, max = 10 * 365 * 86_400_000): number {
  const s = typeof v === "number" ? `${v}m` : typeof v === "string" ? v.trim().toLowerCase() : "";
  const m = /^(\d+)\s*(s|m|min|h|d|w|y)$/.exec(s);
  if (!m) throw new Error(`${at} is a duration such as 30s, 5m, 4h, 1d, 2w or 2y.`);
  const unit = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, y: 365 * 86_400_000 }[m[2] as "s"];
  const ms = Number(m[1]) * unit;
  if (ms < min || ms > max) throw new Error(`${at} is from ${describeMs(min)} to ${describeMs(max)}.`);
  return ms;
}

const describeMs = (ms: number) =>
  ms % (365 * 86_400_000) === 0
    ? `${ms / (365 * 86_400_000)}y`
    : ms % 86_400_000 === 0
      ? `${ms / 86_400_000}d`
      : ms % 3_600_000 === 0
        ? `${ms / 3_600_000}h`
        : ms % 60_000 === 0
          ? `${ms / 60_000}m`
          : `${ms / 1000}s`;

/** Reads 500KB, 10MB or a number of bytes. */
function parseSize(v: unknown, at: string): number {
  const s = typeof v === "number" ? `${v}` : typeof v === "string" ? v.trim().toUpperCase() : "";
  const m = /^(\d+)\s*(B|KB|MB)?$/.exec(s);
  const n = m ? Number(m[1]) * (m[2] === "MB" ? 1024 * 1024 : m[2] === "KB" ? 1024 : 1) : NaN;
  if (!m || n < 1024 || n > 25 * 1024 * 1024) throw new Error(`${at} is a size from 1KB to 25MB, such as 10MB.`);
  return n;
}

function words(v: unknown, at: string, max = 500): Words {
  if (typeof v === "string") return { en: text(v, at, max), de: text(v, at, max), tr: text(v, at, max) };
  if (!isObj(v) || !Object.keys(v).length) throw new Error(`${at} is a text, or a map of language to text, such as { en: Hello, tr: Merhaba }.`);
  keys(v, at, [...LANGUAGES]);
  const out: Words = {};
  for (const l of LANGUAGES) if (v[l] !== undefined) out[l] = text(v[l], `${at}.${l}`, max);
  return out;
}

/** A page pattern: a path with * for any part, or * alone for every page. */
function pagePattern(v: unknown, at: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s !== "*" && (!s.startsWith("/") || s.length > 200 || /\s/.test(s)))
    throw new Error(`${at} is a path such as /pricing or /features/*, or * for every page.`);
  return s;
}

/** True when the path matches the pattern: * matches any characters, including /. */
export function pageMatches(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}/?$`);
  return re.test(path);
}
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const titleCase = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/-/g, " ");

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  // ------------------------------------------------------------ sites
  const sites: Site[] = [];
  const rawSites = doc.sites ?? {};
  if (!isObj(rawSites)) throw new Error("sites is a map of site id to { host, ask_email, consent, analytics, title }.");
  if (Object.keys(rawSites).length > 50) throw new Error("sites holds at most 50 sites.");
  for (const [id, v] of Object.entries(rawSites)) {
    const at = `sites.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a site id is up to 32 lowercase letters, digits and -, starting with a letter.`);
    const s = typeof v === "string" ? { host: v } : (v ?? {});
    if (!isObj(s)) throw new Error(`${at} is a map with host, ask_email, consent, analytics and title.`);
    keys(s, at, ["host", "ask_email", "consent", "analytics", "title"]);
    if (s.host === undefined) throw new Error(`${at}.host is the site's host, such as www.example.com, or a list of them.`);
    const origins = strings(s.host, `${at}.host`, (x, a) => origin(x, a));
    for (const o of origins) {
      const other = sites.find((x) => x.origins.includes(o));
      if (other) throw new Error(`${at}.host: ${o} is also sites.${other.id}'s.`);
    }
    let consent: string | null = null;
    if (s.consent !== undefined && s.consent !== null && s.consent !== "none" && s.consent !== false) {
      const c = isObj(s.consent) ? s.consent.purpose : s.consent;
      if (isObj(s.consent)) keys(s.consent, `${at}.consent`, ["purpose"]);
      if (typeof c !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(c))
        throw new Error(`${at}.consent is none, or the Consent purpose the visitor must accept first, such as { purpose: support }.`);
      consent = c;
    }
    const analytics = s.analytics === false || s.analytics === null ? null : s.analytics === undefined ? id : text(s.analytics, `${at}.analytics`, 128);
    sites.push({
      id,
      origins,
      askEmail: bool(s.ask_email, `${at}.ask_email`, true),
      consent,
      analytics,
      title: s.title === undefined ? null : text(s.title, `${at}.title`),
    });
  }

  // ------------------------------------------------------------ hours
  const h = doc.hours ?? {};
  if (!isObj(h)) throw new Error("hours is a map with timezone, holidays, outside, and days with their times, such as weekdays: 09:00-18:00.");
  const dayKeys = Object.keys(h).filter((k) => DAY_KEYS.test(k));
  keys(h, "hours", ["timezone", "holidays", "outside", "always", ...dayKeys]);
  const timeZone = h.timezone === undefined ? "UTC" : text(h.timezone, "hours.timezone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`hours.timezone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  const holidays = strings(h.holidays, "hours.holidays", (x, a) => {
    if (typeof x !== "string" || !DATE.test(x) || Number.isNaN(Date.parse(x))) throw new Error(`${a} is a date such as 2026-10-29.`);
    return x;
  });
  const always = bool(h.always, "hours.always", dayKeys.length === 0);
  if (always && dayKeys.length) throw new Error("hours: always: true and days with times cannot both be set.");
  const parts = dayKeys.flatMap((k) =>
    strings(h[k], `hours.${k}`, (x, a) => {
      if (typeof x !== "string") throw new Error(`${a} is times such as 09:00-18:00.`);
      return x;
    }).flatMap((x) => x.split(/\s*,\s*/).map((t) => `${k} ${t}`)),
  );
  const hoursText = always ? "always" : parts.join(", ");
  const days = always ? null : parseHours(hoursText, "hours");
  const outside = (h.outside ?? "form") as Config["hours"]["outside"];
  if (outside !== "form" && outside !== "hidden") throw new Error("hours.outside is form (a question that becomes a Helpdesk ticket) or hidden.");

  // ------------------------------------------------------------ teams and routes
  const teams: Team[] = [];
  const rawTeams = doc.teams ?? { support: {} };
  if (!isObj(rawTeams) || !Object.keys(rawTeams).length)
    throw new Error("teams is a map of team id to { name, group, members, queue }, such as sales: { group: sales }.");
  if (Object.keys(rawTeams).length > 50) throw new Error("teams holds at most 50 teams.");
  for (const [id, v] of Object.entries(rawTeams)) {
    const at = `teams.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a team id is up to 32 lowercase letters, digits and -, starting with a letter.`);
    const t = v ?? {};
    if (!isObj(t)) throw new Error(`${at} is a map with name, group, members and queue.`);
    keys(t, at, ["name", "group", "members", "queue"]);
    teams.push({
      id,
      name: t.name === undefined ? titleCase(id) : text(t.name, `${at}.name`),
      groups: strings(t.group, `${at}.group`, (x, a) => text(x, a, 200)),
      members: strings(t.members, `${at}.members`, (x, a) => {
        if (typeof x !== "string" || !EMAIL.test(x.trim())) throw new Error(`${a} is an email address.`);
        return x.trim().toLowerCase();
      }),
      queue: t.queue === undefined ? null : text(t.queue, `${at}.queue`, 64),
    });
  }
  const routes: Route[] = list(doc.routes, "routes", 200).map((r, i) => {
    const at = `routes[${i}]`;
    if (!isObj(r)) throw new Error(`${at} is { pages, team }, such as { pages: ["/pricing"], team: sales }.`);
    keys(r, at, ["pages", "team"]);
    const team = text(r.team, `${at}.team`, 32);
    if (!teams.some((t) => t.id === team)) throw new Error(`${at}.team: ${team} is not one of the teams.`);
    const pages = strings(r.pages, `${at}.pages`, (x, a) => pagePattern(x, a));
    if (!pages.length) throw new Error(`${at}.pages is a list of paths, such as ["/pricing", "/features/*"].`);
    return { pages, team };
  });

  // ------------------------------------------------------------ window
  const w = doc.window ?? {};
  if (!isObj(w)) throw new Error("window is a map with colour, title, greeting, position, suggest_articles and privacy.");
  keys(w, "window", ["colour", "title", "greeting", "position", "suggest_articles", "privacy"]);
  const colour = w.colour === undefined ? "#1d4ed8" : String(w.colour).trim();
  if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new Error('window.colour is a colour such as "#1d4ed8".');
  const position = (w.position ?? "right") as Config["window"]["position"];
  if (position !== "right" && position !== "left") throw new Error("window.position is right or left.");
  let privacy: string | null = null;
  if (w.privacy !== undefined) {
    const u = typeof w.privacy === "string" ? URL.parse(w.privacy.trim()) : null;
    if (!u || u.protocol !== "https:") throw new Error("window.privacy is the https:// address of your privacy notice.");
    privacy = u.href;
  }

  // ------------------------------------------------------------ chats and files
  const c = doc.chats ?? {};
  if (!isObj(c)) throw new Error("chats is a map with ticket_after, close_after and slow_answer.");
  keys(c, "chats", ["ticket_after", "close_after", "slow_answer"]);
  const ticketAfter = c.ticket_after === undefined ? 10 * 60_000 : parseDuration(c.ticket_after, "chats.ticket_after", 60_000, 86_400_000);
  const closeAfter = c.close_after === undefined ? 30 * 60_000 : parseDuration(c.close_after, "chats.close_after", 5 * 60_000, 7 * 86_400_000);
  const slowAnswer = c.slow_answer === undefined ? 2 * 60_000 : parseDuration(c.slow_answer, "chats.slow_answer", 10_000, 3_600_000);
  const f = doc.files ?? {};
  if (!isObj(f)) throw new Error("files is a map with types and max_size.");
  keys(f, "files", ["types", "max_size"]);
  const types =
    f.types === undefined
      ? ["image/png", "image/jpeg", "application/pdf"]
      : f.types === false
        ? []
        : strings(f.types, "files.types", (x, a) => {
            if (!(FILE_TYPES as readonly string[]).includes(x)) throw new Error(`${a} is one of ${FILE_TYPES.join(", ")}.`);
            return x;
          });
  const maxSize = f.max_size === undefined ? 10 * 1024 * 1024 : parseSize(f.max_size, "files.max_size");

  // ------------------------------------------------------------ saved answers
  const answers: Answer[] = [];
  list(doc.answers, "answers", 500).forEach((a, i) => {
    const at = `answers[${i}]`;
    if (!isObj(a)) throw new Error(`${at} is a map with id, title, text and teams.`);
    keys(a, at, ["id", "title", "text", "teams"]);
    const id = typeof a.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(a.id) ? a.id : null;
    if (!id) throw new Error(`${at}.id is up to 64 lowercase letters, digits and -.`);
    if (answers.some((x) => x.id === id)) throw new Error(`${at}: the id ${id} is in the file twice.`);
    const ts = strings(a.teams, `${at}.teams`, (x, at2) => {
      if (!teams.some((t) => t.id === x)) throw new Error(`${at2}: ${x} is not one of the teams.`);
      return x;
    });
    answers.push({ id, title: text(a.title, `${at}.title`, 120), text: text(a.text, `${at}.text`, 5000), teams: ts });
  });

  const keepChats = doc.keep_chats === undefined ? 2 * 365 * 86_400_000 : parseDuration(doc.keep_chats, "keep_chats", 86_400_000);

  // ------------------------------------------------------------ links
  const link = <K extends string>(name: string, v: unknown, secret: K, fallback: string): ({ url: string } & Record<K, string>) | null => {
    if (v === undefined || v === null) return null;
    if (!isObj(v)) throw new Error(`${name} is a map with url and ${secret}.`);
    keys(v, name, ["url", secret]);
    return { url: baseUrl(v.url, `${name}.url`), [secret]: v[secret] === undefined ? fallback : env(v[secret], `${name}.${secret}`) } as {
      url: string;
    } & Record<K, string>;
  };
  const helpdesk = link("helpdesk", doc.helpdesk, "key", "LIVE_CHAT_HELPDESK_KEY");
  const analytics = link("analytics", doc.analytics, "token", "LIVE_CHAT_ANALYTICS_TOKEN");
  const crm = link("crm", doc.crm, "token", "LIVE_CHAT_CRM_TOKEN");
  let knowledgeBase: Config["knowledgeBase"] = null;
  if (doc.knowledge_base !== undefined && doc.knowledge_base !== null) {
    const k = doc.knowledge_base;
    if (!isObj(k)) throw new Error("knowledge_base is a map with url and language.");
    keys(k, "knowledge_base", ["url", "language"]);
    const lang = k.language === undefined ? null : text(k.language, "knowledge_base.language", 10);
    if (lang && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) throw new Error("knowledge_base.language is a language code, such as tr.");
    knowledgeBase = { url: baseUrl(k.url, "knowledge_base.url"), language: lang };
  }

  return {
    sites,
    hours: { hours: { always: days === null, days: days ?? [[], [], [], [], [], [], []], timeZone, holidays }, text: hoursText, outside },
    teams,
    routes,
    window: {
      colour,
      title: w.title === undefined ? "Chat" : text(w.title, "window.title"),
      greeting: w.greeting === undefined ? null : words(w.greeting, "window.greeting"),
      position,
      suggestArticles: bool(w.suggest_articles, "window.suggest_articles", true),
      privacy,
    },
    chats: { ticketAfter, closeAfter, slowAnswer },
    files: { types, maxSize },
    answers,
    keepChats,
    helpdesk,
    analytics,
    crm,
    knowledgeBase,
  };
}

/** The team a page's chats go to: the first route that matches, else the first team. */
export function routeFor(c: Config, path: string): { team: Team; rule: string | null } {
  for (const r of c.routes) {
    const hit = r.pages.find((p) => pageMatches(p, path));
    if (hit) return { team: c.teams.find((t) => t.id === r.team)!, rule: hit };
  }
  return { team: c.teams[0]!, rule: null };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, links that cannot work. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>): string[] {
  const w: string[] = [];
  if (!c.sites.length) w.push("No sites: the window cannot be added to a page until sites lists one.");
  if (c.helpdesk && !environment[c.helpdesk.key]) w.push(`helpdesk: ${c.helpdesk.key} is not set, so no chat or question can become a ticket.`);
  if (!c.helpdesk && c.hours.outside === "form") w.push("hours.outside is form, but helpdesk is not linked: questions are kept here until it is.");
  if (c.analytics && !environment[c.analytics.token]) w.push(`analytics: ${c.analytics.token} is not set, so the visitor's pages are not shown.`);
  if (c.crm && !environment[c.crm.token]) w.push(`crm: ${c.crm.token} is not set, so no lead can be opened.`);
  if (c.routes.length && !c.routes.some((r) => r.pages.includes("*")))
    w.push(`No route has pages: ["*"]: pages no rule matches go to the first team, ${c.teams[0]!.name}.`);
  return w;
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
