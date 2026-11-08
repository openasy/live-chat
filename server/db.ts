import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A chat. Its number is what the team says: chat 12. Its id is what Helpdesk and CRM are sent, so a new database
   -- never meets an old ticket. The visitor holds a secret whose hash is kept here; nothing else identifies them.
   CREATE TABLE chats (
     number INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     token_hash TEXT NOT NULL,
     site TEXT NOT NULL,
     team TEXT NOT NULL,
     -- Why it went to its team, as people read it: the page rule /pricing, or null for the first team.
     routed_by TEXT,
     status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
     visitor_name TEXT,
     visitor_email TEXT,
     language TEXT,
     -- The page the chat started on, and the one the visitor is on now (path only, no query).
     page TEXT NOT NULL,
     page_title TEXT,
     page_now TEXT,
     -- The referring site, without its path.
     referrer TEXT,
     device TEXT CHECK (device IN ('desktop', 'phone', 'tablet')),
     -- The visit in Analytics, when its script is on the page: openasy.ids().
     analytics_visitor TEXT,
     analytics_session TEXT,
     agent_id TEXT,
     agent_name TEXT,
     created_at TEXT NOT NULL,
     first_answer_at TEXT,
     last_at TEXT NOT NULL,
     -- Since when the visitor's last line has had no answer; null when the team spoke last.
     waiting_since TEXT,
     closed_at TEXT,
     closed_by TEXT CHECK (closed_by IN ('agent', 'visitor', 'idle')),
     -- When the window asked for an email so the question could become a ticket.
     email_asked_at TEXT,
     -- The Helpdesk ticket it became: why, its number, and the last line sent to it.
     ticket_reason TEXT CHECK (ticket_reason IN ('unanswered', 'left-open', 'agent')),
     ticket_number INTEGER,
     ticket_error TEXT,
     ticket_attempts INTEGER NOT NULL DEFAULT 0,
     ticket_next_at TEXT,
     ticket_synced INTEGER NOT NULL DEFAULT 0,
     lead_id TEXT,
     lead_url TEXT,
     lead_at TEXT,
     lead_by TEXT,
     -- Knowledge Base articles suggested for the first question, as JSON.
     articles TEXT
   );
   CREATE INDEX chats_status ON chats (status, last_at);
   CREATE INDEX chats_created ON chats (created_at);
   CREATE INDEX chats_ticket ON chats (ticket_next_at) WHERE ticket_reason IS NOT NULL AND ticket_number IS NULL;
   -- Everything that happened, in order: the stream's log. seq is what clients resume from. A line of a chat is one
   -- event; so is a change to the chat. visitor = 1 when the visitor's window is sent it too.
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     chat INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('line', 'chat')),
     visitor INTEGER NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX events_chat ON events (chat, seq);
   -- What was said. client_id is the sender's own id for the line, so a retry after a dropped connection adds it once.
   CREATE TABLE lines (
     id TEXT PRIMARY KEY,
     chat INTEGER NOT NULL REFERENCES chats (number) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('visitor', 'agent', 'system')),
     author_id TEXT,
     author_name TEXT,
     text TEXT NOT NULL,
     file TEXT,
     client_id TEXT,
     at TEXT NOT NULL,
     -- System lines: a code the UIs word, with its values as JSON; visitor = 1 when the window shows it.
     event TEXT,
     data TEXT,
     visitor INTEGER NOT NULL DEFAULT 1,
     UNIQUE (chat, client_id)
   );
   CREATE INDEX lines_chat ON lines (chat, seq);
   CREATE TABLE files (
     id TEXT PRIMARY KEY,
     chat INTEGER NOT NULL REFERENCES chats (number) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BLOB NOT NULL,
     at TEXT NOT NULL
   );
   CREATE INDEX files_chat ON files (chat);
   -- The pages the visitor opened while the chat was open, from the window itself.
   CREATE TABLE pages (
     chat INTEGER NOT NULL REFERENCES chats (number) ON DELETE CASCADE,
     at TEXT NOT NULL,
     path TEXT NOT NULL,
     title TEXT
   );
   CREATE INDEX pages_chat ON pages (chat, at);
   -- Questions from the form outside working hours. Each becomes a Helpdesk ticket; until it does, it waits here.
   CREATE TABLE questions (
     id TEXT PRIMARY KEY,
     site TEXT NOT NULL,
     team TEXT NOT NULL,
     name TEXT,
     email TEXT NOT NULL,
     page TEXT,
     language TEXT,
     question TEXT NOT NULL,
     at TEXT NOT NULL,
     ticket_number INTEGER,
     ticket_error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT
   );
   CREATE INDEX questions_at ON questions (at);
   -- Agents' own state: away or not, and the Identity groups their last sign-in sent, for the teams.
   CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     away INTEGER NOT NULL DEFAULT 0,
     groups TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL
   );`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
