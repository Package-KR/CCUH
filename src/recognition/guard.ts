import { classifyRecognition } from './classify.ts';
import type { RecognitionRequest, RecognitionResult } from './classify.ts';
import { classifyActionOutcome } from '../interaction/outcome.ts';
import type { ActionEvidence, ActionInvocation, ActionOutcome, VerificationVerdict } from '../interaction/outcome.ts';
import { runDraftValue } from '../interaction/draft.ts';
import type { DraftValueOptions, DraftValueResult } from '../interaction/draft.ts';

export type AppApi = {
  getAXState(options: { disableDiffing: true; emit: false }): Promise<string>;
  click(index: number): Promise<unknown>;
  setValue?(index: number, value: string): Promise<unknown>;
};
export type ActionContext = { app: AppApi; state: string };
export type TargetOptions = {
  requestId: string;
  app: AppApi;
  appName: string;
  windowTitle?: string;
  maxAgeMs: number;
  reselect?: (context: ActionContext) => Promise<boolean>;
};
declare const targetIdentity: unique symbol;
export type TargetToken = { readonly [targetIdentity]: true };
export type TargetSummary = {
  status: 'ready' | 'blocked';
  recognition: RecognitionResult;
  recoveryAttempts: 0 | 1;
  recovered: boolean;
};
export type TargetExecution<T> =
  | (Omit<TargetSummary, 'status'> & { status: 'blocked' })
  | (Omit<TargetSummary, 'status'> & { status: 'executed'; value?: T });
export type VerificationContext = { before: string; after: string };
export type VerifiedTargetExecution<T> =
  | (Omit<TargetSummary, 'status'> & { status: 'blocked' })
  | (Omit<TargetSummary, 'status'> & { status: 'checked'; outcome: ActionOutcome; value?: T });

type TargetRecord = Readonly<{
  app: AppApi;
  expected: RecognitionRequest;
  maxAgeMs: number;
  reselect?: TargetOptions['reselect'];
}>;
type Observation = { recognition: RecognitionResult; state?: string };
type Preparation = { summary: TargetSummary; state?: string };
type Header = { app: string; window?: string };
type MenuRow = { index: number; depth: number; label: string; id?: string };

const targets = new WeakMap<object, TargetRecord>();
const busyApps = new WeakSet<AppApi>();

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

// 창 불일치에 한정한 한 번의 재선택
async function prepare(target: TargetRecord): Promise<Preparation> {
  let observation = await observeTarget(target);
  let recoveryAttempts: 0 | 1 = 0;
  let recovered = false;
  if (
    observation.recognition.status === 'failed' &&
    observation.recognition.reason === 'window-selector-mismatch' &&
    target.reselect &&
    observation.state !== undefined
  ) {
    recoveryAttempts = 1;
    try {
      const selected = await target.reselect({ app: target.app, state: observation.state });
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
    (options.reselect !== undefined && typeof options.reselect !== 'function')
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
    Object.freeze({ app: options.app, expected, maxAgeMs: options.maxAgeMs, reselect: options.reselect }),
  );
  return token;
}

// 대상 재확인과 제한된 복구 결과 조회
export async function prepareTarget(token: TargetToken): Promise<TargetSummary> {
  const target = targets.get(token);
  if (!target) return blocked('invalid-evidence');
  if (busyApps.has(target.app)) return blocked('unclassified-error');
  busyApps.add(target.app);
  try {
    return (await prepare(target)).summary;
  } finally {
    busyApps.delete(target.app);
  }
}

// 최신 대상 확인 후 작업 한 번 실행
export async function withTarget<T>(
  token: TargetToken,
  action: (context: ActionContext) => Promise<T>,
): Promise<TargetExecution<T>> {
  const target = targets.get(token);
  if (!target) return blocked('invalid-evidence');
  if (busyApps.has(target.app)) return blocked('unclassified-error');
  busyApps.add(target.app);
  try {
    const { summary, state } = await prepare(target);
    if (summary.status !== 'ready' || state === undefined) return { ...summary, status: 'blocked' };
    const value = await action({ app: target.app, state });
    const observation = await observeTarget(target);
    return {
      ...summary,
      status: 'executed',
      recognition: observation.recognition,
      ...(value === undefined ? {} : { value }),
    };
  } finally {
    busyApps.delete(target.app);
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
  try {
    const { summary, state } = await prepare(target);
    if (summary.status !== 'ready' || state === undefined) return { ...summary, status: 'blocked' };
    let invocation: ActionInvocation = 'returned';
    let value: T | undefined;
    try {
      value = await action({ app: target.app, state });
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
  }
}

// 전체 접근성 스냅샷의 메뉴 행 추출
function readMenuRows(state: string): MenuRow[] {
  return state.split(/\r?\n/u).flatMap(line => {
    const row = /^(\s*)(\d+)\s+(.+)$/u.exec(line);
    if (!row) return [];
    const metadata = /(?:,\s*|\s+)(?:ID|Secondary Actions|Value|Description|Help):/u.exec(row[3]);
    const id = /(?:,\s*|\s+)ID: ([^,]+)(?:,|$)/u.exec(row[3])?.[1]?.trim();
    return [{ index: Number(row[2]), depth: row[1].length, label: row[3].slice(0, metadata?.index).trim(), id }];
  });
}

// 메뉴 모음의 유일한 직계 메뉴 항목 확인
function menuEntry(rows: MenuRow[], name: string): MenuRow | undefined {
  const bars = rows.filter(row => row.label === 'menu bar');
  if (bars.length !== 1) return undefined;
  const start = rows.indexOf(bars[0]);
  const children: MenuRow[] = [];
  for (let index = start + 1; index < rows.length && rows[index].depth > bars[0].depth; index++) {
    const row = rows[index];
    if (index === start + 1 || row.depth <= children[0]?.depth) children.push(row);
  }
  const matches = children.filter(row => equalText(row.label, name));
  return matches.length === 1 ? matches[0] : undefined;
}

// 공식 창 메뉴에서 유일한 대상 선택 요청
export async function selectWindowFromMenu(
  { app, state }: ActionContext,
  menuName: string,
  title: string,
): Promise<boolean> {
  if (!validText(menuName) || !validText(title)) return false;
  const initial = readHeader(state);
  const menu = menuEntry(readMenuRows(state), menuName);
  if (!initial || !menu) return false;
  try {
    await app.click(menu.index);
    const popup = await app.getAXState({ disableDiffing: true, emit: false });
    const header = readHeader(popup);
    const rows = readMenuRows(popup);
    const root = rows[0];
    if (!header || !equalText(initial.app, header.app) || !root || !equalText(root.label, menuName)) return false;
    const end = rows.findIndex((row, index) => index > 0 && row.depth <= root.depth);
    const matches = rows
      .slice(1, end === -1 ? undefined : end)
      .filter(row => row.id === 'makeKeyAndOrderFront:' && equalText(row.label, title));
    if (matches.length !== 1) return false;
    await app.click(matches[0].index);
    return true;
  } catch {
    return false;
  }
}
