// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

/** The settings file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  error: string | null;
  warnings: string[];
} | null;

export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface Line {
  id: string;
  seq: number;
  kind: "visitor" | "agent" | "system";
  author: { id: string | null; name: string } | null;
  text: string;
  at: string;
  file: FileView | null;
  event: string | null;
  data: Record<string, unknown> | null;
  shown: boolean;
  clientId: string | null;
  /** Only on this screen: a line still being sent, or one that could not be. */
  state?: "sending" | "failed";
}

export interface Chat {
  number: number;
  site: string;
  team: { id: string; name: string };
  routedBy: string | null;
  status: "open" | "closed";
  visitor: { name: string | null; email: string | null; language: string | null; device: "desktop" | "phone" | "tablet" | null };
  page: string;
  pageTitle: string | null;
  pageNow: string | null;
  referrer: string | null;
  agent: { id: string; name: string } | null;
  createdAt: string;
  lastAt: string;
  firstAnswerAt: string | null;
  waitingSince: string | null;
  closedAt: string | null;
  closedBy: "agent" | "visitor" | "idle" | null;
  ticket: { reason: "unanswered" | "left-open" | "agent"; number: number | null; error: string | null } | null;
  lead: { id: string; url: string | null; at: string; by: string | null } | null;
  last: { kind: Line["kind"]; text: string; at: string } | null;
}

export interface Article {
  title: string;
  excerpt: string;
  url: string;
}

export interface ChatDetail extends Chat {
  lines: Line[];
  pages: Array<{ at: string; path: string; title: string | null }>;
  articles: Article[];
  answers: Array<{ id: string; title: string; text: string }>;
  seq: number;
}

export interface VisitorInfo {
  linked: boolean;
  ids: boolean;
  visit: {
    source: string | null;
    referrer: string | null;
    utm: { source: string | null; medium: string | null; campaign: string | null };
    browser: string | null;
    os: string | null;
    device: string | null;
    startedAt: string | null;
    pages: Array<{ at: string; path: string; title: string | null; seconds: number | null }>;
  } | null;
  error: string | null;
  pages: Array<{ at: string; path: string; title: string | null }>;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  teams: string[];
  chats: number;
  state: "available" | "away" | "offline";
}

export interface Hours {
  open: boolean;
  outside: "form" | "hidden";
  opensAt: string | null;
  closesAt: string | null;
  timeZone: string;
  available: number;
}

export interface Overview {
  timeZone: string;
  hours: Hours & { text: string; described: string };
  chats: number;
  chatsLastWeek: number;
  firstAnswer: number | null;
  firstAnswerTrend: number[];
  slow: number;
  slowAfter: number;
  tickets: number;
  ticketsAfterHours: number;
  leads: number;
  perHour: { today: number[]; lastWeek: number[] };
  startedOn: Array<{ page: string; chats: number }>;
  team: Member[];
  open: number;
  waiting: number;
  questions: number;
  file: ConfigFile;
}

export interface Report {
  days: number;
  timeZone: string;
  totals: {
    chats: number;
    answered: number;
    firstAnswer: number | null;
    slow: number;
    questions: number;
    tickets: { unanswered: number; leftOpen: number; agent: number; afterHours: number };
    leads: number;
  };
  series: Array<{ day: string; chats: number; tickets: number; leads: number }>;
  byHour: number[][];
  byPage: Array<{ page: string; chats: number }>;
  byTeam: Array<{ id: string; name: string; chats: number; firstAnswer: number | null; tickets: number; leads: number }>;
}

export interface Question {
  id: string;
  site: string;
  team: { id: string; name: string };
  name: string | null;
  email: string;
  page: string | null;
  language: string | null;
  question: string;
  at: string;
  ticket: number | null;
  error: string | null;
}

export interface LinkState {
  linked: boolean;
  url: string | null;
  secret: string | null;
  secretSet: boolean;
  okAt: string | null;
  errorAt: string | null;
  error: string | null;
  pending: number;
}

export interface Integrations {
  helpdesk: LinkState;
  analytics: LinkState;
  crm: LinkState;
  knowledgeBase: LinkState;
}

export interface Config {
  sites: Array<{ id: string; origins: string[]; askEmail: boolean; consent: string | null; analytics: string | null; title: string | null }>;
  hours: { text: string; timeZone: string; holidays: string[]; outside: "form" | "hidden"; described: string };
  teams: Array<{ id: string; name: string; groups: string[]; members: string[]; queue: string | null }>;
  routes: Array<{ pages: string[]; team: string }>;
  window: {
    colour: string;
    title: string;
    greeting: Partial<Record<"en" | "de" | "tr", string>> | null;
    position: "right" | "left";
    suggestArticles: boolean;
    privacy: string | null;
  };
  chats: { ticketAfter: number; closeAfter: number; slowAnswer: number };
  files: { types: string[]; maxSize: number };
  answers: Array<{ id: string; title: string; text: string; teams: string[] }>;
  keepChats: number;
  helpdesk: { url: string; key: string } | null;
  analytics: { url: string; token: string } | null;
  crm: { url: string; token: string } | null;
  knowledgeBase: { url: string; language: string | null } | null;
}

export interface Settings {
  config: Config | null;
  yaml: string;
  file: ConfigFile;
}

/** What the team's stream sends. */
export type StreamEvent = { seq: number; type: "line"; chat: number; line: Line } | { seq: number; type: "chat"; chat: number; summary: Chat };

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const raw = init.body instanceof Blob;
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body && !raw ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
