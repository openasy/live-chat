// What the pages share: data loading with the session, the team's live stream, and how times and visitors read.
import { useAuth } from "@openasy/auth/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Chat, type StreamEvent } from "./api.ts";
import type { T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes, and again every `everyMs`; `reload` loads it now. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null, everyMs?: number) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () =>
      void call<R>(path).then(
        (d) => live && setData(d),
        () => live && setData((old) => (old === undefined ? null : old)),
      );
    load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [call, path, n, everyMs]);
  return [data, () => setN((x) => x + 1)] as const;
}

/** The clock, ticking, so waiting times move on screen. */
export function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// ---------------------------------------------------------------- the live stream of every chat

interface Live {
  /** Open chats, and those closed while this screen was open. */
  chats: Chat[];
  /** false until the first list arrived. */
  ready: boolean;
  /** Whether the stream is connected now. */
  connected: boolean;
  /** Called with every event, for the chat on screen. Returns a function that stops it. */
  listen: (fn: (e: StreamEvent) => void) => () => void;
  /** Puts a chat the screen changed into the list at once, before its event comes back. */
  put: (c: Chat) => void;
}

const LiveContext = createContext<Live>({ chats: [], ready: false, connected: false, listen: () => () => {}, put: () => {} });
export const useLive = () => useContext(LiveContext);

/**
 * Loads the open chats, then follows the stream from the list's sequence number. The browser's EventSource reconnects
 * on its own with Last-Event-ID, so nothing is missed or repeated; when the server says the screen is too far behind
 * (`reset`), the list is loaded again and the stream opened after it.
 */
export function LiveProvider({ call, children }: { call: Call; children: ReactNode }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: StreamEvent) => void>());
  const seen = useRef(0);

  const put = useCallback((c: Chat) => {
    setChats((list) => {
      const i = list.findIndex((x) => x.number === c.number);
      if (i < 0) return c.status === "open" ? [...list, c] : list;
      if (Date.parse(list[i]!.lastAt) > Date.parse(c.lastAt)) return list;
      const next = [...list];
      next[i] = c;
      return next;
    });
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      try {
        const r = await call<{ chats: Chat[]; seq: number }>("/api/v1/chats?status=open&limit=500");
        if (stopped) return;
        setChats((list) => [...r.chats, ...list.filter((c) => c.status === "closed" && !r.chats.some((x) => x.number === c.number))]);
        seen.current = r.seq;
        setReady(true);
      } catch {
        if (!stopped) retry = setTimeout(() => void open(), 5000);
        return;
      }
      es = new EventSource(`/api/v1/stream?after=${seen.current}`);
      es.onopen = () => setConnected(true);
      const on = (msg: MessageEvent<string>) => {
        const e = JSON.parse(msg.data) as StreamEvent;
        if (e.seq <= seen.current) return;
        seen.current = e.seq;
        if (e.type === "chat") put(e.summary);
        for (const fn of listeners.current) fn(e);
      };
      es.addEventListener("line", on);
      es.addEventListener("chat", on);
      es.addEventListener("reset", () => {
        es?.close();
        void open();
      });
      es.onerror = () => {
        setConnected(false);
        // A closed stream (signed out, or the server refused it) is not tried again by the browser: check the session,
        // then open it again.
        if (es?.readyState === EventSource.CLOSED) {
          retry = setTimeout(() => {
            void call("/api/v1/me").then(
              () => void open(),
              () => {},
            );
          }, 3000);
        }
      };
    };
    void open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [call, put]);

  const listen = useCallback((fn: (e: StreamEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  return <LiveContext.Provider value={{ chats, ready, connected, listen, put }}>{children}</LiveContext.Provider>;
}

// ---------------------------------------------------------------- small parts

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="lc-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- formatting

export const fmt = (n: number) => n.toLocaleString();

/** A length of time as people say it: 48 s, 3 min, 2 h 12 min. */
export function duration(ms: number, t: T): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("time.seconds", { s });
  const total = Math.round(s / 60);
  const days = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (days) return t("time.days", { count: days });
  if (h) return m ? t("time.hoursMinutes", { h, m }) : t("time.hours", { h });
  return t("time.minutes", { m });
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Today's time, or yesterday's, or the date. */
export function when(iso: string, t: T, now = Date.now()) {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return t("time.today", { time: time(iso) });
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return t("time.yesterday", { time: time(iso) });
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time(iso)}`;
}

/** How long ago, in words and in the page's language: 3 days ago. */
export function ago(iso: string, locale?: string, now = Date.now()) {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

/** The visitor as the team calls them: their name, or the chat's number. */
export const visitorName = (c: Pick<Chat, "number" | "visitor">, t: T) => c.visitor.name ?? t("chat.visitor", { number: c.number });

/** A random id for a line, so the server adds it once however often it is sent. */
export function clientId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => (x % 36).toString(36)).join("") + Date.now().toString(36);
}
