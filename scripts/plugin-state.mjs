import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export class PluginRuntimeError extends Error {}

/** MCP and hook processes use the same location, independent of their CWD. */
export function pluginStateDirectory(env = process.env, home = homedir()) {
  if (env.CCUH_STATE_DIR !== undefined) {
    if (!isAbsolute(env.CCUH_STATE_DIR))
      throw new PluginRuntimeError("CCUH_STATE_DIR must be an absolute path.");
    return env.CCUH_STATE_DIR;
  }
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  if (!isAbsolute(codexHome))
    throw new PluginRuntimeError("CODEX_HOME must be an absolute path.");
  return join(codexHome, "ccuh", "state");
}

export function configurePluginState(env = process.env, home = homedir()) {
  const directory = pluginStateDirectory(env, home);
  env.CCUH_STATE_DIR = directory;
  return directory;
}
