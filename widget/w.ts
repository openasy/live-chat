// The chat window a site's pages load from /w/<site>.js. It is built into one small file with no dependencies, and the
// server wraps it with the site's settings: `OALC.start({ site, endpoint, title, colour, ... })`.
//
// - Isolated from the page: everything is drawn in a closed shadow root with its own styles, and the page's styles do
//   not reach in. Every text from the team or the visitor is set with textContent; links are made only for http(s)
//   addresses, so nothing said in a chat can run on the page.
// - Nothing is stored about the visitor until they start a chat: then the chat's token and the last event seen are kept
//   in the site's localStorage, so the chat follows them from page to page. On sites that ask first, the window does
//   not appear until Consent says the visitor accepted the site's purpose for it (OpenAsyConsent, openasy:consent).
// - Real time: an event stream (Server-Sent Events read with fetch, so the token goes in a header) that resumes from the
//   last event it saw after a dropped connection, and lines sent with their own id, so a retry adds them once.

export interface Settings {
  site: string;
  endpoint: string;
  title: string;
  colour: string;
  position: "right" | "left";
  greeting: Partial<Record<Lang, string>> | null;
  privacy: string | null;
  askEmail: boolean;
  /** The Consent purpose to wait for, or null. */
  consent: string | null;
  outside: "form" | "hidden";
  suggest: boolean;
  files: { types: string[]; maxSize: number };
}

type Lang = "en" | "de" | "tr";

export const WORDS = {
  en: {
    open: "Chat with us",
    close: "Close the chat window",
    end: "End chat",
    soon: "We usually answer within a minute",
    busy: "We answer as soon as someone is free",
    back: "We are back at {time}",
    backDay: "We are back {day} at {time}",
    hello: "Hello! Ask us anything.",
    name: "Your name (optional)",
    email: "Your email",
    message: "Write a message",
    question: "Your question",
    send: "Send",
    attach: "Attach a file",
    privacy: "Nothing is kept about you until you write.",
    privacyLink: "Privacy",
    maybe: "These may answer it",
    outsideText: "Leave your question and email; we answer by email.",
    thanks: "Thank you. We have your question and answer by email.",
    joined: "{name} joined the chat",
    closedVisitor: "You ended the chat",
    closedAgent: "{name} ended the chat",
    closedIdle: "The chat was closed after a while without messages",
    ticketEmail: "Your question is now ticket #{n}. We answer by email.",
    ticket: "Your question is now ticket #{n}.",
    askEmail: "No one is free right now. Leave your email and we answer there.",
    saveEmail: "Save",
    emailSaved: "Thank you. We answer at {email}.",
    newChat: "Start a new chat",
    notSent: "Not sent. Tap to try again.",
    sending: "Sending",
    tooBig: "The file is larger than {mb} MB.",
    wrongType: "This kind of file cannot be sent.",
    failed: "Something went wrong. Try again in a moment.",
    you: "You",
    unread: "{n} new messages",
  },
  de: {
    open: "Chatten Sie mit uns",
    close: "Chatfenster schließen",
    end: "Chat beenden",
    soon: "Wir antworten meist innerhalb einer Minute",
    busy: "Wir antworten, sobald jemand frei ist",
    back: "Wir sind um {time} zurück",
    backDay: "Wir sind {day} um {time} zurück",
    hello: "Hallo! Fragen Sie uns.",
    name: "Ihr Name (optional)",
    email: "Ihre E-Mail",
    message: "Nachricht schreiben",
    question: "Ihre Frage",
    send: "Senden",
    attach: "Datei anhängen",
    privacy: "Bevor Sie schreiben, wird nichts über Sie gespeichert.",
    privacyLink: "Datenschutz",
    maybe: "Das könnte helfen",
    outsideText: "Hinterlassen Sie Ihre Frage und E-Mail; wir antworten per E-Mail.",
    thanks: "Danke. Wir haben Ihre Frage und antworten per E-Mail.",
    joined: "{name} ist dem Chat beigetreten",
    closedVisitor: "Sie haben den Chat beendet",
    closedAgent: "{name} hat den Chat beendet",
    closedIdle: "Der Chat wurde nach einer Weile ohne Nachrichten geschlossen",
    ticketEmail: "Ihre Frage ist jetzt Ticket #{n}. Wir antworten per E-Mail.",
    ticket: "Ihre Frage ist jetzt Ticket #{n}.",
    askEmail: "Gerade ist niemand frei. Hinterlassen Sie Ihre E-Mail, wir antworten dort.",
    saveEmail: "Speichern",
    emailSaved: "Danke. Wir antworten an {email}.",
    newChat: "Neuen Chat beginnen",
    notSent: "Nicht gesendet. Tippen, um es erneut zu versuchen.",
    sending: "Wird gesendet",
    tooBig: "Die Datei ist größer als {mb} MB.",
    wrongType: "Diese Art von Datei kann nicht gesendet werden.",
    failed: "Etwas ist schiefgegangen. Versuchen Sie es gleich noch einmal.",
    you: "Sie",
    unread: "{n} neue Nachrichten",
  },
  tr: {
    open: "Bize yazın",
    close: "Sohbet penceresini kapat",
    end: "Sohbeti bitir",
    soon: "Genellikle bir dakika içinde yanıtlıyoruz",
    busy: "Biri müsait olunca yanıtlıyoruz",
    back: "Saat {time} itibarıyla buradayız",
    backDay: "{day} saat {time} itibarıyla buradayız",
    hello: "Merhaba! Bize her şeyi sorabilirsiniz.",
    name: "Adınız (isteğe bağlı)",
    email: "E-posta adresiniz",
    message: "Bir mesaj yazın",
    question: "Sorunuz",
    send: "Gönder",
    attach: "Dosya ekle",
    privacy: "Siz yazana kadar hakkınızda hiçbir şey saklanmaz.",
    privacyLink: "Gizlilik",
    maybe: "Bunlar sorunuzu yanıtlayabilir",
    outsideText: "Sorunuzu ve e-posta adresinizi bırakın; e-postayla yanıtlıyoruz.",
    thanks: "Teşekkürler. Sorunuzu aldık, e-postayla yanıtlayacağız.",
    joined: "{name} sohbete katıldı",
    closedVisitor: "Sohbeti bitirdiniz",
    closedAgent: "{name} sohbeti bitirdi",
    closedIdle: "Sohbet bir süre mesaj gelmeyince kapandı",
    ticketEmail: "Sorunuz artık #{n} numaralı talep. E-postayla yanıtlayacağız.",
    ticket: "Sorunuz artık #{n} numaralı talep.",
    askEmail: "Şu an müsait kimse yok. E-posta adresinizi bırakın, oradan yanıtlayalım.",
    saveEmail: "Kaydet",
    emailSaved: "Teşekkürler. {email} adresine yanıt vereceğiz.",
    newChat: "Yeni sohbet başlat",
    notSent: "Gönderilemedi. Yeniden denemek için dokunun.",
    sending: "Gönderiliyor",
    tooBig: "Dosya {mb} MB'tan büyük.",
    wrongType: "Bu türde bir dosya gönderilemez.",
    failed: "Bir sorun oldu. Biraz sonra yeniden deneyin.",
    you: "Siz",
    unread: "{n} yeni mesaj",
  },
} satisfies Record<Lang, Record<string, string>>;
type Word = keyof (typeof WORDS)["en"];

export interface Line {
  id: string;
  seq: number;
  kind: "visitor" | "agent" | "system";
  name: string | null;
  text: string;
  at: string;
  file: { name: string; type: string; size: number; url: string } | null;
  event: string | null;
  data: Record<string, unknown> | null;
  clientId: string | null;
  /** Only on this page: a line still being sent, or one that could not be. */
  state?: "sending" | "failed";
}

interface ChatState {
  status: "open" | "closed";
  agent: string | null;
  ticket: number | null;
  email: boolean;
}

interface Stored {
  /** The chat's token. */
  t: string;
  /** The last event seen. */
  s: number;
}

interface Hours {
  open: boolean;
  outside: "form" | "hidden";
  opensAt: string | null;
  available: number;
}

/** A random id for a line, so the server adds it once however often it is sent. */
export function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => (x % 36).toString(36)).join("") + Date.now().toString(36);
}

export function pickLanguage(wanted: Array<string | null | undefined>): Lang {
  for (const w of wanted) {
    const l = (w ?? "").slice(0, 2).toLowerCase();
    if (l === "en" || l === "de" || l === "tr") return l;
  }
  return "en";
}

/** Black or white, whichever reads better on the colour (WCAG relative luminance). */
export function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#111" : "#fff";
}

/** Reads an event stream: calls `on` with each event's name and data, and returns the last id it saw. */
export function parseEvents(buffer: string, on: (event: string, data: string, id: string | null) => void): string {
  let rest = buffer;
  let at: number;
  while ((at = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);
    let event = "message";
    let data = "";
    let id: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data += (data ? "\n" : "") + value;
      else if (field === "id") id = value;
    }
    if (data || event !== "message") on(event, data, id);
  }
  return rest;
}

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.w{position:fixed;bottom:20px;z-index:2147483000;color:#1f2328;font-size:14px;line-height:1.45}
.w.r{right:20px}.w.l{left:20px}
.b{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:var(--t);box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;position:relative}
.b svg{width:26px;height:26px}
.n{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#d1242f;color:#fff;font-size:12px;line-height:20px;padding:0 5px;text-align:center}
.p{position:absolute;bottom:68px;width:360px;max-width:calc(100vw - 40px);height:min(560px,calc(100vh - 110px));background:#fff;border:1px solid #d1d9e0;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden}
.r .p{right:0}.l .p{left:0}
.h{background:var(--c);color:var(--t);padding:12px 14px;display:flex;align-items:flex-start;gap:8px}
.h div{flex:1;min-width:0}.h strong{display:block;font-size:15px}.h span{font-size:12px;opacity:.9}
.x{background:none;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;font-size:13px}
.x svg{width:18px;height:18px;display:block}
.m{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;margin:0;list-style:none}
.m li{max-width:85%;display:flex;flex-direction:column;gap:2px}
.m .v{align-self:flex-end;align-items:flex-end}
.m .s{align-self:center;max-width:100%;text-align:center;font-size:12px;color:#59636e}
.m small{font-size:11px;color:#59636e}
.u{padding:8px 11px;border-radius:12px;background:#f0f2f4;white-space:pre-wrap;overflow-wrap:anywhere}
.v .u{background:var(--c);color:var(--t)}
.v .u a{color:inherit}
.f .u{opacity:.6}
.u img{max-width:100%;max-height:200px;border-radius:8px;display:block}
.k{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-top:1px solid #d1d9e0}
.k input,.k textarea{width:100%;font-size:14px;padding:8px 10px;border:1px solid #d1d9e0;border-radius:8px;background:#fff;color:#1f2328;resize:none}
.k textarea{min-height:60px}
.row{display:flex;gap:6px;align-items:center}
.row span{flex:1}
.go{background:var(--c);color:var(--t);border:0;border-radius:8px;padding:7px 14px;font-size:14px;cursor:pointer}
.go:disabled{opacity:.5;cursor:default}
.ic{background:none;border:0;cursor:pointer;padding:6px;border-radius:6px;color:#59636e}
.ic svg{width:18px;height:18px;display:block}
.a{font-size:12px;color:#59636e;display:flex;flex-direction:column;gap:3px}
.a strong{font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.a a,.note a,.u a{color:#0969da}
.note{font-size:11px;color:#59636e;padding:0 12px 8px}
.err{color:#d1242f;font-size:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:3px solid #0969da;outline-offset:2px}
[hidden]{display:none!important}
@media (max-width:480px){.w.open{inset:0}.w.open .p{position:fixed;inset:0;width:100%;max-width:none;height:100%;border-radius:0;border:0}.w.open .b{display:none}}
@media (prefers-color-scheme:dark){.p{background:#151b23;border-color:#3d444d;color:#e6edf3}.u{background:#262c36}.k input,.k textarea{background:#0d1117;color:#e6edf3;border-color:#3d444d}.k{border-color:#3d444d}.m .s,.m small,.a,.note,.ic{color:#9198a1}.a a,.note a,.u a{color:#4493f8}}
@media (prefers-reduced-motion:no-preference){.p{animation:in .15s ease-out}@keyframes in{from{opacity:0;transform:translateY(8px)}}}
`;

const ICON = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.4l7.9-7.9"/></svg>',
};

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
/** An element, with text children set as text: nothing here parses HTML but the fixed icons above. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}
const icon = (svg: string) => {
  const t = document.createElement("template");
  t.innerHTML = svg;
  return t.content.firstChild!;
};

/** The text, with http(s) addresses as links that open elsewhere; everything else stays text. */
export function linkify(text: string): Array<Node | string> {
  const out: Array<Node | string> = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    out.push(text.slice(last, m.index));
    const u = safeUrl(m[0]);
    out.push(
      u && (u.protocol === "https:" || u.protocol === "http:") ? el("a", { href: u.href, target: "_blank", rel: "noopener noreferrer nofollow" }, m[0]) : m[0],
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((x) => x !== "");
}

/** URL.parse, for browsers that do not have it yet. */
function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function start(cfg: Settings): { destroy: () => void } {
  const key = `openasy.chat.${cfg.site}`;
  const lang = pickLanguage([document.documentElement.lang, ...(navigator.languages ?? [navigator.language])]);
  const W = WORDS[lang];
  const t = (k: Word, v: Record<string, string | number> = {}) => W[k].replace(/\{(\w+)\}/g, (_, n: string) => String(v[n] ?? ""));
  const api = (path: string) => `${cfg.endpoint}/api/v1/widget${path}`;

  let host: HTMLElement | null = null;
  let mounted = false;
  let destroyed = false;
  let teardown: Array<() => void> = [];

  function read(): Stored | null {
    try {
      const v = JSON.parse(storage()?.getItem(key) ?? "null") as Stored | null;
      return v && typeof v.t === "string" ? v : null;
    } catch {
      return null;
    }
  }
  function write(v: Stored | null) {
    try {
      if (v) storage()?.setItem(key, JSON.stringify(v));
      else storage()?.removeItem(key);
    } catch {
      // Storage is blocked: the chat lasts as long as this page.
    }
  }

  function mount() {
    if (mounted || destroyed) return;
    mounted = true;
    host = el("div", { "data-openasy-chat": "" });
    const root = host.attachShadow({ mode: "closed" });
    const style = el("style", {}, CSS);
    const wrap = el("div", { class: `w ${cfg.position === "left" ? "l" : "r"}` });
    wrap.style.setProperty("--c", cfg.colour);
    wrap.style.setProperty("--t", textOn(cfg.colour));
    root.append(style, wrap);
    document.body.append(host);

    // ------------------------------------------------------------ state
    let stored = read();
    let token = stored?.t ?? null;
    let seq = stored?.s ?? 0;
    let lines: Line[] = [];
    let chat: ChatState | null = null;
    let hours: Hours | null = null;
    let isOpen = false;
    let unread = 0;
    let view: "start" | "chat" | "outside" | "thanks" = "start";
    let streamAbort: AbortController | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const outbox: Line[] = [];
    let sendingNow = false;

    const save = () => token && write({ t: token, s: seq });
    const headers = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
    async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
      const res = await fetch(api(path), {
        method,
        credentials: "omit",
        headers: { ...headers(), ...(body !== undefined && !(body instanceof Blob) ? { "content-type": "application/json" } : {}), ...extra },
        body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
        throw Object.assign(new Error(p.detail ?? String(res.status)), { status: res.status, code: p.code });
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    }

    // ------------------------------------------------------------ the launcher and the panel
    const badge = el("span", { class: "n", hidden: true, "aria-hidden": "true" });
    const launcher = el(
      "button",
      { class: "b", type: "button", "aria-label": t("open"), "aria-expanded": "false", onclick: () => toggle() },
      icon(ICON.chat),
      badge,
    );
    const status = el("span", {}, "");
    const endBtn = el("button", { class: "x", type: "button", hidden: true, onclick: () => void end() }, t("end"));
    const closeBtn = el("button", { class: "x", type: "button", "aria-label": t("close"), onclick: () => toggle(false) }, icon(ICON.x));
    const head = el("div", { class: "h" }, el("div", {}, el("strong", { id: "lc-title" }, cfg.title), status), endBtn, closeBtn);
    const body = el("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" });
    const panel = el("div", { class: "p", role: "dialog", "aria-labelledby": "lc-title", hidden: true }, head, body);
    wrap.append(panel, launcher);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        toggle(false);
        launcher.focus();
      }
    };
    panel.addEventListener("keydown", onKey);

    function toggle(to = !isOpen) {
      isOpen = to;
      panel.hidden = !to;
      wrap.classList.toggle("open", to);
      launcher.setAttribute("aria-expanded", String(to));
      if (to) {
        unread = 0;
        drawBadge();
        void refreshHours();
        draw();
        setTimeout(() => (panel.querySelector("textarea, input:not([type=hidden]):not([tabindex='-1'])") as HTMLElement | null)?.focus(), 0);
      }
    }
    function drawBadge() {
      badge.hidden = unread === 0;
      badge.textContent = String(unread);
      launcher.setAttribute("aria-label", unread ? `${t("open")}, ${t("unread", { n: unread })}` : t("open"));
    }

    async function refreshHours() {
      try {
        hours = await call<Hours>("GET", "/state");
      } catch {
        hours = hours ?? { open: true, outside: cfg.outside, opensAt: null, available: 1 };
      }
      if (!token && view !== "thanks") view = hours.open ? "start" : cfg.outside === "form" ? "outside" : "start";
      drawStatus();
      if (isOpen && !token) draw();
    }
    function drawStatus() {
      if (!hours) return void (status.textContent = "");
      if (hours.open) return void (status.textContent = hours.available ? t("soon") : t("busy"));
      if (!hours.opensAt) return void (status.textContent = "");
      const d = new Date(hours.opensAt);
      const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
      const sameDay = d.toDateString() === new Date().toDateString();
      status.textContent = sameDay ? t("back", { time }) : t("backDay", { time, day: d.toLocaleDateString(lang, { weekday: "long" }) });
    }

    // ------------------------------------------------------------ drawing
    const log = el("ol", { class: "m", role: "log", "aria-live": "polite", "aria-label": cfg.title });
    function lineEl(l: Line): HTMLLIElement | null {
      if (l.kind === "system") {
        const d = l.data ?? {};
        const name = String(d.name ?? "");
        let text = "";
        if (l.event === "joined") text = t("joined", { name });
        else if (l.event === "closed")
          text = d.by === "visitor" ? t("closedVisitor") : d.by === "idle" ? t("closedIdle") : t("closedAgent", { name: name || cfg.title });
        else if (l.event === "ticket") text = d.email || chat?.email ? t("ticketEmail", { n: Number(d.number) }) : t("ticket", { n: Number(d.number) });
        else if (l.event === "ask-email") return chat?.email ? null : el("li", { class: "s" }, t("askEmail"), emailForm());
        else if (l.event === "articles") return el("li", { class: "s" }, articles((d.articles as Array<{ title: string; url: string }>) ?? []));
        else return null;
        return el("li", { class: "s" }, text);
      }
      const mine = l.kind === "visitor";
      const content: Array<Node | string> = l.file
        ? [
            el(
              "a",
              { href: `${cfg.endpoint}${l.file.url}`, target: "_blank", rel: "noopener noreferrer" },
              l.file.type.startsWith("image/") ? el("img", { src: `${cfg.endpoint}${l.file.url}`, alt: l.file.name, loading: "lazy" }) : l.file.name,
            ),
          ]
        : linkify(l.text);
      const meta =
        l.state === "failed"
          ? t("notSent")
          : l.state === "sending"
            ? t("sending")
            : `${mine ? t("you") : (l.name ?? cfg.title)} · ${new Date(l.at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}`;
      const li = el("li", { class: `${mine ? "v" : "g"}${l.state ? " f" : ""}` }, el("small", {}, meta), el("div", { class: "u" }, ...content));
      if (l.state === "failed") {
        li.setAttribute("role", "button");
        li.tabIndex = 0;
        const again = () => {
          l.state = "sending";
          if (!outbox.includes(l)) outbox.push(l);
          void flush();
          drawLines();
        };
        li.addEventListener("click", again);
        li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && again());
      }
      return li;
    }
    function articles(list: Array<{ title: string; url: string }>) {
      return el(
        "div",
        { class: "a" },
        el("strong", {}, t("maybe")),
        ...list.map((a) => {
          const u = safeUrl(a.url);
          return u && u.protocol === "https:" ? el("a", { href: u.href, target: "_blank", rel: "noopener noreferrer" }, a.title) : null;
        }),
      );
    }
    function emailForm() {
      const input = el("input", { type: "email", required: true, autocomplete: "email", "aria-label": t("email"), placeholder: t("email") });
      const form = el(
        "form",
        {
          class: "row",
          style: "margin-top:6px",
          onsubmit: (e: Event) => {
            e.preventDefault();
            void call<ChatState>("PATCH", "/chat", { email: input.value.trim() }).then(
              (s) => ((chat = s), form.replaceWith(t("emailSaved", { email: input.value.trim() }))),
              () => input.setAttribute("aria-invalid", "true"),
            );
          },
        },
        input,
        el("button", { class: "go", type: "submit" }, t("saveEmail")),
      );
      return form;
    }
    function drawLines() {
      log.replaceChildren(
        ...[...lines, ...outbox.filter((o) => !lines.some((l) => l.clientId === o.clientId))].map(lineEl).filter((x): x is HTMLLIElement => !!x),
      );
      log.scrollTop = log.scrollHeight;
    }

    function draw() {
      endBtn.hidden = !(token && chat?.status === "open");
      if (token) return drawChat();
      if (view === "outside") return drawOutside();
      if (view === "thanks") return body.replaceChildren(el("p", { class: "m", role: "status" }, t("thanks")));
      return drawStart();
    }

    function note() {
      return el(
        "p",
        { class: "note" },
        t("privacy"),
        ...(cfg.privacy ? [" ", el("a", { href: cfg.privacy, target: "_blank", rel: "noopener noreferrer" }, t("privacyLink"))] : []),
      );
    }

    function drawStart() {
      const greeting = cfg.greeting?.[lang] ?? cfg.greeting?.en ?? t("hello");
      const hint = el("div", { class: "a", hidden: true, "aria-live": "polite" });
      const intro = el("ol", { class: "m" }, el("li", { class: "g" }, el("div", { class: "u" }, greeting)), el("li", { class: "s" }, hint));
      const name = el("input", { type: "text", autocomplete: "name", maxlength: "100", placeholder: t("name"), "aria-label": t("name") });
      const email = cfg.askEmail
        ? el("input", { type: "email", required: true, autocomplete: "email", placeholder: t("email"), "aria-label": t("email") })
        : null;
      const text = el("textarea", { required: true, maxlength: "5000", placeholder: t("message"), "aria-label": t("message") });
      const err = el("p", { class: "err", role: "alert", hidden: true });
      const button = el("button", { class: "go", type: "submit" }, t("send"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let asking: AbortController | undefined;
      if (cfg.suggest)
        text.addEventListener("input", () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            asking?.abort();
            const q = text.value.trim();
            if (q.length < 3) return void (hint.hidden = true);
            asking = new AbortController();
            try {
              const res = await fetch(api(`/suggest?${new URLSearchParams({ q, lang })}`), { credentials: "omit", signal: asking.signal });
              const r = (await res.json()) as { articles: Array<{ title: string; url: string }> };
              hint.replaceChildren(...(r.articles.length ? [articles(r.articles)] : []));
              hint.hidden = !r.articles.length;
            } catch {
              // Offline, or a newer question took over.
            }
          }, 350);
        });
      const form = el(
        "form",
        {
          class: "k",
          onsubmit: (e: Event) => {
            e.preventDefault();
            if (!text.value.trim()) return;
            button.disabled = true;
            err.hidden = true;
            const ids = (window as unknown as { openasy?: { ids?: () => { visitor: string; session: string } | null } }).openasy?.ids?.() ?? null;
            const coarse = window.matchMedia?.("(pointer: coarse)").matches;
            call<{ token: string; chat: { state: ChatState; lines: Line[] }; seq: number }>("POST", "/chats", {
              message: text.value.trim(),
              client_id: randomId(),
              ...(name.value.trim() ? { name: name.value.trim() } : {}),
              ...(email ? { email: email.value.trim() } : {}),
              page: location.href,
              title: document.title.slice(0, 200) || undefined,
              referrer: document.referrer || undefined,
              language: lang,
              device: coarse ? (innerWidth < 768 ? "phone" : "tablet") : "desktop",
              ...(ids ? { analytics: ids } : {}),
            }).then(
              (r) => {
                token = r.token;
                seq = r.seq;
                chat = r.chat.state;
                lines = r.chat.lines;
                save();
                draw();
                connect();
                watchPages();
              },
              (e: Error & { code?: string }) => {
                button.disabled = false;
                if (e.code === "closed") {
                  view = cfg.outside === "form" ? "outside" : "start";
                  void refreshHours();
                  return;
                }
                err.textContent = e.message && !/^\d+$/.test(e.message) ? e.message : t("failed");
                err.hidden = false;
              },
            );
          },
        },
        name,
        ...(email ? [email] : []),
        text,
        err,
        el("div", { class: "row" }, el("span"), button),
      );
      body.replaceChildren(intro, form, note());
    }

    function drawOutside() {
      const email = el("input", { type: "email", required: true, autocomplete: "email", placeholder: t("email"), "aria-label": t("email") });
      const name = el("input", { type: "text", autocomplete: "name", maxlength: "100", placeholder: t("name"), "aria-label": t("name") });
      const q = el("textarea", { required: true, maxlength: "5000", placeholder: t("question"), "aria-label": t("question") });
      // Only bots fill it.
      const trap = el("input", {
        type: "text",
        name: "website",
        tabindex: "-1",
        autocomplete: "off",
        "aria-hidden": "true",
        style: "position:absolute;left:-9999px",
      });
      const err = el("p", { class: "err", role: "alert", hidden: true });
      const button = el("button", { class: "go", type: "submit" }, t("send"));
      const form = el(
        "form",
        {
          class: "k",
          onsubmit: (e: Event) => {
            e.preventDefault();
            button.disabled = true;
            call("POST", "/questions", {
              email: email.value.trim(),
              question: q.value.trim(),
              ...(name.value.trim() ? { name: name.value.trim() } : {}),
              page: location.href,
              language: lang,
              website: trap.value,
            }).then(
              () => ((view = "thanks"), draw()),
              (e: Error) => {
                button.disabled = false;
                err.textContent = e.message && !/^\d+$/.test(e.message) ? e.message : t("failed");
                err.hidden = false;
              },
            );
          },
        },
        el("p", { style: "margin:0" }, t("outsideText")),
        email,
        name,
        q,
        trap,
        err,
        el("div", { class: "row" }, el("span"), button),
      );
      body.replaceChildren(el("div", { style: "flex:1" }), form, note());
    }

    function drawChat() {
      drawLines();
      if (chat?.status === "closed") {
        const again = el(
          "button",
          {
            class: "go",
            type: "button",
            onclick: () => {
              forget();
              draw();
            },
          },
          t("newChat"),
        );
        return body.replaceChildren(log, el("div", { class: "k" }, again));
      }
      const text = el("textarea", { maxlength: "5000", placeholder: t("message"), "aria-label": t("message"), rows: "2" });
      const err = el("p", { class: "err", role: "alert", hidden: true });
      const submit = () => {
        const v = text.value.trim();
        if (!v) return;
        text.value = "";
        queue({ text: v });
      };
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) (e.preventDefault(), submit());
      });
      const fileInput = el("input", { type: "file", hidden: true, accept: cfg.files.types.join(","), "aria-hidden": "true", tabindex: "-1" });
      fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        fileInput.value = "";
        if (!f) return;
        err.hidden = true;
        if (!cfg.files.types.includes(f.type)) return void ((err.textContent = t("wrongType")), (err.hidden = false));
        if (f.size > cfg.files.maxSize) return void ((err.textContent = t("tooBig", { mb: Math.round(cfg.files.maxSize / 1048576) })), (err.hidden = false));
        queue({ file: f });
      });
      const attach = cfg.files.types.length
        ? el("button", { class: "ic", type: "button", "aria-label": t("attach"), title: t("attach"), onclick: () => fileInput.click() }, icon(ICON.clip))
        : null;
      const form = el(
        "form",
        { class: "k", onsubmit: (e: Event) => (e.preventDefault(), submit()) },
        text,
        err,
        el("div", { class: "row" }, attach, fileInput, el("span"), el("button", { class: "go", type: "submit" }, t("send"))),
      );
      body.replaceChildren(log, form);
    }

    // ------------------------------------------------------------ sending: one at a time, in order, each with its id
    function queue(what: { text?: string; file?: File }) {
      const l: Line & { blob?: File } = {
        id: `local-${randomId()}`,
        seq: Number.MAX_SAFE_INTEGER,
        kind: "visitor",
        name: null,
        text: what.text ?? what.file!.name,
        at: new Date().toISOString(),
        file: null,
        event: null,
        data: null,
        clientId: randomId(),
        state: "sending",
        blob: what.file,
      };
      outbox.push(l);
      drawLines();
      void flush();
    }
    async function flush() {
      if (sendingNow) return;
      sendingNow = true;
      try {
        while (outbox.length) {
          const l = outbox[0] as Line & { blob?: File };
          try {
            const got = l.blob
              ? await call<Line>("POST", "/files", l.blob, {
                  "content-type": l.blob.type,
                  "x-file-name": encodeURIComponent(l.blob.name),
                  "x-client-id": l.clientId!,
                })
              : await call<Line>("POST", "/messages", { text: l.text, client_id: l.clientId });
            outbox.shift();
            take(got);
          } catch (e) {
            const status = (e as { status?: number }).status;
            // The connection dropped: the same line, with the same id, goes again later.
            if (status === undefined || status >= 500 || status === 429) {
              setTimeout(() => void flush(), 3000);
              return;
            }
            outbox.shift();
            l.state = "failed";
            lines.push(l);
            if (status === 409) chat = { ...(chat ?? { agent: null, ticket: null, email: false }), status: "closed" };
            draw();
          }
        }
      } finally {
        sendingNow = false;
      }
    }

    /** A line from the server: replaces the copy being sent, and is added once however often it arrives. */
    function take(l: Line) {
      if (lines.some((x) => x.id === l.id)) return;
      lines = lines.filter((x) => !(x.state && x.clientId && x.clientId === l.clientId));
      lines.push(l);
      lines.sort((a, b) => a.seq - b.seq);
      if (!isOpen && l.kind !== "visitor" && (l.kind === "agent" || l.event === "joined")) {
        unread++;
        drawBadge();
      }
      drawLines();
    }

    // ------------------------------------------------------------ the stream
    function connect() {
      if (!token || destroyed) return;
      streamAbort?.abort();
      const ctrl = new AbortController();
      streamAbort = ctrl;
      clearTimeout(retryTimer);
      void (async () => {
        try {
          const res = await fetch(api(`/stream?after=${seq}`), { headers: headers(), credentials: "omit", signal: ctrl.signal });
          if (res.status === 401) return void (forget(), draw());
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf = parseEvents(buf + value.replace(/\r\n?/g, "\n"), (event, data) => {
              if (event === "reset") return void reload();
              if (data === "" || (event !== "line" && event !== "chat")) return;
              retry = 0;
              const e = JSON.parse(data) as { seq: number; type: "line" | "chat"; line?: Line; state?: ChatState };
              if (e.seq <= seq) return;
              seq = e.seq;
              save();
              if (e.type === "line" && e.line) take(e.line);
              else if (e.state) {
                const was = chat?.status;
                chat = e.state;
                if (was !== chat.status) draw();
                else endBtn.hidden = chat.status !== "open";
              }
            });
            if (buf.includes(": ready")) retry = 0;
          }
          throw new Error("ended");
        } catch {
          if (ctrl.signal.aborted || destroyed) return;
          // Back off, with some jitter, and resume from the last event seen.
          const wait = Math.min(30_000, 1000 * 2 ** retry++) * (0.75 + Math.random() / 2);
          retryTimer = setTimeout(connect, wait);
        }
      })();
    }

    async function reload() {
      try {
        const r = await call<{ state: ChatState; lines: Line[]; seq: number }>("GET", "/chat");
        chat = r.state;
        lines = r.lines;
        seq = r.seq;
        save();
        draw();
        connect();
      } catch (e) {
        if ((e as { status?: number }).status === 401) (forget(), draw());
      }
    }

    function forget() {
      streamAbort?.abort();
      clearTimeout(retryTimer);
      token = null;
      stored = null;
      seq = 0;
      lines = [];
      chat = null;
      outbox.length = 0;
      write(null);
      view = hours && !hours.open && cfg.outside === "form" ? "outside" : "start";
    }

    async function end() {
      try {
        chat = await call<ChatState>("POST", "/close");
      } catch {
        // The stream says so when it gets through.
      }
      draw();
    }

    // The page the visitor is on, while the chat is open; single-page sites move without loading.
    let lastPage = "";
    let pageTimer: ReturnType<typeof setInterval> | undefined;
    function watchPages() {
      const tell = () => {
        if (!token || chat?.status !== "open" || location.href === lastPage) return;
        lastPage = location.href;
        void call("POST", "/pages", { page: location.href, title: document.title.slice(0, 200) || undefined }).catch(() => {});
      };
      lastPage = location.href;
      clearInterval(pageTimer);
      pageTimer = setInterval(tell, 2000);
    }

    const wake = () => {
      if (token && document.visibilityState === "visible") {
        retry = 0;
        connect();
        void flush();
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    teardown.push(() => {
      streamAbort?.abort();
      clearTimeout(retryTimer);
      clearInterval(pageTimer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      host?.remove();
      host = null;
      mounted = false;
    });

    // A chat from an earlier page goes on here.
    if (token) {
      void reload().then(() => {
        if (!token) return;
        if (chat?.status === "open") {
          lastPage = "";
          void call("POST", "/pages", { page: location.href, title: document.title.slice(0, 200) || undefined }).catch(() => {});
          watchPages();
        }
      });
    }
    void refreshHours().then(() => {
      // Outside hours with no form, and no chat going on: nothing to show.
      if (hours && !hours.open && cfg.outside === "hidden" && !token) wrap.hidden = true;
    });
  }

  function destroy() {
    for (const f of teardown) f();
    teardown = [];
  }

  // ------------------------------------------------------------ consent: on sites that ask first, wait for a yes
  type ConsentApi = { get: (p: string) => boolean | null; on: (fn: (a: Record<string, boolean | null>) => void) => () => void };
  const stops: Array<() => void> = [];
  const apply = (granted: boolean | null | undefined) => {
    if (granted === true) mount();
    else if (granted === false && mounted) {
      // Withdrawn: the window goes, and so does what it kept.
      destroy();
      write(null);
    }
  };
  const ready = () => {
    if (destroyed) return;
    if (!cfg.consent) return mount();
    const purpose = cfg.consent;
    const onEvent = (e: Event) => apply((e as CustomEvent<Record<string, boolean | null>>).detail?.[purpose]);
    window.addEventListener("openasy:consent", onEvent);
    stops.push(() => window.removeEventListener("openasy:consent", onEvent));
    // Consent's script may load after this one: look for it for ten seconds, then follow its answers.
    let tries = 0;
    const look = () => {
      const c = (window as unknown as { OpenAsyConsent?: ConsentApi }).OpenAsyConsent;
      if (c) {
        apply(c.get(purpose));
        stops.push(c.on((a) => apply(a[purpose])));
      } else if (++tries < 50) {
        const timer = setTimeout(look, 200);
        stops.push(() => clearTimeout(timer));
      }
    };
    look();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  return {
    destroy: () => {
      destroyed = true;
      for (const f of stops) f();
      destroy();
    },
  };
}
