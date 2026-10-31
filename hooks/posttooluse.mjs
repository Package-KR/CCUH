try {
  const { configurePluginState } =
    await import("../scripts/plugin-state.mjs");
  configurePluginState();
  await import("../dist/hooks/posttooluse.js");
} catch {
  process.stderr.write("CCUH: plugin observation could not be recorded\n");
}
