// Prometheus text exposition, written by hand: a few lines, no client library needed.
import { counters } from "./livechat.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  open: number;
  waiting: number;
  ticketsPending: number;
  questionsPending: number;
  streams: number;
  agents: number;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="live-chat",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_live_chat_chats Open chats, and those whose visitor waits for an answer.",
    "# TYPE openasy_live_chat_chats gauge",
    `openasy_live_chat_chats{state="open"} ${g.open}`,
    `openasy_live_chat_chats{state="waiting"} ${g.waiting}`,
    "# HELP openasy_live_chat_events_total Chats started, questions sent outside hours, and tickets and leads opened.",
    "# TYPE openasy_live_chat_events_total counter",
    ...[...counters.chats].map(([what, n]) => `openasy_live_chat_events_total{what="${what}"} ${n}`),
    "# HELP openasy_live_chat_link_calls_total Calls to Helpdesk, Analytics, CRM and Knowledge Base, by result.",
    "# TYPE openasy_live_chat_link_calls_total counter",
    ...[...counters.links].map(([k, n]) => {
      const [link, result] = k.split(":");
      return `openasy_live_chat_link_calls_total{link="${link}",result="${result}"} ${n}`;
    }),
    "# HELP openasy_live_chat_tickets_pending Chats and questions waiting to become Helpdesk tickets.",
    "# TYPE openasy_live_chat_tickets_pending gauge",
    `openasy_live_chat_tickets_pending{from="chat"} ${g.ticketsPending}`,
    `openasy_live_chat_tickets_pending{from="question"} ${g.questionsPending}`,
    "# HELP openasy_live_chat_streams Open event streams, of the team and of visitors.",
    "# TYPE openasy_live_chat_streams gauge",
    `openasy_live_chat_streams ${g.streams}`,
    "# HELP openasy_live_chat_agents_available Members answering now: signed in and not away.",
    "# TYPE openasy_live_chat_agents_available gauge",
    `openasy_live_chat_agents_available ${g.agents}`,
    "# HELP openasy_live_chat_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_live_chat_config_error gauge",
    `openasy_live_chat_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
