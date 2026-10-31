import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSanitizedEvent, normalizeEvent } from "./event.ts";
import type { EventSource, Phase, SanitizedEvent } from "./event.ts";

export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
export const MAX_READ_BYTES = 5 * 1024 * 1024;
export const MAX_READ_EVENTS = 10_000;
const DEFAULT_STATE = fileURLToPath(new URL("../../.ccuh/", import.meta.url));
export interface StoreOptions {
  stateDir?: string;
}
export interface ReadOptions extends StoreOptions {
  limit?: number;
}

export function stateDirectory(options: StoreOptions = {}): string {
  const directory =
    options.stateDir ?? process.env.CCUH_STATE_DIR ?? DEFAULT_STATE;
  if (!isAbsolute(directory))
    throw new Error("CCUH_STATE_DIR must be absolute");
  return directory;
}

export async function appendEvent(
  event: SanitizedEvent,
  options: StoreOptions = {},
): Promise<void> {
  if (!isSanitizedEvent(event)) throw new Error("Invalid sanitized event");
  const directory = stateDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(
    join(directory, "events.jsonl"),
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
  } finally {
    await handle.close();
  }
}

/** Bounded tail read; incomplete/corrupt records are ignored, never repaired or deleted. */
export async function readEvents(
  options: ReadOptions = {},
): Promise<SanitizedEvent[]> {
  const limit = options.limit ?? MAX_READ_EVENTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_EVENTS)
    throw new Error("Invalid event limit");
  let handle;
  try {
    handle = await open(
      join(stateDirectory(options), "events.jsonl"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 10) text = text.slice(text.indexOf("\n") + 1);
    }
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return [];
    const result: SanitizedEvent[] = [];
    for (const line of text.slice(0, lastNewline).split("\n")) {
      if (!line || line.length > 8192) continue;
      try {
        const event = JSON.parse(line);
        if (isSanitizedEvent(event)) result.push(event);
      } catch {
        /* A partial concurrent append must not break diagnosis. */
      }
    }
    return result.slice(-limit);
  } finally {
    await handle.close();
  }
}

export type CallStatus =
  | "paired"
  | "pre_only"
  | "post_only"
  | "duplicate_events"
  | "identity_mismatch"
  | "clock_inconsistent";
export interface CallObservation {
  session_hash: string;
  tool_use_hash: string;
  source: EventSource;
  tool_name: string;
  computer_use_candidate: boolean;
  pre_count: number;
  post_count: number;
  status: CallStatus;
  observed_span_ms: number | null;
  reported_tool_error: boolean | null;
  latest_time_ms: number;
  target_info: SanitizedEvent["target_info"];
}

export function groupCalls(events: SanitizedEvent[]): CallObservation[] {
  const groups = new Map<string, SanitizedEvent[]>();
  for (const event of events) {
    if (!isSanitizedEvent(event)) continue;
    const key = `${event.source}:${event.session_hash}:${event.tool_use_hash}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const pre = group.filter((event) => event.phase === "pre");
      const post = group.filter((event) => event.phase === "post");
      const first = group[0];
      const names = new Set(group.map((event) => event.tool_name));
      const turns = new Set(
        group.map((event) => event.turn_hash).filter(Boolean),
      );
      let status: CallStatus =
        pre.length === 0
          ? "post_only"
          : post.length === 0
            ? "pre_only"
            : "paired";
      if (pre.length > 1 || post.length > 1) status = "duplicate_events";
      if (names.size > 1 || turns.size > 1) status = "identity_mismatch";
      let span: number | null = null;
      if (status === "paired") {
        span = post[0].time_ms - pre[0].time_ms;
        if (span < 0) {
          status = "clock_inconsistent";
          span = null;
        }
      }
      const newest = [...group].sort((a, b) => b.time_ms - a.time_ms)[0];
      // PostToolUse may omit tool_input. Keep the original call's input evidence
      // rather than interpreting that omission as missing target information.
      const targetEvidence =
        [...pre]
          .sort((a, b) => b.time_ms - a.time_ms)
          .find((event) => event.target_info !== "none") ??
        [...post]
          .sort((a, b) => b.time_ms - a.time_ms)
          .find((event) => event.target_info !== "none") ??
        newest;
      return {
        session_hash: first.session_hash,
        tool_use_hash: first.tool_use_hash,
        source: first.source,
        tool_name: first.tool_name,
        computer_use_candidate: group.some(
          (event) => event.computer_use_candidate,
        ),
        pre_count: pre.length,
        post_count: post.length,
        status,
        observed_span_ms: span,
        reported_tool_error: post.some(
          (event) => event.reported_tool_error === true,
        )
          ? true
          : post.length === 1
            ? post[0].reported_tool_error
            : null,
        latest_time_ms: newest.time_ms,
        target_info: targetEvidence.target_info,
      };
    })
    .sort((a, b) => b.latest_time_ms - a.latest_time_ms);
}

export function summarizeEvents(events: SanitizedEvent[]) {
  const valid = events.filter(isSanitizedEvent);
  const calls = groupCalls(valid);
  const countBy = (values: string[]) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((value) => [
          value,
          values.filter((item) => item === value).length,
        ]),
    );
  const realCandidates = calls.filter(
    (call) => call.source !== "synthetic" && call.computer_use_candidate,
  );
  return {
    event_count: valid.length,
    call_count: calls.length,
    events_by_phase: countBy(valid.map((event) => event.phase)),
    events_by_source: countBy(valid.map((event) => event.source)),
    calls_by_status: countBy(calls.map((call) => call.status)),
    tool_names: [...new Set(valid.map((event) => event.tool_name))].sort(),
    computer_use_candidate_calls: realCandidates.length,
    paired_computer_use_candidate_calls: realCandidates.filter(
      (call) => call.status === "paired",
    ).length,
    hook_computer_use_candidate_calls: realCandidates.filter(
      (call) => call.source === "hook",
    ).length,
    paired_hook_computer_use_candidate_calls: realCandidates.filter(
      (call) => call.source === "hook" && call.status === "paired",
    ).length,
    candidate_target_info: countBy(
      realCandidates.map((call) => call.target_info),
    ),
    reported_tool_errors: calls.filter(
      (call) => call.reported_tool_error === true,
    ).length,
    task_success: "not_measured",
    mac_target_selection: "not_implemented",
    computer_use_binding: "not_verified",
    measurement:
      "observed_span_ms includes hook/process/storage overhead; it is not app acquisition time",
  };
}

/** Hooks are observational and fail open. No stdout, no raw payload in diagnostics. */
export async function runObservationHook(phase: Phase): Promise<void> {
  try {
    const buffers: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_HOOK_INPUT_BYTES) {
        process.stderr.write("CCUH: hook input exceeds observation limit\n");
        process.stdin.destroy();
        return;
      }
      buffers.push(buffer);
    }
    const raw = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    const source = process.env.CCUH_TEST_MODE === "1" ? "synthetic" : "hook";
    const event = normalizeEvent(raw, { phase, source });
    if (!event) return;
    await appendEvent(event);
  } catch {
    process.stderr.write("CCUH: observation could not be recorded\n");
  }
}
