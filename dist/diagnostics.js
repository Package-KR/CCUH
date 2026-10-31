import { readEvents, analyzeEvents, groupCalls } from "./codex/store.js";
export const VERSION = "0.1.0";
export function buildStatus(events, entrypoint, platform = process.platform) {
    const analysis = analyzeEvents(events);
    const { summary } = analysis;
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
            hook_records: summary.events_by_source.hook
                ? "local_records_observed"
                : "no_records",
            mcp_event_records: summary.events_by_source.mcp ?? 0,
            computer_use_calls: analysis.candidate_event_count
                ? "candidate_names_observed"
                : "not_observed",
            paired_candidate_calls: summary.paired_computer_use_candidate_calls,
            observed_candidate_tool_names: analysis.candidate_tool_names,
            native_app_selection: "not_implemented",
            computer_use_binding: "not_verified",
            live_hook_test_required: true,
        },
        summary,
        limits: {
            event_window: "up to 10000 complete records from the last 5 MiB",
            candidate_detection: "tool-name heuristic, not proof of bundled Computer Use coverage",
            timing: "pre-to-post observation span, not app acquisition or end-to-end task time",
            origins: "hook or MCP records can also be submitted manually; the server does not attest the caller",
            persistence: "metadata-only local JSONL; no automatic deletion or rotation",
        },
    };
}
export async function status(options = {}, entrypoint = "cli") {
    return buildStatus(await readEvents(options), entrypoint);
}
export async function recentCalls(limit = 20, options = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid call limit");
    return {
        calls: groupCalls(await readEvents(options)).slice(0, limit),
        measurement: "observed_span_ms is not target acquisition time",
    };
}
