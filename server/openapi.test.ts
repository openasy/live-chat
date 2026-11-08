import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, APP, SITE, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }>; schemas: Record<string, object> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const dir = mkdtempSync(join(tmpdir(), "lc-docs-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>API</title>");
writeFileSync(join(dir, "w.js"), "var OALC={start:function(){}};");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir: dir, widgetFile: join(dir, "w.js"), heartbeatMs: 100 });
  base = app.base;
  app.member("u-emily", "Emily Clark");
});
afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit & { stream?: boolean } = {}, concrete = path) {
  const res = await fetch(base + concrete, { redirect: "manual", ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (type === "text/event-stream") {
    await res.body!.cancel();
    return { res, body: undefined as any };
  }

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
/** A call from a page of the www site, with the chat's token when given. */
const page = (b?: unknown, token?: string, origin = SITE, extra: Record<string, string> = {}) => ({
  headers: {
    origin,
    "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    ...(b !== undefined && !(b instanceof Buffer) ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  },
  ...(b !== undefined && { body: b instanceof Buffer ? b : typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let token = "";
  let number = 0;

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/integrations", admin());
    await call("GET", "/api/v1/team", admin());
    await call("GET", "/api/v1/me", admin());
    await call("PUT", "/api/v1/me/away", admin({ away: false }));
    await call("PUT", "/api/v1/me/away", admin({ away: "no" }));
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("the window", async () => {
    await call("GET", "/w/{site}.js", {}, "/w/www.js");
    const script = await (await fetch(`${base}/w/www.js`)).text();
    expect(script).toContain('OALC.start({"site":"www"');
    await call("GET", "/w/{site}.js", {}, "/w/nope.js");
    await call("GET", "/api/v1/widget/state", page());
    await call("GET", "/api/v1/widget/state", page(undefined, undefined, "https://evil.example"));
    await call("GET", "/api/v1/widget/suggest", page(), "/api/v1/widget/suggest?q=change+plan&lang=en");
    const started = await call(
      "POST",
      "/api/v1/widget/chats",
      page({ message: "How do I change my plan?", client_id: "contract-001", email: "seda@polat.example", page: `${SITE}/pricing`, device: "desktop" }),
    );
    token = started.body.token;
    number = app.numberOf(token);
    await call("POST", "/api/v1/widget/chats", page({ message: "", page: `${SITE}/` }));
    await call("POST", "/api/v1/widget/chats", page("{"));
    await call("GET", "/api/v1/widget/chat", page(undefined, token));
    await call("GET", "/api/v1/widget/chat", page(undefined, "nope"));
    await call("PATCH", "/api/v1/widget/chat", page({ name: "Seda Polat" }, token));
    await call("PATCH", "/api/v1/widget/chat", page({ phone: "x" }, token));
    await call("POST", "/api/v1/widget/messages", page({ text: "Hello?", client_id: "contract-002" }, token));
    await call("POST", "/api/v1/widget/messages", page({ text: "Hello?", client_id: "contract-002" }, token));
    await call("POST", "/api/v1/widget/messages", page({ text: "" }, token));
    const file = await call(
      "POST",
      "/api/v1/widget/files",
      page(PNG, token, SITE, { "content-type": "image/png", "x-file-name": "shot.png", "x-client-id": "contract-003" }),
    );
    await call("POST", "/api/v1/widget/files", page(Buffer.from("<svg/>"), token, SITE, { "content-type": "image/svg+xml" }));
    await call("POST", "/api/v1/widget/files", page(Buffer.alloc(2 * 1024 * 1024), token, SITE, { "content-type": "image/png" }));
    await call("GET", "/api/v1/widget/files/{id}/{sig}", {}, file.body.file.url);
    await call("GET", "/api/v1/widget/files/{id}/{sig}", {}, `/api/v1/widget/files/${"a".repeat(16)}/${"b".repeat(32)}`);
    await call("POST", "/api/v1/widget/pages", page({ page: `${SITE}/features/e-fatura`, title: "e-Fatura" }, token));
    await call("POST", "/api/v1/widget/pages", page({ page: "https://elsewhere.example/" }, token));
    await call("GET", "/api/v1/widget/stream", { ...page(undefined, token), stream: true }, "/api/v1/widget/stream?after=0");
    await call("GET", "/api/v1/widget/stream", page(undefined, "nope"), "/api/v1/widget/stream");
  });

  it("chats", async () => {
    await call("GET", "/api/v1/chats", admin());
    await call("GET", "/api/v1/chats", admin(), "/api/v1/chats?status=all&q=plan");
    await call("GET", "/api/v1/chats", admin(), "/api/v1/chats?status=gone");
    await call("GET", "/api/v1/chats", {});
    await call("GET", "/api/v1/chats/{number}", admin(), `/api/v1/chats/${number}`);
    await call("GET", "/api/v1/chats/{number}", admin(), "/api/v1/chats/99999");
    await call("GET", "/api/v1/chats/{number}/visitor", admin(), `/api/v1/chats/${number}/visitor`);
    await call(
      "POST",
      "/api/v1/chats/{number}/messages",
      admin({ text: "Under Settings, Plan.", client_id: "contract-agent-1" }),
      `/api/v1/chats/${number}/messages`,
    );
    await call("POST", "/api/v1/chats/{number}/messages", admin({ text: "" }), `/api/v1/chats/${number}/messages`);
    await call("POST", "/api/v1/chats/{number}/messages", admin("{"), `/api/v1/chats/${number}/messages`);
    await call(
      "POST",
      "/api/v1/chats/{number}/files",
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/pdf", "x-file-name": "plans.pdf" }, body: Buffer.from("%PDF-1.7\n") },
      `/api/v1/chats/${number}/files`,
    );
    await call(
      "POST",
      "/api/v1/chats/{number}/files",
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/html" }, body: "<b>x</b>" },
      `/api/v1/chats/${number}/files`,
    );
    const f = app.lc.detail(number).lines.find((l) => l.file)!.file!;
    await call("GET", "/api/v1/files/{id}", admin(), `/api/v1/files/${f.id}`);
    await call("GET", "/api/v1/files/{id}", admin(), "/api/v1/files/missing");
    await call("POST", "/api/v1/chats/{number}/assign", admin({ agent: "u-emily", note: "Yours" }), `/api/v1/chats/${number}/assign`);
    await call("POST", "/api/v1/chats/{number}/assign", admin({ agent: "nobody" }), `/api/v1/chats/${number}/assign`);
    await call("POST", "/api/v1/chats/{number}/lead", admin(), `/api/v1/chats/${number}/lead`);
    // What CRM was sent is the contract CRM implements.
    const validate = ajv.getSchema("openapi#/components/schemas/CrmLeadRequest")!;
    expect(validate(app.leads[0]), JSON.stringify(validate.errors)).toBe(true);
    const answer = ajv.getSchema("openapi#/components/schemas/CrmLeadCreated")!;
    expect(answer({ lead: { id: "l-1", url: "https://crm.example.com/leads/l-1", stage: "new" } })).toBe(true);
    await call("POST", "/api/v1/chats/{number}/ticket", admin(), `/api/v1/chats/${number}/ticket`);
    await call("POST", "/api/v1/chats/{number}/close", admin(), `/api/v1/chats/${number}/close`);
    await call("POST", "/api/v1/chats/{number}/close", admin(), "/api/v1/chats/99999/close");
    await call("POST", "/api/v1/chats/{number}/messages", admin({ text: "Closed?" }), `/api/v1/chats/${number}/messages`);
    await call("POST", "/api/v1/widget/messages", page({ text: "After it closed" }, token));
    await call("POST", "/api/v1/widget/close", page(undefined, token));
    await call("GET", "/api/v1/stream", { ...admin(), stream: true }, "/api/v1/stream?after=0");
    await call("GET", "/api/v1/stream", {}, "/api/v1/stream");
  });

  it("outside working hours", async () => {
    app.clock.set(Date.parse("2026-11-02T19:41:00Z"));
    await call("POST", "/api/v1/widget/chats", page({ message: "Late", email: "a@b.example", page: `${SITE}/` }));
    await call("POST", "/api/v1/widget/questions", page({ email: "murat@kilic.example", question: "A discount for accountants?", page: `${SITE}/pricing` }));
    await call("POST", "/api/v1/widget/questions", page({ question: "No email" }));
    await call("POST", "/api/v1/widget/questions", page({ email: "a@b.example", question: "x" }, undefined, APP));
    await app.lc.tick();
    await call("GET", "/api/v1/questions", admin(), "/api/v1/questions?days=7");
    await call("GET", "/api/v1/questions", admin(), "/api/v1/questions?days=2");
  });

  it("reports", async () => {
    await call("GET", "/api/v1/overview", admin());
    await call("GET", "/api/v1/overview", {});
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=30");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=7");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=2");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
