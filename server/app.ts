import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Site } from "./config.ts";
import { LcError, parseRange, type Actor, type LiveChat, type ProblemCode } from "./livechat.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  lc: LiveChat;
  version: string;
  /** The address people open the product at; the window's script talks to it. */
  publicUrl: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The built window script (dist/widget/w.js), served with each site's settings at /w/<site>.js. */
  widgetFile?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Behind a TLS proxy: take the visitor's address from the last X-Forwarded-For entry, for the rate limits. */
  trustProxy?: boolean;
  /** For tests: the heartbeat of the streams. */
  heartbeatMs?: number;
}

function metricsText(lc: LiveChat, version: string) {
  return renderMetrics(version, { ...lc.gauges(), fileError: !!lc.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (LIVE_CHAT_METRICS_PORT). */
export function createMetricsHandler(lc: LiveChat, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(lc, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The team's pages run nothing from elsewhere and show no image from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; form-action 'self'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer | Uint8Array, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  closed: "Closed",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "unsupported-type": "File type not taken",
  "not-linked": "Not linked",
  "link-failed": "The other product failed",
  unavailable: "Not available yet",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new LcError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new LcError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body of up to `limit` bytes. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readBody(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new LcError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req: IncomingMessage) => (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : undefined);

/** A file people sent: only plain images are shown inline, anything else is downloaded, and nothing in it can run. */
function sendFile(res: ServerResponse, f: { name: string; type: string; data: Uint8Array }, headers: Record<string, string> = {}) {
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
  send(res, 200, f.data, inline ? f.type : f.type === "text/plain" ? "text/plain; charset=utf-8" : "application/octet-stream", {
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=3600",
    ...headers,
  });
}

/** The role a route needs (ADR 0003); "none" for the version. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest JSON body taken, in bytes. Default 64 KiB. */
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

/** Calls a minute from one address to the window's routes, by what they do. Counted in memory, never stored. */
const RATES = { state: 60, start: 6, say: 40, file: 10, page: 60, details: 10, question: 5, suggest: 60, stream: 30, read: 60 } as const;
type Rate = keyof typeof RATES;
/** Streams one chat may have open at once: a few tabs of the same site. */
const STREAMS_PER_CHAT = 6;
/** Streams one address may have open at once. */
const STREAMS_PER_ADDRESS = 50;

/** One small, cached copy of each site's script. */
const SCRIPT_CACHE = "public, max-age=300";

export function createApp({
  db,
  lc,
  version,
  publicUrl,
  auth,
  adminToken,
  webDir,
  docsDir,
  widgetFile,
  openapi,
  serveMetrics = true,
  products = [],
  trustProxy = false,
  heartbeatMs = 25_000,
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const num = (s: string) => {
    const n = Number(s.replace(/^#/, ""));
    if (!Number.isInteger(n) || n < 1) throw new LcError(404, "not-found", `There is no chat ${s}.`);
    return n;
  };
  const streams = new Set<ServerResponse>();

  // ------------------------------------------------------------------ streams (Server-Sent Events)

  /**
   * Opens an event stream: `id:` is each event's sequence number, so a client that reconnects with Last-Event-ID (or
   * ?after=) gets what it missed and nothing twice. `event: reset` tells it to load again: it was too far behind.
   */
  function stream(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string>,
    open: (write: (e: { seq: number; type: string }) => void) => { replay: Array<{ seq: number; type: string }>; stop: () => void } | null,
    onEnd?: () => void,
  ) {
    res.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders();
    const write = (e: { seq: number; type: string }) => void res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write("retry: 2000\n\n");
    const s = open(write);
    if (!s) {
      res.write("event: reset\ndata: {}\n\n");
      res.end();
      onEnd?.();
      return;
    }
    for (const e of s.replay) write(e);
    res.write(": ready\n\n");
    streams.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    const end = () => {
      clearInterval(beat);
      s.stop();
      streams.delete(res);
      onEnd?.();
    };
    req.on("close", end);
    res.on("error", end);
  }

  const afterOf = (req: IncomingMessage, url: URL) => {
    const raw = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("after") ?? "0";
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new LcError(422, "invalid-body", "after is the sequence number of the last event seen.");
    return n;
  };

  // ------------------------------------------------------------------ the team's API

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "live-chat", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/overview", auth: "viewer", handle: () => lc.overview() },
    { method: "GET", path: "/api/v1/report", auth: "viewer", handle: ({ url }) => lc.report(parseRange(url.searchParams.get("days"))) },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => lc.settings() },
    { method: "GET", path: "/api/v1/integrations", auth: "viewer", handle: () => lc.integrations() },
    { method: "GET", path: "/api/v1/team", auth: "viewer", handle: () => ({ members: lc.team() }) },
    { method: "GET", path: "/api/v1/me", auth: "viewer", handle: ({ who }) => ({ id: who.id, name: who.name, away: lc.awayOf(who.id) }) },
    {
      method: "PUT",
      path: "/api/v1/me/away",
      auth: "editor",
      handle: async ({ who, body }) => {
        const b = await body();
        if (!b || typeof b !== "object" || typeof (b as { away?: unknown }).away !== "boolean")
          throw new LcError(422, "invalid-body", "The body is { away: true or false }.");
        return lc.setAway(who, (b as { away: boolean }).away);
      },
    },
    {
      method: "GET",
      path: "/api/v1/chats",
      auth: "viewer",
      handle: ({ url }) => {
        // The number first: anything that happens while the list is read comes again on the stream, and is told apart by it.
        const seq = lc.lastSeq();
        return { chats: lc.list(url.searchParams), seq };
      },
    },
    { method: "GET", path: "/api/v1/chats/:number", auth: "viewer", handle: ({ params }) => lc.detail(num(params[0]!)) },
    { method: "GET", path: "/api/v1/chats/:number/visitor", auth: "viewer", handle: ({ params }) => lc.visitor(num(params[0]!)) },
    {
      method: "POST",
      path: "/api/v1/chats/:number/messages",
      auth: "editor",
      handle: async ({ res, who, params, body }) => {
        const r = lc.agentSay(who, num(params[0]!), await body());
        json(res, r.added ? 201 : 200, r.line);
      },
    },
    {
      method: "POST",
      path: "/api/v1/chats/:number/assign",
      auth: "editor",
      handle: async ({ who, params, body }) => lc.assign(who, num(params[0]!), await body()),
    },
    { method: "POST", path: "/api/v1/chats/:number/close", auth: "editor", handle: ({ who, params }) => lc.agentClose(who, num(params[0]!)) },
    { method: "POST", path: "/api/v1/chats/:number/ticket", auth: "editor", handle: ({ who, params }) => lc.makeTicket(who, num(params[0]!)) },
    { method: "POST", path: "/api/v1/chats/:number/lead", auth: "editor", handle: ({ who, params }) => lc.makeLead(who, num(params[0]!)) },
    { method: "GET", path: "/api/v1/questions", auth: "viewer", handle: ({ url }) => ({ questions: lc.questions(parseRange(url.searchParams.get("days"))) }) },
    { method: "GET", path: "/api/v1/files/:id", auth: "viewer", handle: ({ res, params }) => sendFile(res, lc.file(params[0]!)) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor & { session: boolean } {
    if (access === "none") return { id: "anonymous", name: "Anonymous", session: false };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", session: false };
    const p = auth.authorize(req, access);
    return p.kind === "session"
      ? { id: p.user.id, name: p.user.name, email: p.user.email, session: p.role !== "viewer" }
      : { id: `token:${p.tokenId}`, name: p.name, session: false };
  }

  // ------------------------------------------------------------------ the window's API: pages of the sites, no sign-in

  const clientAddress = (req: IncomingMessage) => {
    const xff = trustProxy ? (req.headers["x-forwarded-for"] as string | undefined)?.split(",").pop()?.trim() : undefined;
    return xff || req.socket.remoteAddress || "";
  };
  const hits = new Map<string, { minute: number; n: number }>();
  function limit(req: IncomingMessage, rate: Rate, extra = "") {
    const key = `${rate}:${clientAddress(req)}:${extra}`;
    const minute = Math.floor(lc.now() / 60_000);
    const h = hits.get(key);
    if (!h || h.minute !== minute) {
      if (hits.size > 50_000) hits.clear();
      hits.set(key, { minute, n: 1 });
      return;
    }
    if (++h.n > RATES[rate]) throw new LcError(429, "rate-limited", "Too many requests from this address; wait a minute.", 60);
  }
  const openStreams = new Map<string, number>();
  const hold = (key: string, max: number) => {
    const n = openStreams.get(key) ?? 0;
    if (n >= max) throw new LcError(429, "rate-limited", "Too many open streams.", 10);
    openStreams.set(key, n + 1);
    return () => {
      const left = (openStreams.get(key) ?? 1) - 1;
      if (left <= 0) openStreams.delete(key);
      else openStreams.set(key, left);
    };
  };

  const corsHeaders = (origin: string) => ({ "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "retry-after" });

  /** The site the calling page is on: its Origin must be one of a site's hosts. */
  function siteOf(req: IncomingMessage): Site {
    const site = lc.siteFor(req.headers.origin);
    if (!site) throw new LcError(403, "forbidden-origin", "This page's origin is not one of the sites in the settings file.");
    return site;
  }

  async function widget(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<string> {
    const origin = req.headers.origin;
    const site = lc.siteFor(origin);
    const headers: Record<string, string> = { ...(site ? corsHeaders(origin!) : { vary: "Origin" }), "cache-control": "no-store" };
    const name = `/api/v1/widget${path.replace(/\/files\/[^/]+\/[^/]+$/, "/files/:id/:sig")}`;
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          ...headers,
          ...(site && {
            "access-control-allow-methods": "GET, POST, PATCH",
            "access-control-allow-headers": "authorization, content-type, last-event-id, x-client-id, x-file-name",
            "access-control-max-age": "600",
          }),
        })
        .end();
      return name;
    }
    try {
      // A file is opened from an <img> or a link in the window: no Origin, only its signed link.
      const fm = /^\/files\/([A-Za-z0-9_-]{16})\/([A-Za-z0-9_-]{32})$/.exec(path);
      if (fm && req.method === "GET") {
        limit(req, "read");
        sendFile(res, lc.visitorFile(fm[1]!, fm[2]!), { "cross-origin-resource-policy": "cross-origin", "referrer-policy": "no-referrer" });
        return name;
      }
      const s = siteOf(req);
      const chat = () => lc.visitorChat(bearer(req));
      const key = `${req.method} ${path}`;
      switch (key) {
        case "GET /state":
          limit(req, "state");
          return (json(res, 200, lc.widgetState(s), headers), name);
        case "GET /suggest":
          limit(req, "suggest");
          return (json(res, 200, await lc.suggest(url.searchParams.get("q") ?? "", url.searchParams.get("lang") ?? "en"), headers), name);
        case "POST /chats": {
          limit(req, "start");
          const r = lc.startChat(s, await readJson(req, 32 * 1024));
          return (json(res, 201, r, headers), name);
        }
        case "POST /questions": {
          limit(req, "question");
          return (json(res, 202, lc.ask(s, await readJson(req, 32 * 1024)), headers), name);
        }
        case "GET /chat": {
          limit(req, "read");
          const c = chat();
          if (c.site !== s.id) throw new LcError(401, "invalid-token", "This chat's token is not valid.");
          return (json(res, 200, lc.visitorView(c), headers), name);
        }
        case "PATCH /chat": {
          const c = chat();
          limit(req, "details", String(c.number));
          return (json(res, 200, lc.visitorDetails(c, await readJson(req, 8 * 1024)), headers), name);
        }
        case "POST /messages": {
          const c = chat();
          limit(req, "say", String(c.number));
          const r = lc.visitorSay(c, await readJson(req, 32 * 1024));
          return (json(res, r.added ? 201 : 200, r.line, headers), name);
        }
        case "POST /files": {
          const c = chat();
          limit(req, "file", String(c.number));
          const max = lc.config()?.files.maxSize ?? 0;
          const data = await readBody(req, max + 1024);
          const fname = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
          const cid = typeof req.headers["x-client-id"] === "string" ? req.headers["x-client-id"] : null;
          if (cid !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(cid)) throw new LcError(422, "invalid-body", "x-client-id is 8 to 64 letters, digits, _ and -.");
          const r = lc.addFile(c, { kind: "visitor" }, String(req.headers["content-type"] ?? ""), fname, data, cid);
          return (json(res, r.added ? 201 : 200, r.visitorLine, headers), name);
        }
        case "POST /pages": {
          const c = chat();
          limit(req, "page", String(c.number));
          lc.visitorPage(c, await readJson(req, 8 * 1024));
          return (res.writeHead(204, headers).end(), name);
        }
        case "POST /close": {
          const c = chat();
          limit(req, "details", String(c.number));
          return (json(res, 200, lc.visitorClose(c), headers), name);
        }
        case "GET /stream": {
          limit(req, "stream");
          const c = chat();
          const after = afterOf(req, url);
          const releaseChat = hold(`chat:${c.number}`, STREAMS_PER_CHAT);
          let releaseAddress: () => void;
          try {
            releaseAddress = hold(`ip:${clientAddress(req)}`, STREAMS_PER_ADDRESS);
          } catch (err) {
            releaseChat();
            throw err;
          }
          stream(
            req,
            res,
            headers,
            (write) => lc.subscribeVisitor(c, after, write),
            () => (releaseChat(), releaseAddress()),
          );
          return name;
        }
      }
      throw new LcError(404, "not-found", "There is no such route for the window.");
    } catch (err) {
      if (!(err instanceof LcError)) throw err;
      if (!req.complete) req.resume();
      if (!res.headersSent)
        problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
      return name;
    }
  }

  // ------------------------------------------------------------------ the window's script: /w/<site>.js

  let built: { at: number; text: string | null } = { at: 0, text: null };
  async function script(res: ServerResponse, id: string) {
    if (!built.text || Date.now() - built.at > 60_000) {
      built = { at: Date.now(), text: widgetFile ? await readFile(widgetFile, "utf8").catch(() => null) : null };
    }
    const c = lc.config();
    const site = c?.sites.find((s) => s.id === id);
    const headers = { "cache-control": SCRIPT_CACHE, "cross-origin-resource-policy": "cross-origin" };
    if (!site || !c) return send(res, 404, "/* OpenAsy Live Chat: no such site in live-chat.yaml. */\n", "text/javascript; charset=utf-8", headers);
    if (!built.text) return send(res, 503, "/* OpenAsy Live Chat: the window script is not built. */\n", "text/javascript; charset=utf-8", headers);
    const settings = {
      site: site.id,
      endpoint: publicUrl,
      title: site.title ?? c.window.title,
      colour: c.window.colour,
      position: c.window.position,
      greeting: c.window.greeting,
      privacy: c.window.privacy,
      askEmail: site.askEmail,
      consent: site.consent,
      outside: c.hours.outside,
      suggest: c.window.suggestArticles && !!c.knowledgeBase,
      files: { types: c.files.types, maxSize: c.files.maxSize },
    };
    // JSON is valid JavaScript; < is escaped so nothing in the file can close a script element around it.
    const config = JSON.stringify(settings).replace(/</g, "\\u003c");
    send(res, 200, `${built.text}\nOALC.start(${config});\n`, "text/javascript; charset=utf-8", headers);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!lc.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }

    if (path.startsWith("/api/v1/widget/") || path === "/api/v1/widget") return widget(req, res, url, path.slice("/api/v1/widget".length));

    const w = /^\/w\/([a-z][a-z0-9-]{0,31})\.js$/.exec(path);
    if (w && (req.method === "GET" || req.method === "HEAD")) return (await script(res, w[1]!), "/w/:site.js");

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(lc, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    if (path === "/api/v1/stream" && req.method === "GET") {
      try {
        const who = authorize(req, "viewer");
        const after = afterOf(req, url);
        // Members who answer chats count as available while their screen is open.
        const gone = who.session ? lc.connected(who) : undefined;
        stream(req, res, {}, (write) => lc.subscribe(after, null, write), gone);
      } catch (err) {
        if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof LcError) problem(res, err.status, err.code, err.message);
        else throw err;
      }
      return "/api/v1/stream";
    }

    for (const rt of compiled) {
      const m = path.match(rt.re);
      if (!m || rt.method !== req.method) continue;
      try {
        const who = authorize(req, rt.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await rt.handle({ req, res, url, params, who, body: () => readJson(req, rt.limit ?? 64 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return rt.path;
        }
        if (!(err instanceof LcError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return rt.path;
    }

    // The team's own file upload: a raw body, like the window's.
    const up = /^\/api\/v1\/chats\/([^/]+)\/files$/.exec(path);
    if (up && req.method === "POST") {
      try {
        const who = authorize(req, "editor");
        const row = lc.row(num(decodeURIComponent(up[1]!)));
        const max = lc.config()?.files.maxSize ?? 0;
        const data = await readBody(req, max + 1024);
        const fname = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
        const cid =
          typeof req.headers["x-client-id"] === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(req.headers["x-client-id"]) ? req.headers["x-client-id"] : null;
        const r = lc.addFile(row, { kind: "agent", who }, String(req.headers["content-type"] ?? ""), fname, data, cid);
        json(res, r.added ? 201 : 200, r.line);
      } catch (err) {
        if (!req.complete) req.resume();
        if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof LcError) problem(res, err.status, err.code, err.message);
        else throw err;
      }
      return "/api/v1/chats/:number/files";
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Files' signed links are not written to the log; neither are the window's frequent calls.
    if (!["/healthz", "/metrics", "/api/v1/widget/files/:id/:sig", "/api/v1/widget/state", "/api/v1/widget/suggest", "/w/:site.js"].includes(routeName)) {
      log("info", "request", {
        method: req.method,
        path: routeName.startsWith("/api/v1/widget") ? routeName : (req.url ?? "/").split("?")[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      });
    }
  };
  /** Ends every open stream, for shutting down: clients reconnect to the next instance and resume. */
  const closeStreams = () => {
    for (const s of streams) s.end();
    streams.clear();
  };
  return Object.assign(handler, { closeStreams });
}
