try {
  const { configurePluginState } =
    await import("../scripts/plugin-runtime.mjs");
  configurePluginState();
  await import("../dist/hooks/pretooluse.js");
} catch {
  process.stderr.write("CCUH: plugin observation could not be recorded\n");
}
