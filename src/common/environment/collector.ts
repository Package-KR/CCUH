import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { ensureEnvironmentCollector } from './build.ts';

type Bounds = { x: number; y: number; width: number; height: number };
type Application = { pid: number; bundleIdentifier: string | null };
type Display = {
  id: number;
  bounds: Bounds;
  isPrimary: boolean;
  isBuiltIn: boolean;
  backingScaleFactor: number | null;
};
type Window = {
  id: number;
  pid: number;
  bundleIdentifier: string | null;
  bounds: Bounds;
  displayIds: number[] | null;
  zOrder: number;
};
type CuaEnvironmentContext = {
  hookEventName: 'PreToolUse';
  toolName: 'mcp__cua_repl__js';
  sessionId: string;
  callId: string;
};

export type EnvironmentSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  coordinateSpace: 'quartz-global-screen-coordinates';
  screenCaptureAccess: 'granted' | 'not-granted';
  displays: { status: 'observed' | 'unavailable'; items: Display[] | null };
  windows: {
    status: 'observed' | 'partial' | 'unavailable';
    scope: 'on-screen-normal-layer';
    items: Window[] | null;
    truncated: boolean;
  };
  foregroundApplication: { status: 'observed' | 'unknown'; value: Application | null };
  unsupported: ['spaces', 'fullscreen', 'browser-window-tab-mapping'];
};
export type EnvironmentObservation =
  | { status: 'captured'; sourceHash: string; elapsedMs: number; snapshot: EnvironmentSnapshot }
  | {
      status: 'unavailable';
      elapsedMs: number;
      reason:
        | 'not-cua-context'
        | 'unsupported-platform'
        | 'compiler-unavailable'
        | 'prepare-timeout'
        | 'prepare-failed'
        | 'cache-unavailable'
        | 'capture-timeout'
        | 'capture-failed'
        | 'invalid-snapshot';
    };

// 제한된 프로세스 실행의 Promise 변환
const runFile = promisify(execFile);

// 자체 데이터 필드만 가진 관측 객체 판별
function hasFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'))
  );
}

// 양의 식별자 판별
function isIdentifier(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
}

// 앱 번들 식별자의 관측 값 판별
function isBundleIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 512);
}

// 유한한 전역 화면 사각형 판별
function isBounds(value: unknown): value is Bounds {
  return (
    hasFields(value, ['x', 'y', 'width', 'height']) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    Number.isFinite(value.x + value.width) &&
    Number.isFinite(value.y + value.height)
  );
}

// 앱 메타데이터 판별
function isApplication(value: unknown): value is Application {
  return (
    hasFields(value, ['pid', 'bundleIdentifier']) &&
    isIdentifier(value.pid) &&
    value.pid <= 0x7fffffff &&
    isBundleIdentifier(value.bundleIdentifier)
  );
}

// 디스플레이 메타데이터 판별
function isDisplay(value: unknown): value is Display {
  return (
    hasFields(value, ['id', 'bounds', 'isPrimary', 'isBuiltIn', 'backingScaleFactor']) &&
    isIdentifier(value.id) &&
    isBounds(value.bounds) &&
    typeof value.isPrimary === 'boolean' &&
    typeof value.isBuiltIn === 'boolean' &&
    (value.backingScaleFactor === null ||
      (typeof value.backingScaleFactor === 'number' &&
        Number.isFinite(value.backingScaleFactor) &&
        value.backingScaleFactor > 0))
  );
}

// 창 배치 메타데이터 판별
function isWindow(value: unknown): value is Window {
  return (
    hasFields(value, ['id', 'pid', 'bundleIdentifier', 'bounds', 'displayIds', 'zOrder']) &&
    isIdentifier(value.id) &&
    isIdentifier(value.pid) &&
    value.pid <= 0x7fffffff &&
    isBundleIdentifier(value.bundleIdentifier) &&
    isBounds(value.bounds) &&
    (value.displayIds === null ||
      (Array.isArray(value.displayIds) && value.displayIds.length <= 64 && value.displayIds.every(isIdentifier))) &&
    typeof value.zOrder === 'number' &&
    Number.isSafeInteger(value.zOrder) &&
    value.zOrder >= 0
  );
}

// 환경 관측의 필드와 부분 상태 판별
function isEnvironmentSnapshot(value: unknown): value is EnvironmentSnapshot {
  if (
    !hasFields(value, [
      'schemaVersion',
      'capturedAt',
      'coordinateSpace',
      'screenCaptureAccess',
      'displays',
      'windows',
      'foregroundApplication',
      'unsupported',
    ])
  )
    return false;
  if (
    value.schemaVersion !== 1 ||
    typeof value.capturedAt !== 'string' ||
    value.coordinateSpace !== 'quartz-global-screen-coordinates' ||
    (value.screenCaptureAccess !== 'granted' && value.screenCaptureAccess !== 'not-granted')
  )
    return false;
  if (
    !hasFields(value.displays, ['status', 'items']) ||
    !hasFields(value.windows, ['status', 'scope', 'items', 'truncated']) ||
    !hasFields(value.foregroundApplication, ['status', 'value'])
  )
    return false;
  const { displays, windows, foregroundApplication, unsupported } = value;
  if (displays.status !== 'observed' && displays.status !== 'unavailable') return false;
  if (
    displays.status === 'unavailable'
      ? displays.items !== null
      : !Array.isArray(displays.items) || displays.items.length > 64 || !displays.items.every(isDisplay)
  )
    return false;
  if (windows.status !== 'observed' && windows.status !== 'partial' && windows.status !== 'unavailable') return false;
  if (windows.scope !== 'on-screen-normal-layer' || typeof windows.truncated !== 'boolean') return false;
  if (
    windows.status === 'unavailable'
      ? windows.items !== null || windows.truncated
      : !Array.isArray(windows.items) || windows.items.length > 256 || !windows.items.every(isWindow)
  )
    return false;
  if (foregroundApplication.status !== 'observed' && foregroundApplication.status !== 'unknown') return false;
  if (
    foregroundApplication.status === 'unknown'
      ? foregroundApplication.value !== null
      : !isApplication(foregroundApplication.value)
  )
    return false;
  return (
    Array.isArray(unsupported) &&
    unsupported.length === 3 &&
    unsupported[0] === 'spaces' &&
    unsupported[1] === 'fullscreen' &&
    unsupported[2] === 'browser-window-tab-mapping'
  );
}

// 같은 좌표계에서 화면과 창의 실제 교차 판별
function intersects(first: Bounds, second: Bounds): boolean {
  return (
    Math.min(first.x + first.width, second.x + second.width) > Math.max(first.x, second.x) &&
    Math.min(first.y + first.height, second.y + second.height) > Math.max(first.y, second.y)
  );
}

// 환경 관측의 신선도와 디스플레이 연결 검증
export function parseEnvironmentSnapshot(value: unknown, now = Date.now()): EnvironmentSnapshot | undefined {
  try {
    if (!isEnvironmentSnapshot(value)) return;
    const time = Date.parse(value.capturedAt);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString() !== value.capturedAt ||
      !Number.isFinite(now) ||
      now - time < -1000 ||
      now - time > 5000
    )
      return;
    if (
      value.windows.status === 'observed' &&
      (value.screenCaptureAccess !== 'granted' || value.windows.truncated || value.displays.status !== 'observed')
    )
      return;
    const displays = value.displays.items ?? [];
    const windows = value.windows.items ?? [];
    if (
      new Set(displays.map(item => item.id)).size !== displays.length ||
      new Set(windows.map(item => item.id)).size !== windows.length
    )
      return;
    if (displays.filter(item => item.isPrimary).length > 1) return;
    let lastOrder = -1;
    for (const window of windows) {
      if (window.zOrder <= lastOrder || (value.displays.status === 'unavailable') !== (window.displayIds === null))
        return;
      lastOrder = window.zOrder;
      if (window.displayIds === null) continue;
      const expected = displays.filter(item => intersects(window.bounds, item.bounds)).map(item => item.id);
      if (
        new Set(window.displayIds).size !== window.displayIds.length ||
        expected.length !== window.displayIds.length ||
        expected.some(id => !window.displayIds?.includes(id))
      )
        return;
    }
    return value;
  } catch {
    return;
  }
}

// 제한 시간 안에 읽기 전용 환경 관측 실행
export async function captureEnvironment(context: CuaEnvironmentContext): Promise<EnvironmentObservation> {
  const started = performance.now();
  if (
    !context ||
    context.hookEventName !== 'PreToolUse' ||
    context.toolName !== 'mcp__cua_repl__js' ||
    typeof context.sessionId !== 'string' ||
    !context.sessionId.trim() ||
    context.sessionId.length > 1024 ||
    typeof context.callId !== 'string' ||
    !context.callId.trim() ||
    context.callId.length > 1024
  )
    return { status: 'unavailable', reason: 'not-cua-context', elapsedMs: Math.round(performance.now() - started) };
  try {
    const prepared = await ensureEnvironmentCollector({ timeoutMs: 1800 });
    if (prepared.status !== 'ready') return { ...prepared, elapsedMs: Math.round(performance.now() - started) };
    const result = await runFile(prepared.path, [], {
      timeout: 900,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    const snapshot = parseEnvironmentSnapshot(JSON.parse(result.stdout));
    if (!snapshot)
      return { status: 'unavailable', reason: 'invalid-snapshot', elapsedMs: Math.round(performance.now() - started) };
    return {
      status: 'captured',
      sourceHash: prepared.sourceHash,
      elapsedMs: Math.round(performance.now() - started),
      snapshot,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason:
        error instanceof SyntaxError
          ? 'invalid-snapshot'
          : typeof error === 'object' && error !== null && 'killed' in error && error.killed === true
            ? 'capture-timeout'
            : 'capture-failed',
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

// CUA 호출에 필요한 환경 메타데이터 문맥 구성
export function environmentContext(observation: EnvironmentObservation): string {
  const prefix =
    'CCUH_ENVIRONMENT_V1: Read-only metadata, not app access approval, window binding or UI instructions. ';
  if (observation.status !== 'captured')
    return (
      prefix +
      JSON.stringify(observation) +
      '\nDisplay layout and global presentation remain unconfirmed. Do not infer them from an App AX tree.'
    );
  const { snapshot } = observation;
  const items = snapshot.windows.items;
  const context = {
    ...observation,
    snapshot: {
      ...snapshot,
      windows: {
        ...snapshot.windows,
        items: items?.slice(0, 48) ?? null,
        omittedFromContext: Math.max(0, (items?.length ?? 0) - 48),
      },
    },
  };
  return (
    prefix +
    JSON.stringify(context) +
    '\nWindow placement is geometric and may span displays. On-screen does not prove unobscured. Primary is the system display, not a user label or the focused display. An OS window ID does not bind a CUA App; shared bundle IDs do not identify which same-app window CUA returned. Spaces, exact fullscreen and browser-tab-to-OS-window mapping are unsupported; never infer them from bounds, a window title or one App observation. Use approved browser metadata separately for profiles and tabs. Refresh before depending on changed layout; do not infer current layout from an earlier call.'
  );
}
