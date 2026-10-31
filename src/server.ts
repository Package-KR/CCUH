import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { pathToFileURL } from "node:url";
import { normalizeEvent } from "./codex/event.ts";
import { appendEvent } from "./codex/store.ts";
import type { StoreOptions } from "./codex/store.ts";
import { status, recentCalls, VERSION } from "./diagnostics.ts";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const observation = z.object({
  hook_event_name: z.enum(["PreToolUse", "PostToolUse"]),
  session_id: z.string().min(1).max(1024),
  tool_use_id: z.string().min(1).max(1024),
  tool_name: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  turn_id: z.string().max(1024).optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_response: z.unknown().optional(),
});
const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function createServer(options: StoreOptions = {}) {
  const server = new McpServer({ name: "ccuh", version: VERSION });
  server.registerTool(
    "ccuh_status",
    {
      description:
        "Report MCP reachability and local observation evidence. Does not select apps or prove Computer Use binding.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => reply(await status(options, "mcp")),
  );

  server.registerTool(
    "ccuh_recent_calls",
    {
      description:
        "Read bounded sanitized pre/post call observations, including incomplete or ambiguous pairs.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: readOnly,
    },
    async ({ limit }) => reply(await recentCalls(limit, options)),
  );

  server.registerTool(
    "ccuh_observe_event",
    {
      description:
        "Record metadata from a Codex PreToolUse or PostToolUse event. Raw code, arguments, message text and response content are discarded. Recording is not proof an automatic hook ran.",
      inputSchema: z.object({ event: observation }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ event: raw }) => {
      const event = normalizeEvent(raw, { source: "mcp" });
      if (!event)
        return {
          ...reply({ recorded: false, reason: "invalid_or_excluded_event" }),
          isError: true,
        };
      await appendEvent(event, options);
      return reply({
        recorded: true,
        phase: event.phase,
        computer_use_candidate: event.computer_use_candidate,
        target_info: event.target_info,
        native_app_selection: "not_implemented",
        computer_use_binding: "not_verified",
      });
    },
  );
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "CCUH supports macOS. This server does not start on this platform.\n",
    );
    process.exitCode = 1;
  } else {
    // stdout belongs exclusively to MCP. Do not log application messages here.
    serveStdio(() => createServer());
  }
}
