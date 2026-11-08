# live-chat

[![CI](https://github.com/openasy/live-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/live-chat/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Live Chat product: a chat window on your site from one script tag, on
phones too, answered by your team in the browser, several chats at once, with saved answers, files and handing a
chat to a colleague. Beside each chat are the visitor's pages from Analytics. Outside working hours the window offers
a form, and those questions, and chats no one answered or that were left open, become Helpdesk tickets. A chat can
open a lead in CRM, and Knowledge Base articles are suggested to the visitor. No chatbots, no WhatsApp or social
messages.

```
<script src=".../w/www.js"> ─▶ the window (shadow DOM) ─▶ /api/v1/widget/* ──▶ routes (live-chat.yaml) ─▶ a team
                                    ▲ Server-Sent Events                         │
                                    └──────────── the team answers in the browser ◀┘ ─▶ Helpdesk tickets, CRM leads
```

## On your site

```html
<script src="https://chat.example.com/w/www.js" defer></script>
```

One tag on every page; `www` is the site's id in the file. The script carries the site's settings (colour, title,
greeting, hours behaviour, whether it asks for an email, files) and is cached for five minutes. Sites with a
Content-Security-Policy allow Live Chat's address in `script-src`, `connect-src` and `img-src`.

- **Isolated.** The window is drawn in a closed shadow root with `:host { all: initial }` and its own styles: the
  page's styles do not reach in, and its own do not leak out. Only one global, `OALC`, is defined.
- **Safe.** Everything said is set with `textContent`; only `http(s)` addresses become links (`rel="noopener
  noreferrer nofollow"`). Nothing a visitor or agent writes is parsed as HTML.
- **Small.** About 9 KiB gzipped, with no dependencies; the build fails past 14 KiB (`scripts/widget-size.ts`).
- **Accessible.** A labelled launcher with `aria-expanded`, the window a labelled dialog, the conversation a
  `role="log"` live region, labelled fields, Escape to close and focus moved into the window and back. Text on the
  colour is black or white, whichever has the higher contrast. Motion follows `prefers-reduced-motion`, colours
  follow `prefers-color-scheme`, and on screens under 480 px the open window fills the screen.
- **Languages.** The window's words are in English, German and Turkish, by the page's `lang` and then the browser;
  `window.greeting` can be given per language.

### What is kept, and consent

Nothing is stored about a visitor until they start a chat: before that, the window only asks whether it is open now
(`GET /api/v1/widget/state`) and, as they type, Knowledge Base for articles (`/suggest`, not kept). When they send the
first line, the chat's token and the last event seen are kept in the site's `localStorage`
(`openasy.chat.<site>`), so the chat follows them from page to page; the server keeps only the token's hash. The
page's path (no query string), the referring site's host and, when Analytics' script is on the page,
`openasy.ids()` are sent with the first line.

On sites that ask first, set `consent: { purpose: <id> }`: the window does not appear until
[Consent](https://github.com/openasy/consent) says the visitor accepted that purpose. It reads
`OpenAsyConsent.get(purpose)` (waiting up to ten seconds for Consent's script to load), follows
`OpenAsyConsent.on()` and the `openasy:consent` event, and when the answer becomes no it removes itself and what it
kept.

## Real time, and resuming

Every line and every change to a chat is an **event with a sequence number**, written to the database before anyone
is told. Both sides follow chats with Server-Sent Events whose `id:` is that number:

- The team's screens use `EventSource` on `/api/v1/stream?after=<n>`, opened after the `seq` that
  `GET /api/v1/chats` returned with the list. On a dropped connection the browser reconnects with `Last-Event-ID` and
  gets the events it missed, once; screens drop any event at or below the last number they applied.
- The window reads `/api/v1/widget/stream?after=<n>` with `fetch`, so the chat's token goes in a header, reconnects
  with backoff and jitter (1 s doubling to 30 s), at once when the page becomes visible or the network returns, and
  resumes from the number it kept. It is sent only the lines the visitor sees.
- The server replays from its log and registers the listener in the same turn, so no event falls between the two.
  The log is kept two days; a client further behind, or more than 1000 events behind, gets `event: reset` and loads
  the chat again.
- **Sending** is idempotent: each line carries a `client_id`, and the same id twice answers 200 with the line added
  before. The window keeps an outbox and sends one line at a time, in order, retrying the same id after network
  errors and 5xx; a line refused for good is shown as not sent, to tap and retry.
- A heartbeat comment every 25 s keeps proxies from closing idle streams; on shutdown the streams end and clients
  resume against the next instance.

## Chats

A new chat goes to the team of the first route whose `pages` match the page it started on (`*` matches any part of a
path; with no match, the first team). The thread says which rule did it. The list shows open chats, the oldest
unanswered first, with the page each visitor is on now and how long they have waited.

- **Answering.** The first member to answer takes the chat, and the visitor is told who joined. Several members can
  write in the same chat. Saved answers (`answers`, per team) fill the reply box with `{name}`, `{first_name}` and
  `{agent}` filled in.
- **Handing over.** To a colleague, to another team, or both, with an optional note for the team only. Everything said
  stays in the chat; the visitor sees only who answers now.
- **Files.** Both sides can send the types in `files.types` (PNG, JPEG, GIF, WebP, PDF, plain text; default PNG, JPEG
  and PDF) up to `files.max_size`. A file is taken only when its first bytes are that type, so a page renamed to
  `.png` is refused; plain text with markup is refused too. Files are served with `nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`; only images are shown inline, anything else is downloaded.
  The visitor's window gets each file at a signed link that only its chat knows.
- **Available or away.** A member who answers chats counts as available while their Live Chat screen is open and the
  switch above the chats is on. The window says "We usually answer within a minute" when someone is available.
- **Closing.** An agent or the visitor closes a chat; a chat with no new line for `chats.close_after` (default 30 min)
  closes on its own.

## Helpdesk: after hours, unanswered and left open

Live Chat posts to Helpdesk's public ticket API with the key of Helpdesk's `sources.live-chat`
([helpdesk/openapi.json](https://github.com/openasy/helpdesk)):

```
POST <helpdesk.url>/api/v1/public/tickets          Authorization: Bearer <the key helpdesk.key names>
{ "external_id": "live-chat-<chat id>", "email", "name", "subject", "language", "form": "<the team's queue>",
  "transcript": [{ "from": "customer" | "agent", "name", "at", "text" }] }

POST <helpdesk.url>/api/v1/public/tickets/<number>/messages   { "from", "name", "text" }
```

- **Outside working hours** the window shows a form (email, name, question) instead of a chat, unless
  `hours.outside: hidden`. Each question becomes a ticket (`external_id: live-chat-question-<id>`, with the page),
  answered by email. They are listed under After hours.
- **No one answered** within `chats.ticket_after` (default 10 min): the chat becomes a ticket with everything said.
  If the visitor left no email, the window asks for one first; the ticket is made once it is given, or when the chat
  closes.
- **Left open:** a chat that closes (by the visitor or for idleness) on a question no one answered becomes a ticket.
- **By hand:** Make a ticket, beside the chat.

The visitor is told the ticket's number. Lines said after it go to the ticket too, in order, one at a time. The team's
`queue` is sent as `form`, so a Helpdesk rule `match: { source: live-chat, form: sales }` picks its queue. Because
`external_id` is the chat's random id, a retry never opens two tickets. When Helpdesk cannot be reached, the chat says
why and it is tried again after 1, 5 and 15 minutes, 1 and 3 hours, then every 6 hours.

## Analytics: the visitor's pages

When the window finds Analytics' script on the page, it sends `openasy.ids()` (`{ visitor, session }`) with the first
line. With `analytics` in the file and an Analytics API token with the viewer role, the chat shows the visit from
`GET <analytics.url>/api/v1/visits/<session>?site=<sites.<id>.analytics>` (or the visitor's latest visit from
`/api/v1/visits?visitor=`): where they came from (source, referrer, `utm_*`), browser, system and device, and the
pages they read with the time on each. Without it, the chat shows the pages the window saw while the chat was open.
Answers are kept 30 seconds.

## CRM: opening a lead

CRM is built after Live Chat and implements this call. With `crm` in the file, Open a lead in CRM sends:

```
POST <crm.url>/api/v1/leads
Authorization: Bearer <the token crm.token names>

{ "external_id": "live-chat-<chat id>", "source": "live-chat",
  "name": "Seda Polat", "email": "seda@polat.example",
  "page": "https://www.example.com/pricing", "title": "Can the invoices be in Turkish?",
  "owner": { "name": "Emily Clark", "email": "emily@example.com" },
  "referrer": "https://www.google.com/", "utm": { "source": null, "medium": null, "campaign": null },
  "pages": [{ "at": "2026-11-02T11:53:00Z", "path": "/features/e-fatura" }, { "at": "…", "path": "/pricing" }],
  "transcript": [{ "from": "visitor", "name": "Seda Polat", "at": "…", "text": "…" }, { "from": "agent", … }],
  "chat_url": "https://chat.example.com/chats/12" }

201 { "lead": { "id": "l-1", "url": "https://crm.example.com/leads/l-1" } }   a new lead
200 { "lead": { … } }                                                          the same external_id again
4xx/5xx Problem Details                                                         shown to the agent
```

`name` and `email` may be null; `pages` come from Analytics when linked, else from the window; the agent who opened
it is the owner unless CRM decides otherwise. Live Chat keeps `lead.id` and `lead.url` and links to it. Fields beyond
these are ignored. Without `crm` in the file the button is not shown. In the code, CRM is behind the `LeadBook`
interface (`server/links.ts`); the schemas are `CrmLeadRequest` and `CrmLeadCreated` in `openapi.json`, and the
contract test checks what Live Chat sends against them.

## Knowledge Base

With `knowledge_base.url` and `window.suggest_articles` (default true), the window asks Live Chat for articles as the
visitor types the first line, and Live Chat asks Knowledge Base's `GET /api/v1/suggest?place=live-chat` from the
server (nothing about the visitor is sent). Articles for the first question are kept on the chat: shown to the visitor
in the window and to the team beside the chat.

## Reports

The Overview is today, in the hours' time zone: chats against the same day last week, the median time to the first
answer with its last 14 days, chats not answered within `chats.slow_answer`, chats that became tickets (and questions
after hours) and leads, chats per hour against the same day last week, the pages they started on, and the team now.
Reports cover 7, 30 or 90 days: chats by weekday and hour, by page (grouped by the first two parts of the path), per
day with tickets and leads, the first answer, tickets by why, and each team's chats, first answer, tickets and leads.

## Rate limits

Calls a minute from one address to the window's API (by `X-Forwarded-For`'s last entry with
`LIVE_CHAT_TRUST_PROXY=true`, behind your TLS proxy): 6 new chats, 5 questions, 60 state and 60 suggest calls, and
per chat 40 lines, 10 files, 10 detail changes and 60 page changes; 30 stream connections, with at most 6 open streams
per chat and 50 per address. One email may ask 5 questions an hour. Calls come only from pages of the sites' hosts
(CORS); other origins get 403. Counters are in memory and never stored.

## The settings file

`/config/live-chat.yaml` (`LIVE_CHAT_CONFIG`), as in [config/live-chat.yaml](./config/live-chat.yaml). No screen and
no API route changes it. It is read at start and within a minute of a change, and applied whole or not at all: a file
with a mistake leaves the last good version in place, and the log and the Settings page say which field to fix.
Secrets are never in it; it names the environment variables that hold them. Without a file, Live Chat starts with one
team, no sites and every hour open.

| Field | Default | |
| --- | --- | --- |
| `sites.<id>` | | `{ host, ask_email, consent, analytics, title }`: hosts (or `localhost:5173`), ask for an email first (`true`), the Consent purpose to wait for, the site's name in Analytics (the id) |
| `hours` | always | `timezone`, `holidays`, and days with times: `weekdays: 09:00-18:00`, `sat: 10:00-14:00`, or a list for split days |
| `hours.outside` | `form` | `form` (questions become tickets) or `hidden` |
| `teams.<id>` | `support` | `{ name, group, members, queue }`: Identity groups, members by email (neither: everyone), Helpdesk queue |
| `routes` | | `[{ pages, team }]`; the first that matches wins |
| `window` | | `colour`, `title`, `greeting` (text or per language), `position` (`right`), `suggest_articles` (`true`), `privacy` |
| `chats` | `10m`, `30m`, `2m` | `ticket_after`, `close_after`, `slow_answer` |
| `files` | PNG, JPEG, PDF; `10MB` | `types`, `max_size` (up to `25MB`); `types: false` turns files off |
| `answers` | | `[{ id, title, text, teams }]` |
| `keep_chats` | `2y` | Closed chats, their lines and files are deleted after this |
| `helpdesk` | | `{ url, key }` |
| `analytics` | | `{ url, token }` |
| `crm` | | `{ url, token }` |
| `knowledge_base` | | `{ url, language }` |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/live-chat.yaml
docker compose up -d
docker compose logs live-chat | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `LIVE_CHAT_PUBLIC_URL` | `http://localhost:8080` | The address people and the window open, with `https://` behind your TLS proxy |
| `LIVE_CHAT_CONFIG` | `/config/live-chat.yaml` | The settings file |
| `LIVE_CHAT_TRUST_PROXY` | `false` | `true` behind a TLS proxy: rate limits use `X-Forwarded-For` |
| the variables the file names | | The Helpdesk key, the Analytics and CRM tokens |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `LIVE_CHAT_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `LIVE_CHAT_DB` | `/data/live-chat.db` | SQLite file (WAL), on the `/data` volume: chats, lines, files and the event log |
| `LIVE_CHAT_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `LIVE_CHAT_HEADLESS` | `false` | `true` serves no team UI; the API and the window stay |
| `LIVE_CHAT_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include open and waiting chats, chats started, questions, tickets and leads, calls to the other products by result,
tickets waiting for Helpdesk, open streams and members available. Files' signed links are not written to the request
log.

## Roles

Viewers see chats and reports; editors answer, hand over, close, make tickets and open leads; admins also manage
members and API tokens (ADR 0003). The groups Identity sends at sign-in decide which teams a member answers for. The
window's API takes pages of the sites' hosts, and a chat's token once it starts.

## Develop

```bash
npm install
npm test        # settings, hours, routing, chats and hand-over, files, streams resuming without loss or repeats,
                # Helpdesk tickets, Analytics, CRM leads, the window in jsdom, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
npm run build   # the window (and its size budget), the UI and the API reference
```

The team UI follows the Live Chat screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings
page is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
