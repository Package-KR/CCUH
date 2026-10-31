import { status, recentCalls } from "./diagnostics.ts";
import { commandHooks, mcpConfig } from "./codex/config.ts";
import { runSetup, SetupError } from "./codex/setup.ts";

const command = process.argv[2] ?? "status";
try {
  if (command === "setup") {
    if (!process.argv.slice(3).includes("--dry-run")) {
      process.stdout.write(
        "Installing CCUH and registering it with Codex...\n",
      );
    }
    const report = await runSetup(process.argv.slice(3));
    if (report.dry_run) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write("CCUH registered for Codex.\n");
      for (const [index, step] of report.next_steps.entries()) {
        process.stdout.write(`${index + 1}. ${step}\n`);
      }
    }
  } else if (command === "config") {
    const variant = process.argv[3];
    const output =
      variant === "mcp"
        ? mcpConfig()
        : variant === "hooks-discovery"
          ? JSON.stringify(commandHooks(), null, 2) + "\n"
          : variant === "hooks-targeted" && process.argv[4]
            ? JSON.stringify(commandHooks(process.argv[4]), null, 2) + "\n"
            : null;
    if (output === null) throw new Error("Invalid config variant");
    process.stdout.write(output);
  } else {
    const result =
      command === "status"
        ? await status()
        : command === "recent"
          ? await recentCalls(Number(process.argv[3] ?? 20))
          : null;
    if (result === null) throw new Error("Unknown command");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  if (command === "setup" && error instanceof SetupError) {
    process.stderr.write(`CCUH: ${error.message}\n`);
  } else {
    process.stderr.write(
      "CCUH: command failed. Use setup [--dry-run], status, recent [1..100], or config mcp|hooks-discovery|hooks-targeted TOOL_NAME.\n",
    );
  }
  process.exitCode = 1;
}
