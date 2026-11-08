// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkify, parseEvents, pickLanguage, start, textOn, type Settings } from "./w.ts";

const SETTINGS: Settings = {
  site: "www",
  endpoint: "https://chat.acme.example",
  title: "Acme Books",
  colour: "#1d4ed8",
  position: "right",
  greeting: null,
  privacy: "https://www.acme.example/privacy",
  askEmail: true,
  consent: null,
  outside: "form",
  suggest: false,
  files: { types: ["image/png"], maxSize: 1024 * 1024 },
};

// The window's shadow root is closed on real pages; the tests open it to look inside.
const attach = Element.prototype.attachShadow;
let calls: Array<{ url: string; init: RequestInit }>;
let streamBody: string;
let stop: { destroy: () => void } | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AGENT_LINE = {
  id: "l2",
  seq: 7,
  kind: "agent",
  name: "Emily Clark",
  text: '<img src=x onerror="alert(1)"> see https://kb.acme.example/a and javascript:alert(1)',
  at: "2026-11-02T12:01:00.000Z",
  file: null,
  event: null,
  data: null,
  clientId: null,
};

beforeEach(() => {
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    return attach.call(this, { ...init, mode: "open" });
  };
  document.body.innerHTML = "<p>The site</p>";
  document.documentElement.lang = "en";
  localStorage.clear();
  calls = [];
  streamBody = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const path = new URL(url).pathname.replace("/api/v1/widget", "");
      if (path === "/state")
        return json({ site: "www", open: true, outside: "form", opensAt: null, closesAt: null, timeZone: "Europe/Istanbul", available: 1 });
      if (path === "/chats")
        return json(
          {
            token: "AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            seq: 3,
            chat: {
              state: { status: "open", agent: null, ticket: null, email: true },
              lines: [
                {
                  id: "l1",
                  seq: 3,
                  kind: "visitor",
                  name: null,
                  text: JSON.parse(String(init.body)).message,
                  at: "2026-11-02T12:00:00.000Z",
                  file: null,
                  event: null,
                  data: null,
                  clientId: "x",
                },
              ],
            },
          },
          201,
        );
      if (path === "/stream") return new Response(streamBody, { headers: { "content-type": "text/event-stream" } });
      if (path === "/chat") return json({ state: { status: "open", agent: "Emily Clark", ticket: null, email: true }, lines: [AGENT_LINE], seq: 7 });
      if (path === "/pages") return new Response(null, { status: 204 });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  stop?.destroy();
  stop = null;
  Element.prototype.attachShadow = attach;
  vi.unstubAllGlobals();
  delete (window as unknown as { OpenAsyConsent?: unknown }).OpenAsyConsent;
});

const root = () => document.querySelector("[data-openasy-chat]")?.shadowRoot ?? null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("the window", () => {
  it("is drawn in its own shadow root, away from the page's styles", async () => {
    stop = start(SETTINGS);
    await tick();
    const r = root()!;
    expect(r.querySelector("style")!.textContent).toContain(":host{all:initial}");
    const launcher = r.querySelector("button.b") as HTMLButtonElement;
    expect(launcher.getAttribute("aria-label")).toBe("Chat with us");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    launcher.click();
    await tick(10);
    expect(r.querySelector("[role=dialog]")!.hasAttribute("hidden")).toBe(false);
    expect(r.querySelector("[role=dialog]")!.textContent).toContain("We usually answer within a minute");
    expect(r.querySelector("[role=dialog]")!.textContent).toContain("Nothing is kept about you until you write.");
    // Escape closes it again.
    r.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps nothing in the browser until a chat starts", async () => {
    stop = start(SETTINGS);
    await tick();
    const r = root()!;
    (r.querySelector("button.b") as HTMLButtonElement).click();
    await tick(10);
    expect(localStorage.length).toBe(0);
    expect(calls.every((c) => c.init.credentials === "omit")).toBe(true);
    (r.querySelector("input[type=email]") as HTMLInputElement).value = "seda@polat.example";
    (r.querySelector("textarea") as HTMLTextAreaElement).value = "Can the invoices be in Turkish?";
    r.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(20);
    const started = calls.find((c) => c.url.endsWith("/chats"))!;
    expect(JSON.parse(String(started.init.body))).toMatchObject({
      message: "Can the invoices be in Turkish?",
      email: "seda@polat.example",
      page: location.href,
      language: "en",
    });
    expect(JSON.parse(localStorage.getItem("openasy.chat.www")!)).toEqual({ t: "AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", s: 3 });
    // The stream goes with the token in a header, from the last event seen.
    const stream = calls.find((c) => c.url.includes("/stream"))!;
    expect(stream.url).toContain("after=3");
    expect((stream.init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it("shows what the team writes as text, with only http(s) links", async () => {
    localStorage.setItem("openasy.chat.www", JSON.stringify({ t: "AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", s: 2 }));
    stop = start(SETTINGS);
    await tick(20);
    const r = root()!;
    (r.querySelector("button.b") as HTMLButtonElement).click();
    await tick(10);
    const log = r.querySelector("[role=log]")!;
    expect(log.querySelector("img")).toBeNull();
    expect(log.textContent).toContain('<img src=x onerror="alert(1)">');
    const links = [...log.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://kb.acme.example/a"]);
    expect(log.querySelector("a")!.getAttribute("rel")).toContain("noopener");
  });

  it("waits for Consent on sites that ask first, and goes when it is withdrawn", async () => {
    let answer: boolean | null = null;
    const listeners: Array<(a: Record<string, boolean | null>) => void> = [];
    stop = start({ ...SETTINGS, consent: "support" });
    await tick(50);
    expect(root()).toBeNull();
    // Consent's script loads after the window's, with no answer yet.
    (window as unknown as { OpenAsyConsent: unknown }).OpenAsyConsent = {
      get: () => answer,
      on: (fn: (a: Record<string, boolean | null>) => void) => (listeners.push(fn), () => {}),
      open: () => {},
    };
    await tick(250);
    expect(root()).toBeNull();
    answer = true;
    for (const fn of listeners) fn({ support: true });
    expect(root()).not.toBeNull();
    localStorage.setItem("openasy.chat.www", "{}");
    window.dispatchEvent(new CustomEvent("openasy:consent", { detail: { support: false } }));
    expect(root()).toBeNull();
    expect(localStorage.getItem("openasy.chat.www")).toBeNull();
  });
});

describe("its parts", () => {
  it("reads an event stream in pieces", () => {
    const got: Array<[string, string, string | null]> = [];
    let rest = parseEvents('retry: 2000\n\nid: 4\nevent: line\ndata: {"seq":4}\n\n: ping\n\nid: 5\nevent: li', (e, d, id) => got.push([e, d, id]));
    rest = parseEvents(`${rest}ne\ndata: {"seq":5}\n\nevent: reset\ndata: {}\n\n`, (e, d, id) => got.push([e, d, id]));
    expect(got).toEqual([
      ["line", '{"seq":4}', "4"],
      ["line", '{"seq":5}', "5"],
      ["reset", "{}", null],
    ]);
    expect(rest).toBe("");
  });

  it("links only http(s) addresses, and keeps the rest as text", () => {
    const parts = linkify("see https://a.example/x?y=1. or javascript:alert(1) <b>");
    expect(parts.filter((p) => typeof p !== "string").map((a) => (a as HTMLAnchorElement).href)).toEqual(["https://a.example/x?y=1"]);
    expect(parts.filter((p) => typeof p === "string").join("")).toContain("javascript:alert(1) <b>");
  });

  it("picks readable text on the colour, and the visitor's language", () => {
    expect(textOn("#1d4ed8")).toBe("#fff");
    expect(textOn("#fde047")).toBe("#111");
    expect(pickLanguage(["fr-FR", "tr-TR"])).toBe("tr");
    expect(pickLanguage([null, "ja"])).toBe("en");
  });
});
