import { readEvents, summarizeEvents, groupCalls } from "./codex/store.ts";
import type { StoreOptions } from "./codex/store.ts";
import type { SanitizedEvent } from "./codex/event.ts";

export const VERSION = "0.1.0";

export function buildStatus(
  events: SanitizedEvent[],
  entrypoint: "mcp" | "cli",
  platform = process.platform,
) {
  const real = events.filter((e) => e.source !== "synthetic");
  const hookEvents = events.filter((e) => e.source === "hook");
  const candidates = real.filter((e) => e.computer_use_candidate);
  const paired = groupCalls(real).filter(
    (c) => c.computer_use_candidate && c.status === "paired",
  );
  const toolNames = [...new Set(candidates.map((e) => e.tool_name))].sort();
  return {
    name: "CCUH",
    version: VERSION,
    stage: "M1_observation_only",
    platform: {
      required: "darwin",
      current: platform,
      supported: platform === "darwin",
    },
    evidence: {
      mcp_connection: entrypoint === "mcp" ? "responding" : "not_tested_by_cli",
      hook_records: hookEvents.length ? "local_records_observed" : "no_records",
      mcp_event_records: events.filter((e) => e.source === "mcp").length,
      computer_use_calls: candidates.length
        ? "candidate_names_observed"
        : "not_observed",
      paired_candidate_calls: paired.length,
      observed_candidate_tool_names: toolNames,
      native_app_selection: "not_implemented",
      computer_use_binding: "not_verified",
      live_hook_test_required: true,
    },
    summary: summarizeEvents(events),
    limits: {
      event_window: "up to 10000 complete records from the last 5 MiB",
      candidate_detection:
        "tool-name heuristic, not proof of bundled Computer Use coverage",
      timing:
        "pre-to-post observation span, not app acquisition or end-to-end task time",
      origins:
        "hook or MCP records can also be submitted manually; the server does not attest the caller",
      persistence:
        "metadata-only local JSONL; no automatic deletion or rotation",
    },
  };
}

export async function status(
  options: StoreOptions = {},
  entrypoint: "mcp" | "cli" = "cli",
) {
  return buildStatus(await readEvents(options), entrypoint);
}

export async function recentCalls(limit = 20, options: StoreOptions = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid call limit");
  return {
    calls: groupCalls(await readEvents(options)).slice(0, limit),
    measurement: "observed_span_ms is not target acquisition time",
  };
}
