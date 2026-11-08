import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniff } from "./sniff.ts";
import { APP, ENV, readStream, SITE, startApp } from "./test-app.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version, heartbeatMs: 200 });
  app.member("u-emily", "Emily Clark");
  app.member("u-can", "Can Öztürk", "can@acme.example");
  app.member("u-viewer", "Vera Viewer", "vera@acme.example", "viewer");
});
afterAll(() => app.close());

const emily = { id: "u-emily", name: "Emily Clark" };
const can = { id: "u-can", name: "Can Öztürk" };
const json = (b: unknown) => JSON.stringify(b);

describe("the window's API", () => {
  it("answers pages of the sites only, and lets them read the answer", async () => {
    const pre = await fetch(`${app.base}/api/v1/widget/chats`, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const evil = await app.page("/state", { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const state = await app.page("/state");
    expect(state.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await state.json()).toMatchObject({ site: "www", open: true, outside: "form", opensAt: null });
  });

  it("serves each site's script with its settings, and nothing in them can close the script", async () => {
    const res = await fetch(`${app.base}/w/www.js`);
    expect(res.status).toBe(503); // not built in tests: there is no widget file
    const missing = await fetch(`${app.base}/w/nope.js`);
    expect(missing.status).toBe(404);
  });

  it("starts a chat on the page's team, keeping only the page's path and the referring site", async () => {
    const res = await app.page("/chats", {
      method: "POST",
      body: json({
        message: "Can the invoices be in Turkish?",
        client_id: "first-line-1",
        email: "Seda@Polat.example",
        name: "Seda Polat",
        page: `${SITE}/pricing?coupon=SECRET#top`,
        referrer: "https://www.google.com/search?q=e-fatura",
        device: "desktop",
        analytics: { visitor: "visitor-0001", session: "session-0001" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; seq: number; chat: { state: object; lines: Array<{ kind: string; text: string; clientId: string }> } };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);
    // The window sees its own line, not the team's note of how it was routed.
    expect(body.chat.lines.map((l) => [l.kind, l.text])).toEqual([["visitor", "Can the invoices be in Turkish?"]]);
    expect(body.chat.state).toEqual({ status: "open", agent: null, ticket: null, email: true });
    const c = app.lc.list(new URLSearchParams())[0]!;
    expect(c).toMatchObject({
      team: { id: "sales" },
      routedBy: "/pricing",
      page: "/pricing",
      referrer: "www.google.com",
      visitor: { email: "seda@polat.example" },
    });
    expect(app.lc.detail(c.number).lines[0]).toMatchObject({ kind: "system", event: "started", shown: false });
  });

  it("asks for an email where the site does, and refuses pages of other sites", async () => {
    const noEmail = await app.page("/chats", { method: "POST", body: json({ message: "Hi", page: `${SITE}/` }) });
    expect(noEmail.status).toBe(422);
    const otherPage = await app.page("/chats", { method: "POST", body: json({ message: "Hi", email: "a@b.example", page: `${APP}/app/x` }) });
    expect(otherPage.status).toBe(422);
    const app2 = await app.page("/chats", { method: "POST", origin: APP, body: json({ message: "Bank code never arrives", page: `${APP}/app/bank/connect` }) });
    expect(app2.status).toBe(201);
    expect(app.lc.detail(app.numberOf(((await app2.json()) as { token: string }).token))).toMatchObject({ site: "app", team: { id: "support" } });
  });

  it("adds a line once however often it is sent", async () => {
    const { token } = await app.start();
    const say = () => app.page("/messages", { method: "POST", token, body: json({ text: "Hello?", client_id: "retry-line-0001" }) });
    const a = await say();
    const b = await say();
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(((await a.json()) as { id: string }).id).toBe(((await b.json()) as { id: string }).id);
    const view = (await (await app.page("/chat", { token })).json()) as { lines: Array<{ text: string }> };
    expect(view.lines.filter((l) => l.text === "Hello?")).toHaveLength(1);
    expect((await app.page("/chat", { token: `${token.slice(0, -2)}xx` })).status).toBe(401);
  });

  it("limits how often one address starts chats", async () => {
    let last = 0;
    for (let i = 0; i < 8; i++)
      last = (
        await app.page("/chats", {
          method: "POST",
          headers: { "x-forwarded-for": "192.0.2.7" },
          body: json({ message: "x", email: "a@b.example", page: `${SITE}/` }),
        })
      ).status;
    expect(last).toBe(429);
    app.clock.advance(60_000);
  });
});

describe("the team answers", () => {
  it("takes the chat with the first answer, and hands it to a colleague", async () => {
    const { token, number } = await app.start("Does Pro include e-Arşiv?");
    const first = app.lc.agentSay(emily, number, { text: "Yes, it does.", client_id: "agent-line-01" });
    expect(first.added).toBe(true);
    let c = app.lc.detail(number);
    expect(c.agent).toEqual(emily);
    expect(c.waitingSince).toBeNull();
    expect(c.firstAnswerAt).not.toBeNull();
    app.lc.assign(emily, number, { agent: "u-can", note: "Knows e-Arşiv best" });
    c = app.lc.detail(number);
    expect(c.agent).toEqual(can);
    const handed = c.lines.find((l) => l.event === "handed")!;
    expect(handed).toMatchObject({ shown: false, text: "Knows e-Arşiv best", data: { by: "Emily Clark", to: "Can Öztürk" } });
    // The visitor is told who answers now, and nothing of the note.
    const view = (await (await app.page("/chat", { token })).json()) as {
      state: { agent: string };
      lines: Array<{ event: string | null; text: string; name: string | null }>;
    };
    expect(view.state.agent).toBe("Can Öztürk");
    expect(view.lines.map((l) => l.event).filter(Boolean)).toEqual(["joined", "joined"]);
    expect(JSON.stringify(view)).not.toContain("Knows e-Arşiv best");
    expect(JSON.stringify(view)).not.toContain("u-emily");
    expect(() => app.lc.assign(emily, number, { agent: "u-viewer" })).toThrow(/member who answers chats/);
  });

  it("closes, after which neither side can write", async () => {
    const { token, number } = await app.start();
    app.lc.agentClose(emily, number);
    expect((await app.page("/messages", { method: "POST", token, body: json({ text: "Still there?" }) })).status).toBe(409);
    expect(() => app.lc.agentSay(emily, number, { text: "x" })).toThrow(/closed/);
    // The team spoke last: no ticket.
    expect(app.lc.detail(number).ticket).toBeNull();
  });

  it("knows who answers for which team, and who is available", async () => {
    const stop = app.lc.connected(emily);
    const members = app.lc.team();
    expect(members.find((m) => m.id === "u-emily")).toMatchObject({ state: "available", teams: ["Sales"] });
    expect(members.find((m) => m.id === "u-can")).toMatchObject({ state: "offline", teams: ["Sales", "Support"] });
    expect(members.some((m) => m.id === "u-viewer")).toBe(false);
    app.lc.setAway(emily, true);
    expect(app.lc.team().find((m) => m.id === "u-emily")!.state).toBe("away");
    app.lc.setAway(emily, false);
    stop();
  });
});

describe("files", () => {
  it("takes only the file types of the settings, by their bytes", async () => {
    const { token } = await app.start();
    const send = (body: Buffer, type: string, name = "shot.png") =>
      app.page("/files", {
        method: "POST",
        token,
        body,
        headers: { "content-type": type, "x-file-name": encodeURIComponent(name), "x-client-id": `file-${Math.random().toString(36).slice(2, 10)}` },
      });
    const ok = await send(PNG, "image/png", "../../ekran görüntüsü.png");
    expect(ok.status).toBe(201);
    const line = (await ok.json()) as { file: { name: string; url: string; type: string } };
    expect(line.file.name).toBe("....ekran görüntüsü.png");
    expect((await send(Buffer.from("<html><script>alert(1)</script>"), "image/png")).status).toBe(415);
    expect((await send(Buffer.from("<svg onload=alert(1)>"), "image/svg+xml")).status).toBe(415);
    expect((await send(Buffer.from("<script>x</script>"), "text/plain", "a.txt")).status).toBe(415);
    expect((await send(Buffer.alloc(1024 * 1024 + 10, 0x41), "text/plain", "big.txt")).status).toBe(413);
    // Served from its signed link only, in a sandbox.
    const file = await fetch(app.base + line.file.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect((await fetch(app.base + line.file.url.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status).toBe(404);
  });

  it("knows a file by its first bytes", () => {
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniff(Buffer.from("Order 42\nthanks"))).toBe("text/plain");
    expect(sniff(Buffer.from([0xff, 0xfe, 0x00, 0x01]))).toBeNull();
  });
});

describe("streams resume without losing or repeating", () => {
  it("replays what a reconnecting window missed, once, then follows", async () => {
    const { token, number, seq } = await app.start("First");
    app.lc.agentSay(emily, number, { text: "One" });
    app.lc.agentSay(emily, number, { text: "Two" });
    // A window that saw the start reconnects: it gets the two answers and the state changes, nothing before.
    const res = await app.page(`/stream?after=${seq}`, { token });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const pending = readStream(res, (ev) => ev.filter((e) => e.event === "line").length >= 4);
    await new Promise((r) => setTimeout(r, 50));
    app.lc.agentSay(emily, number, { text: "Three, live" });
    const events = await pending;
    const lines = events.filter((e) => e.event === "line").map((e) => e.data.line.text || e.data.line.event);
    expect(lines).toEqual(["joined", "One", "Two", "Three, live"]);
    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i > seq)).toBe(true);
    // From the last id it saw, there is nothing new.
    const again = await app.page("/stream", { token, headers: { "last-event-id": String(ids.at(-1)) } });
    expect((await readStream(again, () => false, 300)).filter((e) => e.event === "line")).toEqual([]);
  });

  it("gives the team every chat, and tells a client too far behind to load again", async () => {
    const { number } = await app.start("For the team");
    const res = await app.admin("/api/v1/stream?after=0");
    const events = await readStream(res, (ev) => ev.some((e) => e.event === "line" && e.data.chat === number && e.data.line.event === "started"));
    expect(events.some((e) => e.event === "chat" && e.data.summary.number === number)).toBe(true);
    // Events older than the kept log: reset.
    app.db.prepare("DELETE FROM events WHERE seq < (SELECT MAX(seq) - 3 FROM events)").run();
    const behind = await app.admin("/api/v1/stream?after=1");
    expect((await readStream(behind, (ev) => ev.some((e) => e.event === "reset"))).at(-1)!.event).toBe("reset");
    expect((await app.admin("/api/v1/stream?after=-1")).status).toBe(422);
  });

  it("does not send the window the team's own lines", async () => {
    const { token, number, seq } = await app.start();
    const res = await app.page(`/stream?after=${seq}`, { token });
    const pending = readStream(res, (ev) => ev.some((e) => e.event === "line" && e.data.line.text === "After the note"));
    await new Promise((r) => setTimeout(r, 50));
    app.lc.assign(emily, number, { team: "support", note: "Secret note" });
    app.lc.agentSay(emily, number, { text: "After the note" });
    const events = await pending;
    expect(JSON.stringify(events)).not.toContain("Secret note");
  });
});

describe("Helpdesk", () => {
  it("makes an unanswered chat a ticket, with what is said after it too", async () => {
    const { token, number } = await app.start("Is there a discount for accountants?");
    app.clock.advance(11 * 60_000);
    await app.lc.tick();
    const c = app.lc.detail(number);
    expect(c.ticket).toMatchObject({ reason: "unanswered", number: expect.any(Number) });
    const t = app.helpdesk.tickets.find((x) => x.number === c.ticket!.number)!;
    expect(t).toMatchObject({
      external_id: expect.stringMatching(/^live-chat-/),
      email: "seda@polat.example",
      form: "sales",
      subject: "Is there a discount for accountants?",
    });
    expect(t.transcript!.map((l) => [l.from, l.text])).toEqual([["customer", "Is there a discount for accountants?"]]);
    // The visitor is told the ticket's number.
    const view = (await (await app.page("/chat", { token })).json()) as { state: { ticket: number } };
    expect(view.state.ticket).toBe(t.number);
    await app.page("/messages", { method: "POST", token, body: json({ text: "We have 40 clients." }) });
    app.lc.agentSay(emily, number, { text: "Yes: 20% off." });
    await app.lc.tick();
    expect(t.added.map((l) => [l.from, l.text])).toEqual([
      ["customer", "We have 40 clients."],
      ["agent", "Yes: 20% off."],
    ]);
  });

  it("asks for an email first when the site did not, then makes the ticket", async () => {
    const res = await app.page("/chats", { method: "POST", origin: APP, body: json({ message: "Cancel button is grey", page: `${APP}/app/invoices` }) });
    const { token } = (await res.json()) as { token: string };
    const number = app.numberOf(token);
    app.clock.advance(11 * 60_000);
    await app.lc.tick();
    expect(app.lc.detail(number).ticket).toBeNull();
    expect(app.lc.detail(number).lines.at(-1)).toMatchObject({ event: "ask-email", shown: true });
    const patched = await app.page("/chat", { method: "PATCH", origin: APP, token, body: json({ email: "nihan@er.example" }) });
    expect(await patched.json()).toMatchObject({ email: true });
    await app.lc.tick();
    expect(app.lc.detail(number).ticket).toMatchObject({ reason: "unanswered", number: expect.any(Number) });
  });

  it("makes a chat left open on a question a ticket when it closes, and tries again when Helpdesk is down", async () => {
    const { number } = await app.start("Hello");
    app.lc.agentSay(emily, number, { text: "Hello, how can I help?" });
    app.helpdesk.fail(100);
    // The visitor asks, no one answers, and the chat goes quiet.
    app.lc.visitorSay(app.lc.row(number), { text: "How do I change the VAT rate?" });
    app.clock.advance(31 * 60_000);
    await app.lc.tick();
    let c = app.lc.detail(number);
    expect(c).toMatchObject({ status: "closed", closedBy: "idle", ticket: { reason: "left-open", number: null, error: "Helpdesk answered 503" } });
    app.helpdesk.fail(0);
    app.clock.advance(2 * 60_000);
    await app.lc.tick();
    c = app.lc.detail(number);
    expect(c.ticket).toMatchObject({ reason: "left-open", number: expect.any(Number), error: null });
  });

  it("makes a ticket when an agent asks, once", async () => {
    const { number } = await app.start("Please call me");
    const a = await app.lc.makeTicket(emily, number);
    const b = await app.lc.makeTicket(emily, number);
    expect(a.ticket!.number).toBe(b.ticket!.number);
    expect(app.helpdesk.tickets.filter((x) => x.number === a.ticket!.number)).toHaveLength(1);
  });

  it("takes questions outside working hours and makes each a ticket", async () => {
    app.clock.set(Date.parse("2026-11-02T19:41:00Z")); // 22:41 in Istanbul
    const state = (await (await app.page("/state")).json()) as { open: boolean; opensAt: string };
    expect(state.open).toBe(false);
    expect(state.opensAt).toBe("2026-11-03T06:00:00.000Z");
    expect((await app.page("/chats", { method: "POST", body: json({ message: "x", email: "a@b.example", page: `${SITE}/` }) })).status).toBe(409);
    const ask = await app.page("/questions", {
      method: "POST",
      body: json({
        email: "murat@kilic.example",
        name: "Murat Kılıç",
        question: "Is there a discount for accountants with many clients?",
        page: `${SITE}/pricing`,
      }),
    });
    expect(ask.status).toBe(202);
    const bot = await app.page("/questions", { method: "POST", body: json({ email: "bot@x.example", question: "spam", website: "http://spam" }) });
    expect(bot.status).toBe(202);
    await app.lc.tick();
    const q = app.lc.questions(7).find((x) => x.email === "murat@kilic.example")!;
    expect(q.ticket).toEqual(expect.any(Number));
    expect(app.lc.questions(7).some((x) => x.email === "bot@x.example")).toBe(false);
    const t = app.helpdesk.tickets.find((x) => x.number === q.ticket)!;
    expect(t).toMatchObject({ email: "murat@kilic.example", name: "Murat Kılıç", form: "sales" });
    expect(t.message).toContain("(https://www.acme.example/pricing)");
    app.clock.set(Date.parse("2026-11-03T12:00:00Z"));
  });
});

describe("Analytics, CRM and Knowledge Base", () => {
  it("shows the visitor's pages from Analytics", async () => {
    const { number } = await app.start("Hi", { analytics: { visitor: "visitor-0001", session: "session-0001" } });
    const v = await app.lc.visitor(number);
    expect(v).toMatchObject({ linked: true, ids: true, error: null, visit: { source: "google.com" } });
    expect(v.visit!.pages.map((p) => p.path)).toEqual(["/", "/features/e-fatura", "/pricing"]);
    expect(v.pages.map((p) => p.path)).toEqual(["/pricing"]);
  });

  it("opens a lead in CRM once, with the chat and the pages read", async () => {
    const { number } = await app.start("We need invoices in Turkish for 40 buyers", {
      analytics: { visitor: "visitor-0001", session: "session-0001" },
      name: "Seda Polat",
    });
    app.lc.agentSay(emily, number, { text: "Yes, per buyer." });
    const s = await app.lc.makeLead({ ...emily, email: "u-emily@acme.example" }, number);
    expect(s.lead).toMatchObject({ id: expect.stringMatching(/^lead-/), url: expect.stringContaining("https://crm.acme.example/leads/"), by: "Emily Clark" });
    await app.lc.makeLead(emily, number);
    const sent = app.leads.filter((l) => l.external_id === app.leads.at(-1)!.external_id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      source: "live-chat",
      name: "Seda Polat",
      email: "seda@polat.example",
      page: `${SITE}/pricing`,
      title: "We need invoices in Turkish for 40 buyers",
      owner: { name: "Emily Clark", email: "u-emily@acme.example" },
      referrer: "https://www.google.com/",
    });
    expect(sent[0]!.pages.map((p) => p.path)).toEqual(["/", "/features/e-fatura", "/pricing"]);
    expect(sent[0]!.transcript.map((l) => l.from)).toEqual(["visitor", "agent"]);
  });

  it("suggests articles for the first question, to the visitor and the team", async () => {
    const { token, number } = await app.start("How do I change my plan?");
    await new Promise((r) => setTimeout(r, 20));
    expect(app.lc.detail(number).articles).toEqual([{ title: "Change your plan", excerpt: "", url: "https://kb.acme.example/en/articles/plan" }]);
    const view = (await (await app.page("/chat", { token })).json()) as { lines: Array<{ event: string | null }> };
    expect(view.lines.some((l) => l.event === "articles")).toBe(true);
    const before = await app.page(`/suggest?${new URLSearchParams({ q: "change plan", lang: "en" })}`);
    expect(((await before.json()) as { articles: unknown[] }).articles).toHaveLength(1);
  });
});

describe("reports", () => {
  it("counts chats by page and hour, first answers, tickets and leads", () => {
    const r = app.lc.report(30);
    expect(r.totals.chats).toBeGreaterThan(5);
    expect(r.totals.tickets.unanswered).toBeGreaterThanOrEqual(2);
    expect(r.totals.tickets.afterHours).toBe(1);
    expect(r.totals.leads).toBe(1);
    expect(r.byPage[0]).toEqual({ page: "/pricing", chats: expect.any(Number) });
    // Monday 15:00 in Istanbul.
    expect(r.byHour[0]![15]).toBeGreaterThan(0);
    expect(r.byTeam.map((t) => t.id)).toEqual(["sales", "support"]);
    const o = app.lc.overview();
    expect(o.team.length).toBe(2);
    expect(o.perHour.today).toHaveLength(24);
  });
});

describe("keys", () => {
  it("does not print secrets in the settings", () => {
    expect(JSON.stringify(app.lc.settings())).not.toContain(ENV.LC_HELPDESK_KEY);
    expect(app.lc.integrations().helpdesk).toMatchObject({ linked: true, secret: "LC_HELPDESK_KEY", secretSet: true });
  });
});
