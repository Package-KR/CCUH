export type BrowserWindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen';
export type BrowserWindowBounds = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
  unit: 'chrome-window-pixels';
}>;
export type BrowserWindowApi = {
  readonly browserId: string;
  capabilities: { get(id: 'management'): Promise<unknown> };
};
export type BrowserWindowUnavailableReason =
  | 'invalid-input'
  | 'management-unavailable'
  | 'tab-unavailable'
  | 'window-unavailable'
  | 'invalid-tab'
  | 'invalid-window'
  | 'tab-window-changed'
  | 'browser-identity-changed';
export type BrowserTabWindowObservation =
  | Readonly<{
      status: 'observed';
      browserId: string;
      identityScope: 'chrome-browser-session';
      chromeTabId: number;
      chromeWindowId: number;
      state: BrowserWindowState;
      bounds: BrowserWindowBounds | null;
      capturedAtMs: number;
      unsupported: readonly ['os-window-id', 'cua-native-window', 'cua-tab-id-binding', 'display-id', 'spaces'];
    }>
  | Readonly<{ status: 'unavailable'; reason: BrowserWindowUnavailableReason }>;

type ManagementApi = {
  tabs: { get(id: number): Promise<unknown> };
  windows: { get(id: number, options: { populate: false }): Promise<unknown> };
};
type TabIdentity = { id: number; windowId: number };
type WindowObservation = { id: number; state: BrowserWindowState; bounds: BrowserWindowBounds | null };

const UNSUPPORTED = Object.freeze([
  'os-window-id',
  'cua-native-window',
  'cua-tab-id-binding',
  'display-id',
  'spaces',
] as const);
const WINDOW_STATES: readonly string[] = ['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'];

// 임의 형 변환 없이 브라우저 식별 숫자 검사
function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// 필요한 자체 데이터 필드만 읽기
function readFields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  try {
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field) continue;
      if (!Object.hasOwn(field, 'value')) return;
      fields[key] = field.value;
    }
    return fields;
  } catch {
    return;
  }
}

// 브라우저 탭의 자체 식별자 판독
function readTab(value: unknown): TabIdentity | undefined {
  const fields = readFields(value, ['id', 'windowId']);
  if (!fields || !validId(fields.id) || !validId(fields.windowId)) return;
  return { id: fields.id, windowId: fields.windowId };
}

// 브라우저 창의 상태와 제공된 좌표 검사
function readWindow(value: unknown): WindowObservation | undefined {
  const coordinates = ['left', 'top', 'width', 'height'] as const;
  const fields = readFields(value, ['id', 'state', ...coordinates]);
  if (!fields || !validId(fields.id) || typeof fields.state !== 'string' || !WINDOW_STATES.includes(fields.state))
    return;
  for (const key of coordinates) {
    if (!Object.hasOwn(fields, key) || fields[key] === null || fields[key] === undefined) continue;
    const value = fields[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      ((key === 'width' || key === 'height') && value <= 0)
    )
      return;
  }
  const bounds = coordinates.every(key => typeof fields[key] === 'number')
    ? Object.freeze({
        left: fields.left as number,
        top: fields.top as number,
        width: fields.width as number,
        height: fields.height as number,
        unit: 'chrome-window-pixels' as const,
      })
    : null;
  return { id: fields.id, state: fields.state as BrowserWindowState, bounds };
}

// 선택한 브라우저의 식별자 유지 확인
function sameBrowser(browser: BrowserWindowApi, browserId: string): boolean {
  try {
    return browser.browserId === browserId;
  } catch {
    return false;
  }
}

// 원문을 제외한 브라우저 관측 중단 결과 구성
function unavailable(reason: BrowserWindowUnavailableReason): BrowserTabWindowObservation {
  return Object.freeze({ status: 'unavailable', reason });
}

// 같은 브라우저 탭의 창 연결과 창 상태를 읽기 전용 관측
export async function observeBrowserTabWindow(
  browser: BrowserWindowApi,
  chromeTabId: number,
): Promise<BrowserTabWindowObservation> {
  let reason: BrowserWindowUnavailableReason = 'invalid-input';
  try {
    if (!browser || typeof browser !== 'object' || !validId(chromeTabId)) return unavailable(reason);
    const browserId = browser.browserId;
    if (
      typeof browserId !== 'string' ||
      browserId.trim().length === 0 ||
      browserId.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(browserId)
    )
      return unavailable(reason);
    reason = 'management-unavailable';
    const management = (await browser.capabilities.get('management')) as ManagementApi | undefined;
    if (!sameBrowser(browser, browserId)) return unavailable('browser-identity-changed');
    if (
      !management ||
      typeof management !== 'object' ||
      Array.isArray(management) ||
      typeof management.tabs?.get !== 'function' ||
      typeof management.windows?.get !== 'function'
    )
      return unavailable(reason);
    reason = 'tab-unavailable';
    const firstTab = readTab(await management.tabs.get(chromeTabId));
    if (!sameBrowser(browser, browserId)) return unavailable('browser-identity-changed');
    if (!firstTab || firstTab.id !== chromeTabId) return unavailable('invalid-tab');
    reason = 'window-unavailable';
    const windowValue = await management.windows.get(firstTab.windowId, { populate: false });
    const capturedAtMs = Date.now();
    if (!sameBrowser(browser, browserId)) return unavailable('browser-identity-changed');
    const window = readWindow(windowValue);
    if (!window || window.id !== firstTab.windowId || !validId(capturedAtMs)) return unavailable('invalid-window');
    reason = 'tab-unavailable';
    const lastTab = readTab(await management.tabs.get(chromeTabId));
    if (!sameBrowser(browser, browserId)) return unavailable('browser-identity-changed');
    if (!lastTab || lastTab.id !== chromeTabId) return unavailable('invalid-tab');
    if (lastTab.windowId !== firstTab.windowId) return unavailable('tab-window-changed');
    return Object.freeze({
      status: 'observed',
      browserId,
      identityScope: 'chrome-browser-session',
      chromeTabId,
      chromeWindowId: window.id,
      state: window.state,
      bounds: window.bounds,
      capturedAtMs,
      unsupported: UNSUPPORTED,
    });
  } catch {
    return unavailable(reason);
  }
}
