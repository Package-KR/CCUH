import { classifyRecognition } from './classify.ts';
import type { RecognitionRequest, RecognitionResult } from './classify.ts';
import { classifyActionOutcome } from '../interaction/outcome.ts';
import type { ActionEvidence, ActionInvocation, ActionOutcome, VerificationVerdict } from '../interaction/outcome.ts';
import { runDraftValue } from '../interaction/draft.ts';
import type { DraftValueOptions, DraftValueResult } from '../interaction/draft.ts';

export { verifyModalDismissal } from '../interaction/transition.ts';
export type { ModalContainerRole, ModalRootSelector, ModalDismissalOptions } from '../interaction/transition.ts';

export type AppApi = {
  getAXState(options: { disableDiffing: true; emit: false }): Promise<string>;
  click(index: number): Promise<unknown>;
  setValue?(index: number, value: string): Promise<unknown>;
};
export type ExecutionMode = 'background' | 'visible';
export type ModeChangeResult = Readonly<
  | { status: 'changed' | 'kept'; mode: ExecutionMode }
  | { status: 'blocked'; mode: ExecutionMode; reason: 'operation-in-progress' }
>;
export type ActionContext = { app: AppApi; state: string; allowWindowRaise?: boolean };
export type TargetOptions = {
  requestId: string;
  app: AppApi;
  appName: string;
  windowTitle?: string;
  maxAgeMs: number;
  reselect?: (context: ActionContext) => Promise<boolean>;
  windowMenu?: string;
  allowWindowRaise?: boolean;
};
declare const targetIdentity: unique symbol;
export type TargetToken = { readonly [targetIdentity]: true };
export type TargetSummary = {
  status: 'ready' | 'blocked';
  recognition: RecognitionResult;
  recoveryAttempts: 0 | 1;
  recovered: boolean;
  recoveryBlockedReason?: 'window-raise-not-authorized';
};
export type TargetExecution<T> =
  | (Omit<TargetSummary, 'status'> & { status: 'blocked' })
  | (Omit<TargetSummary, 'status'> & { status: 'executed'; value?: T });
export type VerificationContext = { before: string; after: string };
export type VerifiedTargetExecution<T> =
  | (Omit<TargetSummary, 'status'> & { status: 'blocked' })
  | (Omit<TargetSummary, 'status'> & { status: 'checked'; outcome: ActionOutcome; value?: T });
export type WindowMenuTrace = Readonly<{
  stage:
    | 'validation'
    | 'initial-observation'
    | 'menu-bar'
    | 'menu-confirmation'
    | 'menu-open'
    | 'popup-observation'
    | 'popup-validation'
    | 'target-click';
  reason:
    | 'invalid-input'
    | 'window-raise-not-authorized'
    | 'initial-header-unconfirmed'
    | 'menu-unconfirmed'
    | 'menu-confirmation-header-unconfirmed'
    | 'menu-confirmation-window-mismatch'
    | 'popup-header-unconfirmed'
    | 'app-mismatch'
    | 'popup-unconfirmed'
    | 'target-unconfirmed'
    | 'selection-requested'
    | 'menu-confirmation-threw'
    | 'menu-open-threw'
    | 'observation-threw'
    | 'target-click-threw'
    | 'operation-threw';
  menuOpenAttempted: boolean;
  confirmationReadCount: 0 | 1;
  menuReferenceChanged: boolean;
  refreshCount: 0 | 1 | 2;
  targetClickAttempted: boolean;
  menuEntryCount: number;
  menuRefUnique: boolean;
  rootDepth: number | null;
  rootCount: number;
  hasMenuBar: boolean;
  rootContentMetadata: boolean;
  rootRefUnique: boolean;
  expectedRoot: boolean;
  targetCount: number;
  matchingActionCount: number;
  targetRefUnique: boolean;
}>;

type TargetRecord = Readonly<{
  app: AppApi;
  expected: RecognitionRequest;
  maxAgeMs: number;
  reselect?: TargetOptions['reselect'];
  windowMenu?: string;
  allowWindowRaise?: boolean;
}>;
type Observation = { recognition: RecognitionResult; state?: string };
type Preparation = { summary: TargetSummary; state?: string };
type Header = { app: string; window?: string };
type MenuRow = { index: number; depth: number; label: string; id?: string; contentMetadata: boolean };

const targets = new WeakMap<object, TargetRecord>();
const busyApps = new WeakSet<AppApi>();
let executionMode: ExecutionMode = 'background';
let activeOperations = 0;

// 현재 REPL의 실행 모드 조회
export function getMode(): ExecutionMode {
  return executionMode;
}

// 진행 중인 작업을 보존하며 실행 모드 변경
export function setMode(mode: ExecutionMode): ModeChangeResult {
  if (mode !== 'background' && mode !== 'visible') {
    throw new TypeError('A background or visible execution mode is required.');
  }
  if (mode === executionMode) return Object.freeze({ status: 'kept', mode: executionMode });
  if (activeOperations > 0) {
    return Object.freeze({ status: 'blocked', mode: executionMode, reason: 'operation-in-progress' });
  }
  executionMode = mode;
  return Object.freeze({ status: 'changed', mode: executionMode });
}

// 현재 모드와 대상별 창 올림 제한 확인
function windowRaiseAllowed(permission: boolean | undefined): boolean {
  return executionMode === 'visible' && permission !== false;
}

// 유효한 대상 식별 문자열 검사
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

// 분류할 수 없는 관측 요약 구성
function unknown(reason: 'invalid-evidence' | 'unclassified-error'): RecognitionResult {
  return { status: 'unknown', reason, basis: [] };
}

// 전체 스냅샷의 첫 창 헤더 추출
function readHeader(state: string): Header | undefined {
  const match = /^Window: "(.*)", App: ([^\r\n]+)\.$/u.exec(state.split(/\r?\n/u, 1)[0] ?? '');
  if (!match || !validText(match[2]) || (match[1] !== '' && !validText(match[1]))) return;
  return { app: match[2], ...(match[1] === '' ? {} : { window: match[1] }) };
}

// 정규화된 표시 이름 비교
function equalText(left: string, right: string): boolean {
  return left.normalize('NFC') === right.normalize('NFC');
}

// 같은 공식 앱 핸들의 최신 대상 분류
async function observeTarget(target: TargetRecord): Promise<Observation> {
  try {
    const state = await target.app.getAXState({ disableDiffing: true, emit: false });
    const observedAtMs = Date.now();
    const header = typeof state === 'string' ? readHeader(state) : undefined;
    if (!header) return { recognition: unknown('invalid-evidence') };
    return {
      state,
      recognition: classifyRecognition(
        target.expected,
        {
          requestId: target.expected.requestId,
          observedAtMs,
          result: {
            kind: 'observed',
            app: { kind: 'app-name', value: header.app },
            ...(header.window === undefined ? {} : { window: { kind: 'window-title', value: header.window } }),
          },
        },
        { nowMs: Date.now(), maxAgeMs: target.maxAgeMs },
      ),
    };
  } catch {
    return { recognition: unknown('unclassified-error') };
  }
}

// 확인한 앱의 창 조건에 한정한 한 번의 재선택
async function prepare(target: TargetRecord): Promise<Preparation> {
  let observation = await observeTarget(target);
  let recoveryAttempts: 0 | 1 = 0;
  let recovered = false;
  const menuTitle =
    target.windowMenu !== undefined && target.expected.window?.kind === 'window-title'
      ? target.expected.window.value
      : undefined;
  const windowMismatch =
    observation.recognition.status === 'failed' && observation.recognition.reason === 'window-selector-mismatch';
  const windowUnobserved =
    menuTitle !== undefined &&
    observation.recognition.status === 'unknown' &&
    observation.recognition.reason === 'window-unobserved' &&
    observation.recognition.basis.length === 1 &&
    observation.recognition.basis[0] === 'app-name';
  if (
    (windowMismatch || windowUnobserved) &&
    (target.reselect || menuTitle !== undefined) &&
    observation.state !== undefined
  ) {
    if (!windowRaiseAllowed(target.allowWindowRaise)) {
      return {
        summary: {
          status: 'blocked',
          recognition: observation.recognition,
          recoveryAttempts,
          recovered,
          recoveryBlockedReason: 'window-raise-not-authorized',
        },
      };
    }
    recoveryAttempts = 1;
    try {
      const context = {
        app: target.app,
        state: observation.state,
        allowWindowRaise: windowRaiseAllowed(target.allowWindowRaise),
      };
      const selected =
        target.windowMenu !== undefined && menuTitle !== undefined
          ? await selectWindowFromMenu(context, target.windowMenu, menuTitle)
          : await target.reselect?.(context);
      observation = await observeTarget(target);
      recovered = selected === true && observation.recognition.status === 'matched';
    } catch {
      observation = { recognition: unknown('unclassified-error') };
    }
  }
  const ready = observation.recognition.status === 'matched' && (recoveryAttempts === 0 || recovered);
  return {
    summary: { status: ready ? 'ready' : 'blocked', recognition: observation.recognition, recoveryAttempts, recovered },
    ...(ready ? { state: observation.state } : {}),
  };
}

// 유효하지 않거나 사용 중인 대상의 중단 요약
function blocked(reason: 'invalid-evidence' | 'unclassified-error'): TargetSummary & { status: 'blocked' } {
  return { status: 'blocked', recognition: unknown(reason), recoveryAttempts: 0, recovered: false };
}

// 호출자가 받은 공식 앱 핸들과 고정 대상 등록
export function createTarget(options: TargetOptions): TargetToken {
  if (
    !options ||
    typeof options.app !== 'object' ||
    options.app === null ||
    typeof options.app.getAXState !== 'function' ||
    typeof options.app.click !== 'function' ||
    !validText(options.requestId) ||
    !validText(options.appName) ||
    (options.windowTitle !== undefined && !validText(options.windowTitle)) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs < 0 ||
    (options.reselect !== undefined && typeof options.reselect !== 'function') ||
    (options.allowWindowRaise !== undefined && typeof options.allowWindowRaise !== 'boolean') ||
    (options.windowMenu !== undefined &&
      (!validText(options.windowMenu) || options.windowTitle === undefined || options.reselect !== undefined))
  )
    throw new TypeError('A valid official App handle and target options are required.');
  const token = Object.freeze({}) as TargetToken;
  const expected: RecognitionRequest = Object.freeze({
    requestId: options.requestId,
    app: Object.freeze({ kind: 'app-name', value: options.appName }),
    ...(options.windowTitle === undefined
      ? {}
      : { window: Object.freeze({ kind: 'window-title', value: options.windowTitle }) }),
  });
  targets.set(
    token,
    Object.freeze({
      app: options.app,
      expected,
      maxAgeMs: options.maxAgeMs,
      reselect: options.reselect,
      windowMenu: options.windowMenu,
      allowWindowRaise: options.allowWindowRaise,
    }),
  );
  return token;
}

// 대상 재확인과 제한된 복구 결과 조회
export async function prepareTarget(token: TargetToken): Promise<TargetSummary> {
  const target = targets.get(token);
  if (!target) return blocked('invalid-evidence');
  if (busyApps.has(target.app)) return blocked('unclassified-error');
  busyApps.add(target.app);
  activeOperations += 1;
  try {
    return (await prepare(target)).summary;
  } finally {
    busyApps.delete(target.app);
    activeOperations -= 1;
  }
}

// 최신 대상 확인 후 작업 한 번 실행
export async function withTarget<T>(
  token: TargetToken,
  action: (context: ActionContext) => Promise<T>,
): Promise<TargetExecution<T>> {
  const target = targets.get(token);
  if (!target || typeof action !== 'function') return blocked('invalid-evidence');
  if (busyApps.has(target.app)) return blocked('unclassified-error');
  busyApps.add(target.app);
  activeOperations += 1;
  try {
    const { summary, state } = await prepare(target);
    if (summary.status !== 'ready' || state === undefined) return { ...summary, status: 'blocked' };
    const value = await action({
      app: target.app,
      state,
      allowWindowRaise: windowRaiseAllowed(target.allowWindowRaise),
    });
    const observation = await observeTarget(target);
    return {
      ...summary,
      status: 'executed',
      recognition: observation.recognition,
      ...(value === undefined ? {} : { value }),
    };
  } finally {
    busyApps.delete(target.app);
    activeOperations -= 1;
  }
}

// 작업 한 번 실행 후 같은 대상의 실제 변화 확인
export async function withVerifiedTarget<T>(
  token: TargetToken,
  action: (context: ActionContext) => Promise<T>,
  verify: (context: VerificationContext) => VerificationVerdict | Promise<VerificationVerdict>,
): Promise<VerifiedTargetExecution<T>> {
  const target = targets.get(token);
  if (!target || typeof action !== 'function' || typeof verify !== 'function') return blocked('invalid-evidence');
  if (busyApps.has(target.app)) return blocked('unclassified-error');
  busyApps.add(target.app);
  activeOperations += 1;
  try {
    const { summary, state } = await prepare(target);
    if (summary.status !== 'ready' || state === undefined) return { ...summary, status: 'blocked' };
    let invocation: ActionInvocation = 'returned';
    let value: T | undefined;
    try {
      value = await action({ app: target.app, state, allowWindowRaise: windowRaiseAllowed(target.allowWindowRaise) });
    } catch {
      invocation = 'threw';
    }
    const observation = await observeTarget(target);
    let evidence: ActionEvidence = { kind: 'unavailable', reason: 'target-unconfirmed' };
    if (observation.recognition.status === 'matched' && observation.state !== undefined) {
      evidence = { kind: 'observed', changed: state !== observation.state, verdict: 'unknown' };
      if (evidence.changed) {
        try {
          const verdict = await verify({ before: state, after: observation.state });
          evidence.verdict = verdict === true || verdict === false ? verdict : 'unknown';
        } catch {
          evidence = { kind: 'unavailable', reason: 'verification-threw' };
        }
      }
    }
    return {
      ...summary,
      status: 'checked',
      recognition: observation.recognition,
      outcome: classifyActionOutcome(invocation, evidence),
      ...(invocation === 'returned' && value !== undefined ? { value } : {}),
    };
  } finally {
    busyApps.delete(target.app);
    activeOperations -= 1;
  }
}

// 명시한 로컬 초안 필드의 교체와 제한된 재시도
export async function setDraftValue(token: TargetToken, options: DraftValueOptions): Promise<DraftValueResult> {
  const target = targets.get(token);
  const initial: DraftValueResult = {
    status: 'blocked',
    reason: 'invalid-options',
    attempts: 0,
    lastInvocation: 'not-attempted',
    observedValue: 'unavailable',
    recognition: unknown('invalid-evidence'),
  };
  if (
    !target ||
    !options ||
    options.effect !== 'local-draft' ||
    !validText(options.fieldId) ||
    typeof options.value !== 'string' ||
    typeof options.readValue !== 'function' ||
    typeof target.app.setValue !== 'function'
  )
    return initial;
  if (busyApps.has(target.app)) return { ...initial, reason: 'app-busy', recognition: unknown('unclassified-error') };
  const settings = Object.freeze({
    effect: options.effect,
    fieldId: options.fieldId,
    value: options.value,
    readValue: options.readValue,
  });
  const setValue = target.app.setValue.bind(target.app);
  busyApps.add(target.app);
  activeOperations += 1;
  try {
    const { summary, state } = await prepare(target);
    if (summary.status !== 'ready' || state === undefined) {
      return { ...initial, reason: 'target-unconfirmed', recognition: summary.recognition };
    }
    return await runDraftValue(
      { recognition: summary.recognition, state },
      { setValue, observe: () => observeTarget(target) },
      settings,
    );
  } finally {
    busyApps.delete(target.app);
    activeOperations -= 1;
  }
}

// 전체 접근성 스냅샷의 메뉴 행 추출
function readMenuRows(state: string): MenuRow[] {
  return state.split(/\r?\n/u).flatMap(line => {
    const row = /^(\s*)(\d+)\s+(.+)$/u.exec(line);
    if (!row) return [];
    const metadata = /(?:,\s*|\s+)(?:ID|Secondary Actions|Value|Description|Help):/u.exec(row[3]);
    const id = /(?:,\s*|\s+)ID: ([^,]+)(?:,|$)/u.exec(row[3])?.[1]?.trim();
    return [
      {
        index: Number(row[2]),
        depth: row[1].length,
        label: row[3].slice(0, metadata?.index).trim(),
        id,
        contentMetadata: /(?:,\s*|\s+)(?:Value|Description|Help):/u.test(row[3]),
      },
    ];
  });
}

// 전체 관측에서 고유한 안전 정수 메뉴 참조 확인
function isUniqueMenuReference(rows: MenuRow[], index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && rows.filter(row => row.index === index).length === 1;
}

// 유일한 메뉴 모음의 직계 항목 조회
function menuBarEntries(rows: MenuRow[]): MenuRow[] | undefined {
  const bars = rows.filter(row => row.label === 'menu bar');
  if (bars.length !== 1) return undefined;
  const start = rows.indexOf(bars[0]);
  const children: MenuRow[] = [];
  for (let index = start + 1; index < rows.length && rows[index].depth > bars[0].depth; index++) {
    const row = rows[index];
    if (index === start + 1 || row.depth <= children[0]?.depth) children.push(row);
  }
  return children;
}

// 메뉴 모음의 유일한 직계 메뉴 항목 확인
function menuEntry(rows: MenuRow[], name: string): MenuRow | undefined {
  const matches = menuBarEntries(rows)?.filter(row => equalText(row.label, name)) ?? [];
  return matches.length === 1 && isUniqueMenuReference(rows, matches[0].index) ? matches[0] : undefined;
}

// 단일 메뉴 팝업의 최상위 범위 확인
function menuPopupRoot(rows: MenuRow[]): MenuRow | undefined {
  const root = rows[0];
  if (
    !root ||
    root.depth !== 0 ||
    root.contentMetadata ||
    rows.length < 2 ||
    !isUniqueMenuReference(rows, root.index) ||
    rows.slice(1).some(row => row.depth <= root.depth || row.label === 'menu bar')
  )
    return;
  return root;
}

// 확인한 창 메뉴 안의 고유한 대상 참조 조회
function windowMenuTarget(rows: MenuRow[], menuName: string, title: string): MenuRow | undefined {
  const root = menuPopupRoot(rows);
  if (!root || !equalText(root.label, menuName)) return;
  const matches = rows.slice(1).filter(row => row.id === 'makeKeyAndOrderFront:' && equalText(row.label, title));
  return matches.length === 1 && isUniqueMenuReference(rows, matches[0].index) ? matches[0] : undefined;
}

// 직전 메뉴 모음에 속한 다른 팝업인지 확인
function isKnownOtherMenuPopup(rows: MenuRow[], originalRows: MenuRow[], menuName: string): boolean {
  const root = menuPopupRoot(rows);
  if (!root || equalText(root.label, menuName)) return false;
  return menuBarEntries(originalRows)?.filter(row => equalText(row.label, root.label)).length === 1;
}

// 공식 창 메뉴에서 유일한 대상 선택 요청
export async function selectWindowFromMenu(
  context: ActionContext,
  menuName: string,
  title: string,
  observer?: (trace: WindowMenuTrace) => void,
): Promise<boolean> {
  const trace: { -readonly [Key in keyof WindowMenuTrace]: WindowMenuTrace[Key] } = {
    stage: 'validation',
    reason: 'invalid-input',
    menuOpenAttempted: false,
    confirmationReadCount: 0,
    menuReferenceChanged: false,
    refreshCount: 0,
    targetClickAttempted: false,
    menuEntryCount: 0,
    menuRefUnique: false,
    rootDepth: null,
    rootCount: 0,
    hasMenuBar: false,
    rootContentMetadata: false,
    rootRefUnique: false,
    expectedRoot: false,
    targetCount: 0,
    matchingActionCount: 0,
    targetRefUnique: false,
  };

  // 마지막 판정 사유와 반환값 설정
  function complete(reason: WindowMenuTrace['reason'], result = false): boolean {
    trace.reason = reason;
    return result;
  }

  // 원문 없는 팝업 구조와 대상 개수 요약
  function describeRows(rows: MenuRow[]): void {
    const root = rows[0];
    const targets = rows.slice(1).filter(row => equalText(row.label, title));
    const matching = targets.filter(row => row.id === 'makeKeyAndOrderFront:');
    trace.rootDepth = root?.depth ?? null;
    trace.rootCount = root ? rows.filter(row => row.depth <= root.depth).length : 0;
    trace.hasMenuBar = rows.some(row => row.label === 'menu bar');
    trace.rootContentMetadata = root?.contentMetadata ?? false;
    trace.rootRefUnique = root ? isUniqueMenuReference(rows, root.index) : false;
    trace.expectedRoot = root ? equalText(root.label, menuName) : false;
    trace.targetCount = targets.length;
    trace.matchingActionCount = matching.length;
    trace.targetRefUnique = matching.length === 1 && isUniqueMenuReference(rows, matching[0].index);
  }

  // 고정 진단을 한 번 전달하고 관측자 예외 격리
  function report(): void {
    if (typeof observer !== 'function') return;
    try {
      Promise.resolve(observer(Object.freeze({ ...trace }))).catch(() => {});
    } catch {
      return;
    }
  }

  activeOperations += 1;
  try {
    if (executionMode !== 'visible' || context?.allowWindowRaise !== true) {
      return complete('window-raise-not-authorized');
    }
    if (!validText(menuName) || !validText(title) || !context || typeof context.state !== 'string') {
      return complete('invalid-input');
    }
    const { app, state } = context;
    trace.stage = 'initial-observation';
    const initial = readHeader(state);
    if (!initial) return complete('initial-header-unconfirmed');
    const originalRows = readMenuRows(state);
    let menuRows = originalRows;
    let rows = originalRows;
    describeRows(rows);
    if (!rows[0] || !equalText(rows[0].label, menuName)) {
      trace.stage = 'menu-bar';
      trace.menuEntryCount = menuBarEntries(originalRows)?.filter(row => equalText(row.label, menuName)).length ?? 0;
      const initialMenu = menuEntry(originalRows, menuName);
      trace.menuRefUnique = initialMenu !== undefined;
      if (!initialMenu) return complete('menu-unconfirmed');
      trace.stage = 'menu-confirmation';
      trace.confirmationReadCount = 1;
      const confirmation = await app.getAXState({ disableDiffing: true, emit: false });
      const confirmedHeader = typeof confirmation === 'string' ? readHeader(confirmation) : undefined;
      if (!confirmedHeader) return complete('menu-confirmation-header-unconfirmed');
      if (!equalText(initial.app, confirmedHeader.app)) return complete('app-mismatch');
      if (!equalText(initial.window ?? '', confirmedHeader.window ?? '')) {
        return complete('menu-confirmation-window-mismatch');
      }
      menuRows = readMenuRows(confirmation);
      rows = menuRows;
      describeRows(rows);
      trace.menuEntryCount = menuBarEntries(menuRows)?.filter(row => equalText(row.label, menuName)).length ?? 0;
      const menu = menuEntry(menuRows, menuName);
      trace.menuRefUnique = menu !== undefined;
      if (!menu) return complete('menu-unconfirmed');
      trace.menuReferenceChanged = menu.index !== initialMenu.index;
      trace.stage = 'menu-open';
      if (executionMode !== 'visible' || context.allowWindowRaise !== true) {
        return complete('window-raise-not-authorized');
      }
      trace.menuOpenAttempted = true;
      await app.click(menu.index);
      trace.stage = 'popup-observation';
      trace.refreshCount = 1;
      describeRows([]);
      let popup = await app.getAXState({ disableDiffing: true, emit: false });
      trace.stage = 'popup-validation';
      rows = readMenuRows(popup);
      describeRows(rows);
      let header = readHeader(popup);
      if (!header) return complete('popup-header-unconfirmed');
      if (!equalText(initial.app, header.app)) return complete('app-mismatch');
      if (isKnownOtherMenuPopup(rows, menuRows, menuName)) {
        trace.stage = 'popup-observation';
        trace.refreshCount = 2;
        describeRows([]);
        popup = await app.getAXState({ disableDiffing: true, emit: false });
        trace.stage = 'popup-validation';
        rows = readMenuRows(popup);
        describeRows(rows);
        header = readHeader(popup);
        if (!header) return complete('popup-header-unconfirmed');
        if (!equalText(initial.app, header.app)) return complete('app-mismatch');
      }
    }
    trace.stage = 'popup-validation';
    const root = menuPopupRoot(rows);
    if (!root || !equalText(root.label, menuName)) return complete('popup-unconfirmed');
    const target = windowMenuTarget(rows, menuName, title);
    if (!target) return complete('target-unconfirmed');
    trace.stage = 'target-click';
    if (executionMode !== 'visible' || context.allowWindowRaise !== true) {
      return complete('window-raise-not-authorized');
    }
    trace.targetClickAttempted = true;
    await app.click(target.index);
    return complete('selection-requested', true);
  } catch {
    return complete(
      trace.stage === 'menu-confirmation'
        ? 'menu-confirmation-threw'
        : trace.stage === 'menu-open'
          ? 'menu-open-threw'
          : trace.stage === 'popup-observation'
            ? 'observation-threw'
            : trace.stage === 'target-click'
              ? 'target-click-threw'
              : 'operation-threw',
    );
  } finally {
    report();
    activeOperations -= 1;
  }
}
