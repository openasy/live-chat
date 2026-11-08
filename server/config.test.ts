import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, pageMatches, parseConfig, parseDuration, routeFor, watchConfig } from "./config.ts";
import { isWorking } from "./hours.ts";
import { SETTINGS } from "./test-app.ts";

describe("the settings file", () => {
  it("reads the example in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/live-chat.yaml", import.meta.url), "utf8"));
    expect(c.sites.map((s) => [s.id, s.origins, s.askEmail, s.consent, s.analytics])).toEqual([
      ["www", ["https://www.example.com"], true, "support", "www"],
      ["app", ["https://app.example.com"], false, null, "app"],
    ]);
    expect(c.hours.text).toBe("weekdays 09:00-18:00");
    expect(c.hours.outside).toBe("form");
    expect(c.teams.map((t) => [t.id, t.groups, t.queue])).toEqual([
      ["sales", ["sales"], "sales"],
      ["support", ["support"], "technical"],
    ]);
    expect(c.window.greeting?.tr).toMatch(/^Merhaba/);
    expect(c.files).toEqual({ types: ["image/png", "image/jpeg", "application/pdf"], maxSize: 10 * 1024 * 1024 });
    expect(c.keepChats).toBe(2 * 365 * 86_400_000);
    expect(c.helpdesk).toEqual({ url: "http://helpdesk:8080", key: "LIVE_CHAT_HELPDESK_KEY" });
    expect(c.crm).toBeNull();
  });

  it("starts with one team, every hour and no sites when there is no file", () => {
    const c = parseConfig("");
    expect(c.sites).toEqual([]);
    expect(c.teams.map((t) => t.id)).toEqual(["support"]);
    expect(c.hours.hours.always).toBe(true);
    expect(configWarnings(c, {})).toContain("No sites: the window cannot be added to a page until sites lists one.");
  });

  it("reads hours as days with their times", () => {
    const c = parseConfig("hours: { timezone: Europe/Istanbul, weekdays: [09:00-12:00, 13:00-18:00], sat: 10:00-14:00 }");
    expect(c.hours.text).toBe("weekdays 09:00-12:00, weekdays 13:00-18:00, sat 10:00-14:00");
    // Monday 2026-11-02 at 12:30 in Istanbul is lunch; 13:30 is open.
    expect(isWorking(c.hours.hours, Date.parse("2026-11-02T09:30:00Z"))).toBe(false);
    expect(isWorking(c.hours.hours, Date.parse("2026-11-02T10:30:00Z"))).toBe(true);
    expect(isWorking(c.hours.hours, Date.parse("2026-11-08T08:00:00Z"))).toBe(false);
  });

  it("routes a page to the first rule's team", () => {
    const c = parseConfig(SETTINGS);
    expect(routeFor(c, "/pricing")).toMatchObject({ team: { id: "sales" }, rule: "/pricing" });
    expect(routeFor(c, "/pricing/")).toMatchObject({ team: { id: "sales" } });
    expect(routeFor(c, "/features/e-fatura")).toMatchObject({ team: { id: "sales" }, rule: "/features/*" });
    expect(routeFor(c, "/app/bank/connect")).toMatchObject({ team: { id: "support" }, rule: "/app/*" });
    expect(routeFor(c, "/blog")).toMatchObject({ team: { id: "sales" }, rule: "*" });
    expect(pageMatches("/help/*", "/helpdesk")).toBe(false);
    expect(pageMatches("/a.b", "/axb")).toBe(false);
  });

  it("says which field to fix", () => {
    const bad: Array<[string, RegExp]> = [
      ["nope: 1", /The file: unknown nope/],
      ["sites: { www: { host: 'ftp://x' } }", /sites.www.host\[0\] is a host/],
      ["sites: { www: { host: www.a.example }, two: { host: www.a.example } }", /also sites.www's/],
      ["sites: { www: { host: www.a.example, consent: 'Yes please' } }", /sites.www.consent is none, or the Consent purpose/],
      ["hours: { timezone: Mars/Base }", /not a time zone/],
      ["hours: { weekdays: 18:00-09:00 }", /ends before it starts/],
      ["hours: { always: true, weekdays: 09:00-18:00 }", /cannot both be set/],
      ["hours: { outside: email }", /hours.outside is form/],
      ["routes: [{ pages: [/x], team: nobody }]", /routes\[0\].team: nobody is not one of the teams/],
      ["routes: [{ pages: [pricing], team: support }]", /routes\[0\].pages\[0\] is a path/],
      ["window: { colour: blue }", /window.colour is a colour/],
      ["window: { privacy: 'http://x.example/p' }", /window.privacy is the https/],
      ["files: { types: [text/html] }", /files.types\[0\] is one of/],
      ["files: { max_size: 1GB }", /files.max_size is a size/],
      ["chats: { ticket_after: 10s }", /chats.ticket_after is from 1m/],
      ["answers: [{ id: a, title: A, text: x, teams: [nobody] }]", /answers\[0\].teams\[0\]: nobody is not one of the teams/],
      ["helpdesk: { url: 'http://helpdesk.example.com' }", /helpdesk.url is an https/],
      ["crm: { url: 'https://crm.example.com', token: abc }", /crm.token is the name of an environment variable/],
      ["keep_chats: forever", /keep_chats is a duration/],
    ];
    for (const [text, error] of bad) expect(() => parseConfig(text), text).toThrow(error);
  });

  it("reads durations", () => {
    expect(parseDuration("10m", "x")).toBe(600_000);
    expect(parseDuration("2y", "x")).toBe(2 * 365 * 86_400_000);
    expect(() => parseDuration("5s", "x", 60_000, 3_600_000)).toThrow(/x is from 1m to 1h/);
  });

  it("warns about secrets that are not set and pages no rule matches", () => {
    const c = parseConfig(`${SETTINGS.replace('  - { pages: ["*"], team: sales }\n', "")}`);
    const w = configWarnings(c, {});
    expect(w).toContain("helpdesk: LC_HELPDESK_KEY is not set, so no chat or question can become a ticket.");
    expect(w).toContain("crm: LC_CRM_TOKEN is not set, so no lead can be opened.");
    expect(w.some((x) => x.startsWith('No route has pages: ["*"]'))).toBe(true);
  });

  it("keeps the last good file when the new one has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-config-"));
    const path = join(dir, "live-chat.yaml");
    writeFileSync(path, "window: { title: One }");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.window.title), []), { everyMs: 60_000 });
    expect(applied).toEqual(["One"]);
    writeFileSync(path, "window: { title: [ }");
    w.read();
    expect(w.state.error).toMatch(/Not valid YAML/);
    expect(applied).toEqual(["One"]);
    writeFileSync(path, "window: { title: Two }");
    w.read();
    expect(applied).toEqual(["One", "Two"]);
    expect(w.state.error).toBeNull();
    w.stop();
  });
});
