// The other products a chat works with: Helpdesk takes chats and questions as tickets, Analytics has the visitor's
// pages, CRM takes leads and Knowledge Base suggests articles. Each is behind a small interface, so a test or another
// product can stand in, and each is off until the file links it. Another product's answer is not trusted further than
// its fields' types.

const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const link = (v: unknown): string | null => {
  const u = typeof v === "string" ? URL.parse(v) : null;
  return u && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Why a call to another product failed, as the Integrations page shows it. */
export class LinkError extends Error {
  /** true when trying again cannot help: the request itself was refused. */
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

async function problemOf(res: Response, product: string): Promise<LinkError> {
  const body = obj(await res.json().catch(() => null));
  const detail = str(body?.detail, 300);
  // 4xx but 408 and 429 are the request's fault: sending it again gives the same answer.
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  return new LinkError(`${product} answered ${res.status}${detail ? `: ${detail}` : ""}`, permanent);
}

// ---------------------------------------------------------------------------------------------------------- Helpdesk

export interface TranscriptLine {
  from: "customer" | "agent";
  name: string;
  at: string;
  text: string;
}

/** What Helpdesk's POST /api/v1/public/tickets takes from Live Chat (see helpdesk/openapi.json, PublicTicket). */
export interface TicketRequest {
  external_id: string;
  email?: string;
  name?: string;
  subject?: string;
  message?: string;
  language?: string;
  /** The team's queue from the file, for Helpdesk's routing rules with match.form. */
  form?: string;
  transcript?: TranscriptLine[];
}

export interface TicketDesk {
  /** Opens the ticket, or finds the one this external_id opened before. */
  open(t: TicketRequest): Promise<{ number: number; created: boolean }>;
  /** Adds a line to a ticket this source opened. */
  add(number: number, line: { from: "customer" | "agent"; name: string; text: string }): Promise<void>;
}

export function helpdeskDesk(o: { url: string; key: string | undefined; fetch?: typeof fetch; timeoutMs?: number }): TicketDesk {
  const call = o.fetch ?? fetch;
  const headers = { accept: "application/json", "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) };
  return {
    async open(t) {
      if (!o.key) throw new LinkError("The Helpdesk key is not set.");
      const res = await call(`${o.url}/api/v1/public/tickets`, {
        method: "POST",
        headers,
        body: JSON.stringify(t),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        redirect: "error",
      });
      if (res.status !== 200 && res.status !== 201) throw await problemOf(res, "Helpdesk");
      const body = obj(obj(await res.json())?.ticket);
      const number = body && typeof body.number === "number" && Number.isInteger(body.number) ? body.number : null;
      if (number === null) throw new LinkError("Helpdesk's answer has no ticket number.");
      return { number, created: res.status === 201 };
    },
    async add(number, line) {
      if (!o.key) throw new LinkError("The Helpdesk key is not set.");
      const res = await call(`${o.url}/api/v1/public/tickets/${number}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(line),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        redirect: "error",
      });
      if (res.status !== 201) throw await problemOf(res, "Helpdesk");
    },
  };
}

// --------------------------------------------------------------------------------------------------------- Analytics

export interface VisitPage {
  at: string;
  path: string;
  title: string | null;
  /** Seconds on the page, when the visitor left it; null while they are on it. */
  seconds: number | null;
}

export interface Visit {
  /** Where the visit came from: a site, a search, a campaign. */
  source: string | null;
  referrer: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  browser: string | null;
  os: string | null;
  device: string | null;
  startedAt: string | null;
  pages: VisitPage[];
}

/** The visit Analytics recorded for these ids, or null when it has none. */
export interface VisitBook {
  visit(site: string, ids: { visitor: string | null; session: string | null }): Promise<Visit | null>;
}

/** Analytics' VisitDetail, as in analytics/openapi.json: a page view, then a leave with the time on it. */
export function readVisit(body: unknown): Visit | null {
  const b = obj(body);
  if (!b) return null;
  const utm = obj(b.utm);
  const pages: VisitPage[] = [];
  for (const e of Array.isArray(b.timeline) ? b.timeline.slice(0, 2000) : []) {
    const x = obj(e);
    const at = str(x?.at, 40);
    const path = str(x?.path, 500);
    if (!x || !at || !path) continue;
    if (x.type === "pageview") pages.push({ at, path, title: str(x.title, 200), seconds: null });
    else if (x.type === "leave") {
      const open = [...pages].reverse().find((p) => p.path === path && p.seconds === null);
      if (open && typeof x.duration === "number" && Number.isFinite(x.duration)) open.seconds = Math.max(0, Math.round(x.duration / 1000));
    }
  }
  return {
    source: str(b.source, 200),
    referrer: str(b.referrer, 500),
    utm: { source: str(utm?.source, 200), medium: str(utm?.medium, 200), campaign: str(utm?.campaign, 200) },
    browser: str(b.browser, 80),
    os: str(b.os, 80),
    device: str(b.device, 40),
    startedAt: str(b.startedAt, 40),
    pages: pages.slice(-50),
  };
}

export function analyticsBook(o: { url: string; token: string | undefined; fetch?: typeof fetch; timeoutMs?: number }): VisitBook {
  const call = o.fetch ?? fetch;
  const get = async (path: string) => {
    if (!o.token) throw new LinkError("The Analytics token is not set.");
    const res = await call(`${o.url}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${o.token}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      redirect: "error",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await problemOf(res, "Analytics");
    return res.json() as Promise<unknown>;
  };
  return {
    async visit(site, ids) {
      let session = ids.session;
      // Only the visitor is known: their latest visit.
      if (!session && ids.visitor) {
        const list = obj(await get(`/api/v1/visits?${new URLSearchParams({ site, visitor: ids.visitor, limit: "1" })}`));
        const first = obj(Array.isArray(list?.visits) ? list.visits[0] : null);
        session = str(first?.id, 100);
      }
      if (!session) return null;
      return readVisit(await get(`/api/v1/visits/${encodeURIComponent(session)}?${new URLSearchParams({ site })}`));
    },
  };
}

// --------------------------------------------------------------------------------------------------------------- CRM

/**
 * What Live Chat sends CRM to open a lead: POST <crm.url>/api/v1/leads with Authorization: Bearer <the token crm.token
 * names>. CRM answers 201 with the new lead, or 200 with the one the same external_id opened before, as
 * { lead: { id, url } }. The schemas are CrmLeadRequest and CrmLeadCreated in openapi.json; README.md describes it for
 * CRM's side.
 */
export interface LeadRequest {
  /** live-chat-<chat id>: the same chat opens one lead, however often it is sent. */
  external_id: string;
  source: "live-chat";
  name: string | null;
  email: string | null;
  /** The page the chat started on, as a full address. */
  page: string;
  /** The first question, as the lead's title. */
  title: string;
  /** The agent who opened it, who owns the lead unless CRM decides otherwise. */
  owner: { name: string; email: string | null };
  /** Where the chat came from, from Analytics when linked. */
  referrer: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null } | null;
  /** The pages the visitor read, oldest first. */
  pages: Array<{ at: string; path: string }>;
  transcript: Array<{ from: "visitor" | "agent"; name: string; at: string; text: string }>;
  /** The chat in Live Chat, for people who may open it. */
  chat_url: string;
}

export interface Lead {
  id: string;
  url: string | null;
}

export interface LeadBook {
  open(lead: LeadRequest): Promise<Lead>;
}

export function crmLeads(o: { url: string; token: string | undefined; fetch?: typeof fetch; timeoutMs?: number }): LeadBook {
  const call = o.fetch ?? fetch;
  return {
    async open(lead) {
      if (!o.token) throw new LinkError("The CRM token is not set.");
      const res = await call(`${o.url}/api/v1/leads`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${o.token}` },
        body: JSON.stringify(lead),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        redirect: "error",
      });
      if (res.status !== 200 && res.status !== 201) throw await problemOf(res, "CRM");
      const l = obj(obj(await res.json())?.lead);
      const id = str(l?.id, 200);
      if (!l || !id) throw new LinkError("CRM's answer has no lead id.");
      return { id, url: link(l.url) };
    },
  };
}

// ---------------------------------------------------------------------------------------------------- Knowledge Base

export interface SuggestedArticle {
  title: string;
  excerpt: string;
  url: string;
}

/** Articles for what a visitor asks. Throws when Knowledge Base cannot be asked. */
export interface ArticleSuggester {
  suggest(text: string, lang: string | null): Promise<SuggestedArticle[]>;
}

export function kbSuggester(o: { url: string; language: string | null; fetch?: typeof fetch; timeoutMs?: number }): ArticleSuggester {
  const call = o.fetch ?? fetch;
  return {
    async suggest(text, lang) {
      const l = o.language ?? lang;
      const q = new URLSearchParams({ q: text.slice(0, 200), place: "live-chat", limit: "3", ...(l ? { lang: l } : {}) });
      const res = await call(`${o.url}/api/v1/suggest?${q}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
        redirect: "error",
      });
      if (!res.ok) throw await problemOf(res, "Knowledge Base");
      const body = obj(await res.json());
      return (Array.isArray(body?.articles) ? body.articles : []).slice(0, 5).flatMap((a): SuggestedArticle[] => {
        const x = obj(a);
        const title = str(x?.title, 200);
        const url = link(x?.url);
        if (!x || !title || !url) return [];
        return [{ title, url, excerpt: str(x.excerpt, 300) ?? "" }];
      });
    },
  };
}
