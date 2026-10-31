// 같은 CUA 세션에서 읽은 창 헤더를 대조하며 원본 AX와 입력 내용은 보관하지 않음.
// 콜백은 승인된 동작 하나, verifyAfter는 관측 문자열을 검사하는 함수로 제한.
var ccuhWindowGuard = (() => {
  const active = new WeakSet();
  const matches = (observed, appName, windowTitle) =>
    observed.appName.normalize("NFC") === appName &&
    observed.windowTitle.normalize("NFC") === windowTitle;

  async function observe(app) {
    let snapshot;
    try {
      snapshot = await app.getAXState({ disableDiffing: true, emit: false });
    } catch {
      return { failure: "observation_failed", observed: null };
    }
    const header =
      typeof snapshot === "string"
        ? /^Window: "([^"\r\n]+)", App: ([^\r\n]+)\.\r?(?:\n|$)/.exec(snapshot)
        : null;
    return header
      ? { snapshot, observed: { windowTitle: header[1], appName: header[2] } }
      : { failure: "unrecognized_window_header", observed: null };
  }

  async function runOne(app, expected, action, verifyAfter) {
    const result = {
      status: "blocked",
      reason: null,
      actionAttempted: false,
      actionReturned: false,
      targetVerified: false,
      actionVerified: false,
      effect: "none",
      before: null,
      after: null,
    };
    if (
      !app ||
      typeof app.getAXState !== "function" ||
      !expected ||
      typeof expected.appName !== "string" ||
      !expected.appName.trim() ||
      typeof expected.windowTitle !== "string" ||
      !expected.windowTitle.trim() ||
      typeof action !== "function" ||
      (verifyAfter !== undefined && typeof verifyAfter !== "function")
    ) {
      return { ...result, reason: "invalid_arguments" };
    }
    const appName = expected.appName.normalize("NFC");
    const windowTitle = expected.windowTitle.normalize("NFC");
    if (active.has(app)) return { ...result, reason: "guard_busy" };
    active.add(app);
    try {
      const before = await observe(app);
      result.before = before.observed;
      if (before.failure) return { ...result, reason: before.failure };
      if (!matches(before.observed, appName, windowTitle))
        return { ...result, reason: "target_mismatch" };

      result.actionAttempted = true;
      result.effect = "unknown";
      try {
        await action(before.snapshot);
        result.actionReturned = true;
      } catch {
        result.reason = "action_failed";
      }

      const after = await observe(app);
      result.after = after.observed;
      result.targetVerified =
        !after.failure && matches(after.observed, appName, windowTitle);
      if (result.reason) return { ...result, status: "stopped" };
      if (after.failure)
        return {
          ...result,
          status: "stopped",
          reason: "after_" + after.failure,
        };
      if (!result.targetVerified)
        return { ...result, status: "stopped", reason: "target_changed" };

      if (verifyAfter !== undefined) {
        try {
          result.actionVerified = (await verifyAfter(after.snapshot)) === true;
        } catch {
          return {
            ...result,
            status: "stopped",
            reason: "postcondition_failed",
          };
        }
        if (!result.actionVerified)
          return {
            ...result,
            status: "stopped",
            reason: "postcondition_mismatch",
          };
        result.status = "postcondition_matched";
        result.effect = "postcondition_observed";
      } else {
        // 창 헤더 일치만으로 동작 성공이나 CUA 내부 연결을 보장하지 않음.
        result.status = "target_matched";
      }
      return result;
    } finally {
      active.delete(app);
    }
  }

  async function acquireByCycling(app, expected, options = {}) {
    const started = Date.now();
    const result = {
      status: "blocked",
      reason: null,
      before: null,
      after: null,
      stepsAttempted: 0,
      stepsReturned: 0,
      observations: 0,
      elapsedMs: 0,
    };
    const finish = (status, reason) => ({
      ...result,
      status,
      reason,
      elapsedMs: Date.now() - started,
    });
    if (!options || typeof options !== "object" || Array.isArray(options))
      return finish("blocked", "invalid_arguments");
    const rawAppName = expected && expected.appName;
    const rawWindowTitle = expected && expected.windowTitle;
    const rawFromWindowTitle = options.fromWindowTitle;
    const maxSteps = options.maxSteps === undefined ? 7 : options.maxSteps;
    const maxElapsedMs =
      options.maxElapsedMs === undefined ? 20000 : options.maxElapsedMs;
    if (
      !app ||
      typeof app.getAXState !== "function" ||
      typeof app.pressKey !== "function" ||
      typeof rawAppName !== "string" ||
      !rawAppName.trim() ||
      typeof rawWindowTitle !== "string" ||
      !rawWindowTitle.trim() ||
      typeof rawFromWindowTitle !== "string" ||
      !rawFromWindowTitle.trim() ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 10 ||
      !Number.isFinite(maxElapsedMs) ||
      maxElapsedMs < 1 ||
      maxElapsedMs > 60000
    )
      return finish("blocked", "invalid_arguments");
    const appName = rawAppName.normalize("NFC");
    const windowTitle = rawWindowTitle.normalize("NFC");
    const fromWindowTitle = rawFromWindowTitle.normalize("NFC");
    if (active.has(app)) return finish("blocked", "guard_busy");
    active.add(app);
    try {
      result.observations++;
      const before = await observe(app);
      result.before = result.after = before.observed;
      if (before.failure) return finish("blocked", before.failure);
      if (before.observed.appName.normalize("NFC") !== appName)
        return finish("blocked", "app_mismatch");
      if (matches(before.observed, appName, windowTitle))
        return finish("target_observed", "target_header_matched");
      if (before.observed.windowTitle.normalize("NFC") !== fromWindowTitle)
        return finish("blocked", "from_window_mismatch");
      const seen = new Set([fromWindowTitle]);
      while (result.stepsAttempted < maxSteps) {
        // Soft budget: an in-flight CUA call cannot be cancelled; keep the lock.
        if (Date.now() - started >= maxElapsedMs)
          return finish(
            result.stepsAttempted ? "stopped" : "blocked",
            "time_budget_exhausted",
          );
        let keyFailed = false;
        result.stepsAttempted++;
        try {
          await app.pressKey("super+grave");
          result.stepsReturned++;
        } catch {
          keyFailed = true;
        }
        // Count read attempts, including failed reads, and observe even on key errors.
        result.observations++;
        const after = await observe(app);
        result.after = after.observed;
        if (keyFailed) return finish("stopped", "key_failed_effect_unknown");
        if (after.failure) return finish("stopped", "after_" + after.failure);
        if (after.observed.appName.normalize("NFC") !== appName)
          return finish("stopped", "app_changed");
        if (matches(after.observed, appName, windowTitle))
          return finish("target_observed", "target_header_matched");
        const title = after.observed.windowTitle.normalize("NFC");
        if (seen.has(title)) return finish("stopped", "repeated_title_or_cycle");
        seen.add(title);
      }
      return finish("stopped", "step_budget_exhausted");
    } finally {
      active.delete(app);
    }
  }

  return Object.freeze({ runOne, acquireByCycling });
})();
