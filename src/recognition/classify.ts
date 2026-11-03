type AppSelector = { kind: 'bundle-id' | 'app-name'; value: string };
type WindowSelector = { kind: 'window-title'; value: string } | { kind: 'window-id'; namespace: string; value: string };

export type RecognitionRequest = { requestId: string; app: AppSelector; window?: WindowSelector };
export type RecognitionObservation = {
  requestId: string;
  observedAtMs: number;
  result:
    | { kind: 'observed'; app: AppSelector; window?: WindowSelector; ambiguous?: boolean }
    | { kind: 'access-denied' | 'app-not-found' | 'window-not-found' | 'reference-invalid' | 'unclassified-error' };
};
export type RecognitionPolicy = { nowMs: number; maxAgeMs: number };

type ComparisonBasis = AppSelector['kind'] | WindowSelector['kind'];
type FailureReason = 'access-denied' | 'app-not-found' | 'window-not-found' | 'reference-invalid';
type UnknownReason =
  | 'invalid-evidence'
  | 'different-request'
  | 'stale-observation'
  | 'future-observation'
  | 'unclassified-error'
  | 'incomparable-app-selector'
  | 'incomparable-window-selector'
  | 'insufficient-app-identity'
  | 'window-unobserved'
  | 'ambiguous-target';
export type RecognitionFailureStage = 'ax-read' | 'header' | 'classification' | 'reselection' | 'operation-in-progress';

export type RecognitionResult =
  | { status: 'matched'; reason: 'app-selector-matched' | 'window-selector-matched'; basis: ComparisonBasis[] }
  | {
      status: 'failed';
      reason: FailureReason | 'app-selector-mismatch' | 'window-selector-mismatch';
      basis: ComparisonBasis[];
    }
  | {
      status: 'unknown';
      reason: UnknownReason;
      basis: ComparisonBasis[];
      failureStage?: RecognitionFailureStage;
    };

const FAILURE_REASONS = new Set(['access-denied', 'app-not-found', 'window-not-found', 'reference-invalid']);

// 필수 자체 데이터 필드를 가진 일반 객체 판별
function hasFields(value: unknown, keys: string[], required: string[] = keys): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(fields).every(
      key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(fields[key], 'value'),
    ) && required.every(key => Object.hasOwn(fields, key))
  );
}

// 비어 있지 않은 식별 문자열 검사
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

// 앱 선택 조건 검사
function isAppSelector(value: unknown): value is AppSelector {
  return (
    hasFields(value, ['kind', 'value']) &&
    (value.kind === 'bundle-id' || value.kind === 'app-name') &&
    validText(value.value)
  );
}

// 창 선택 조건과 식별자 범위 검사
function isWindowSelector(value: unknown): value is WindowSelector {
  if (!hasFields(value, ['kind', 'value', 'namespace'], ['kind', 'value']) || !validText(value.value)) return false;
  return value.kind === 'window-id'
    ? validText(value.namespace)
    : value.kind === 'window-title' && !Object.hasOwn(value, 'namespace');
}

// 대상 요청과 비교 정책 검사
function validRequestPolicy(request: unknown, policy: unknown): request is RecognitionRequest {
  return (
    hasFields(request, ['requestId', 'app', 'window'], ['requestId', 'app']) &&
    validText(request.requestId) &&
    isAppSelector(request.app) &&
    (!Object.hasOwn(request, 'window') || isWindowSelector(request.window)) &&
    hasFields(policy, ['nowMs', 'maxAgeMs']) &&
    typeof policy.nowMs === 'number' &&
    Number.isFinite(policy.nowMs) &&
    policy.nowMs >= 0 &&
    typeof policy.maxAgeMs === 'number' &&
    Number.isFinite(policy.maxAgeMs) &&
    policy.maxAgeMs >= 0
  );
}

// 요청에 연결된 관측 형식 검사
function isObservation(value: unknown): value is RecognitionObservation {
  if (
    !hasFields(value, ['requestId', 'observedAtMs', 'result']) ||
    !validText(value.requestId) ||
    typeof value.observedAtMs !== 'number' ||
    !Number.isFinite(value.observedAtMs) ||
    value.observedAtMs < 0 ||
    !hasFields(value.result, ['kind', 'app', 'window', 'ambiguous'], ['kind'])
  )
    return false;
  const result = value.result;
  if (result.kind !== 'observed') {
    return (
      typeof result.kind === 'string' &&
      (FAILURE_REASONS.has(result.kind) || result.kind === 'unclassified-error') &&
      Reflect.ownKeys(result).length === 1
    );
  }
  return (
    Object.hasOwn(result, 'app') &&
    isAppSelector(result.app) &&
    (!Object.hasOwn(result, 'window') || isWindowSelector(result.window)) &&
    (!Object.hasOwn(result, 'ambiguous') || typeof result.ambiguous === 'boolean')
  );
}

// 비교할 수 없는 관측 결과 구성
function unknown(reason: UnknownReason, basis: ComparisonBasis[] = []): RecognitionResult {
  return { status: 'unknown', reason, basis };
}

// 선택 조건의 종류에 맞춰 값 비교
function equalSelector(expected: AppSelector | WindowSelector, observed: AppSelector | WindowSelector): boolean {
  return expected.kind === 'app-name' || expected.kind === 'window-title'
    ? expected.value.normalize('NFC') === observed.value.normalize('NFC')
    : expected.value === observed.value;
}

// 현재 요청의 관측 근거로 인식 실패 구분
export function classifyRecognition(
  request: unknown,
  observation: unknown,
  policy: RecognitionPolicy,
): RecognitionResult {
  if (!validRequestPolicy(request, policy) || !isObservation(observation)) return unknown('invalid-evidence');
  if (request.requestId !== observation.requestId) return unknown('different-request');
  if (observation.observedAtMs > policy.nowMs) return unknown('future-observation');
  if (policy.nowMs - observation.observedAtMs > policy.maxAgeMs) return unknown('stale-observation');
  const result = observation.result;
  if (result.kind === 'unclassified-error') return unknown('unclassified-error');
  if (result.kind !== 'observed') {
    if (result.kind === 'window-not-found' && request.window === undefined) return unknown('invalid-evidence');
    return { status: 'failed', reason: result.kind, basis: [] };
  }
  if (result.ambiguous) return unknown('ambiguous-target');
  if (request.app.kind !== result.app.kind) return unknown('incomparable-app-selector');
  const basis: ComparisonBasis[] = [request.app.kind];
  if (!equalSelector(request.app, result.app)) return { status: 'failed', reason: 'app-selector-mismatch', basis };
  if (request.window === undefined) return { status: 'matched', reason: 'app-selector-matched', basis };
  if (result.window === undefined) return unknown('window-unobserved', basis);
  if (request.window.kind !== result.window.kind) return unknown('incomparable-window-selector', basis);
  if (request.window.kind === 'window-id' && result.window.kind === 'window-id') {
    if (request.app.kind !== 'bundle-id') return unknown('insufficient-app-identity', basis);
    if (request.window.namespace !== result.window.namespace) return unknown('incomparable-window-selector', basis);
  }
  basis.push(request.window.kind);
  return equalSelector(request.window, result.window)
    ? { status: 'matched', reason: 'window-selector-matched', basis }
    : { status: 'failed', reason: 'window-selector-mismatch', basis };
}
