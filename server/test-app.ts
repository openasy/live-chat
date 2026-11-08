// Starts the app on a random port for tests, with a clock the test moves and stand-ins for Helpdesk, Analytics, CRM and
// Knowledge Base that keep what they were sent.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createLiveChat, type Options } from "./livechat.ts";
import { LinkError, type LeadRequest, type TicketRequest, type Visit } from "./links.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SITE = "https://www.acme.example";
export const APP = "https://app.acme.example";
export const ENV = { LC_HELPDESK_KEY: "helpdesk-key", LC_ANALYTICS_TOKEN: "analytics-token", LC_CRM_TOKEN: "crm-token" };

/** The settings file the tests start with. 2026-11-02 is a Monday; 12:00 UTC is 15:00 in Istanbul. */
export const SETTINGS = `
sites:
  www: { host: www.acme.example }
  app: { host: app.acme.example, ask_email: false, consent: { purpose: support } }
hours:
  timezone: Europe/Istanbul
  weekdays: 09:00-18:00
teams:
  sales: { name: Sales, queue: sales }
  support: { name: Support, members: [can@acme.example] }
routes:
  - { pages: ["/pricing", "/features/*"], team: sales }
  - { pages: ["/app/*", "/help/*"], team: support }
  - { pages: ["*"], team: sales }
window:
  colour: "#1d4ed8"
  title: Acme Books
chats:
  ticket_after: 10m
  close_after: 30m
files:
  types: [image/png, application/pdf, text/plain]
  max_size: 1MB
answers:
  - { id: turkish, title: Invoices in Turkish, text: "Yes {first_name}, in Turkish.", teams: [sales] }
  - { id: thanks, title: Thanks, text: "Thank you." }
helpdesk: { url: "http://helpdesk:8080", key: LC_HELPDESK_KEY }
analytics: { url: "http://analytics:8080", token: LC_ANALYTICS_TOKEN }
crm: { url: "http://crm:8080", token: LC_CRM_TOKEN }
knowledge_base: { url: "http://kb:8080" }
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-02T12:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

/** Helpdesk, as far as Live Chat sees it: tickets by external_id, and the lines added to them. */
export function fakeHelpdesk() {
  const tickets: Array<TicketRequest & { number: number; added: Array<{ from: string; name: string; text: string }> }> = [];
  let failing = 0;
  return {
    tickets,
    fail: (n: number) => void (failing = n),
    async open(t: TicketRequest) {
      if (failing > 0) {
        failing--;
        throw new LinkError("Helpdesk answered 503");
      }
      const before = tickets.find((x) => x.external_id === t.external_id);
      if (before) return { number: before.number, created: false };
      const number = 1001 + tickets.length;
      tickets.push({ ...t, number, added: [] });
      return { number, created: true };
    },
    async add(number: number, line: { from: "customer" | "agent"; name: string; text: string }) {
      tickets.find((x) => x.number === number)!.added.push(line);
    },
  };
}

export const VISIT: Visit = {
  source: "google.com",
  referrer: "https://www.google.com/",
  utm: { source: null, medium: null, campaign: null },
  browser: "Firefox",
  os: "macOS",
  device: "desktop",
  startedAt: "2026-11-02T11:52:00.000Z",
  pages: [
    { at: "2026-11-02T11:52:00.000Z", path: "/", title: "Acme Books", seconds: 40 },
    { at: "2026-11-02T11:53:00.000Z", path: "/features/e-fatura", title: "e-Fatura", seconds: 190 },
    { at: "2026-11-02T11:56:00.000Z", path: "/pricing", title: "Pricing", seconds: null },
  ],
};

export async function startApp(opts: Partial<AppOptions> & { version: string; settings?: string; livechat?: Partial<Options> }) {
  const db = openDb(":memory:");
  const { settings = SETTINGS, livechat = {}, ...rest } = opts;
  const clock = fakeClock();
  const helpdesk = fakeHelpdesk();
  const leads: LeadRequest[] = [];
  const suggested: string[] = [];
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "live-chat", productName: "OpenAsy Live Chat", origin: base });
  const lc = createLiveChat(db, {
    publicUrl: base,
    env: ENV,
    clock,
    helpdesk: (c) => (c.helpdesk ? helpdesk : null),
    analytics: (c) => (c.analytics ? { visit: async (site, ids) => (site === "www" && ids.session === "session-0001" ? VISIT : null) } : null),
    crm: (c) => (c.crm ? { open: async (l) => (leads.push(l), { id: `lead-${leads.length}`, url: `https://crm.acme.example/leads/${leads.length}` }) } : null),
    kb: (c) =>
      c.knowledgeBase
        ? {
            suggest: async (text) => (
              suggested.push(text),
              /plan/i.test(text) ? [{ title: "Change your plan", excerpt: "", url: "https://kb.acme.example/en/articles/plan" }] : []
            ),
          }
        : null,
    ...livechat,
  });
  lc.setConfig(parseConfig(settings), settings);
  const app = createApp({ db, lc, auth, adminToken: ADMIN_TOKEN, publicUrl: base, trustProxy: true, ...rest, version: opts.version });
  handler = app;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  /** A call from a page of a site, as the window makes it. */
  const page = (path: string, init: RequestInit & { token?: string; origin?: string } = {}) => {
    const { token, origin = SITE, ...rest } = init;
    return fetch(`${base}/api/v1/widget${path}`, {
      ...rest,
      // Each call from its own address, so the rate limits are met only where a test means to.
      headers: {
        origin,
        "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...(rest.body && typeof rest.body === "string" ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  };
  /** The chat a visitor's token is for. */
  const numberOf = (token: string) => (db.prepare("SELECT number FROM chats WHERE id = ?").get(token.split(".")[0]!) as { number: number }).number;
  /** Starts a chat from www's pricing page. */
  const start = async (message = "Can the invoices be in Turkish?", extra: Record<string, unknown> = {}) => {
    const res = await page("/chats", {
      method: "POST",
      body: JSON.stringify({
        message,
        client_id: `c-${Math.random().toString(36).slice(2, 12)}`,
        email: "seda@polat.example",
        page: `${SITE}/pricing?x=1`,
        ...extra,
      }),
    });
    if (res.status !== 201) throw new Error(`start: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; seq: number; chat: { lines: Array<{ id: string }> } };
    return { ...body, number: numberOf(body.token) };
  };
  const close = () =>
    new Promise<void>((resolve) => {
      app.closeStreams();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  /** Adds a member straight to the database, as signing up would. */
  const member = (id: string, name: string, email = `${id}@acme.example`, role = "editor") =>
    db
      .prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
      .run(id, email, name, role, new Date().toISOString());
  return { db, lc, auth, base, admin, page, start, numberOf, clock, helpdesk, leads, suggested, member, close };
}

/** Reads an event stream until `until` says it has enough, or the time is up. */
export async function readStream(res: Response, until: (events: Array<{ event: string; id: string | null; data: any }>) => boolean, ms = 2000) {
  const events: Array<{ event: string; id: string | null; data: any }> = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const timer = setTimeout(() => void reader.cancel(), ms);
  try {
    for (;;) {
      if (until(events)) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let at: number;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        let event = "message";
        let id: string | null = null;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) events.push({ event, id, data: JSON.parse(data) });
        else if (event === "reset") events.push({ event, id, data: null });
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return events;
}
