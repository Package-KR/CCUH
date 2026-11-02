// 대상 재확인 도우미 구성
var ccuh = (() => {
  const classifyExports = {};
  ((exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyRecognition = classifyRecognition;
const FAILURE_REASONS = new Set(['access-denied', 'app-not-found', 'window-not-found', 'reference-invalid']);
// 필수 자체 데이터 필드를 가진 일반 객체 판별
function hasFields(value, keys, required = keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    return (Reflect.ownKeys(fields).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(fields[key], 'value')) && required.every(key => Object.hasOwn(fields, key)));
}
// 비어 있지 않은 식별 문자열 검사
function validText(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}
// 앱 선택 조건 검사
function isAppSelector(value) {
    return (hasFields(value, ['kind', 'value']) &&
        (value.kind === 'bundle-id' || value.kind === 'app-name') &&
        validText(value.value));
}
// 창 선택 조건과 식별자 범위 검사
function isWindowSelector(value) {
    if (!hasFields(value, ['kind', 'value', 'namespace'], ['kind', 'value']) || !validText(value.value))
        return false;
    return value.kind === 'window-id'
        ? validText(value.namespace)
        : value.kind === 'window-title' && !Object.hasOwn(value, 'namespace');
}
// 대상 요청과 비교 정책 검사
function validRequestPolicy(request, policy) {
    return (hasFields(request, ['requestId', 'app', 'window'], ['requestId', 'app']) &&
        validText(request.requestId) &&
        isAppSelector(request.app) &&
        (!Object.hasOwn(request, 'window') || isWindowSelector(request.window)) &&
        hasFields(policy, ['nowMs', 'maxAgeMs']) &&
        typeof policy.nowMs === 'number' &&
        Number.isFinite(policy.nowMs) &&
        policy.nowMs >= 0 &&
        typeof policy.maxAgeMs === 'number' &&
        Number.isFinite(policy.maxAgeMs) &&
        policy.maxAgeMs >= 0);
}
// 요청에 연결된 관측 형식 검사
function isObservation(value) {
    if (!hasFields(value, ['requestId', 'observedAtMs', 'result']) ||
        !validText(value.requestId) ||
        typeof value.observedAtMs !== 'number' ||
        !Number.isFinite(value.observedAtMs) ||
        value.observedAtMs < 0 ||
        !hasFields(value.result, ['kind', 'app', 'window', 'ambiguous'], ['kind']))
        return false;
    const result = value.result;
    if (result.kind !== 'observed') {
        return (typeof result.kind === 'string' &&
            (FAILURE_REASONS.has(result.kind) || result.kind === 'unclassified-error') &&
            Reflect.ownKeys(result).length === 1);
    }
    return (Object.hasOwn(result, 'app') &&
        isAppSelector(result.app) &&
        (!Object.hasOwn(result, 'window') || isWindowSelector(result.window)) &&
        (!Object.hasOwn(result, 'ambiguous') || typeof result.ambiguous === 'boolean'));
}
// 비교할 수 없는 관측 결과 구성
function unknown(reason, basis = []) {
    return { status: 'unknown', reason, basis };
}
// 선택 조건의 종류에 맞춰 값 비교
function equalSelector(expected, observed) {
    return expected.kind === 'app-name' || expected.kind === 'window-title'
        ? expected.value.normalize('NFC') === observed.value.normalize('NFC')
        : expected.value === observed.value;
}
// 현재 요청의 관측 근거로 인식 실패 구분
function classifyRecognition(request, observation, policy) {
    if (!validRequestPolicy(request, policy) || !isObservation(observation))
        return unknown('invalid-evidence');
    if (request.requestId !== observation.requestId)
        return unknown('different-request');
    if (observation.observedAtMs > policy.nowMs)
        return unknown('future-observation');
    if (policy.nowMs - observation.observedAtMs > policy.maxAgeMs)
        return unknown('stale-observation');
    const result = observation.result;
    if (result.kind === 'unclassified-error')
        return unknown('unclassified-error');
    if (result.kind !== 'observed') {
        if (result.kind === 'window-not-found' && request.window === undefined)
            return unknown('invalid-evidence');
        return { status: 'failed', reason: result.kind, basis: [] };
    }
    if (result.ambiguous)
        return unknown('ambiguous-target');
    if (request.app.kind !== result.app.kind)
        return unknown('incomparable-app-selector');
    const basis = [request.app.kind];
    if (!equalSelector(request.app, result.app))
        return { status: 'failed', reason: 'app-selector-mismatch', basis };
    if (request.window === undefined)
        return { status: 'matched', reason: 'app-selector-matched', basis };
    if (result.window === undefined)
        return unknown('window-unobserved', basis);
    if (request.window.kind !== result.window.kind)
        return unknown('incomparable-window-selector', basis);
    if (request.window.kind === 'window-id' && result.window.kind === 'window-id') {
        if (request.app.kind !== 'bundle-id')
            return unknown('insufficient-app-identity', basis);
        if (request.window.namespace !== result.window.namespace)
            return unknown('incomparable-window-selector', basis);
    }
    basis.push(request.window.kind);
    return equalSelector(request.window, result.window)
        ? { status: 'matched', reason: 'window-selector-matched', basis }
        : { status: 'failed', reason: 'window-selector-mismatch', basis };
}
  })(classifyExports);
  const guardExports = {};
  // 허용된 로컬 분류 모듈 제공
  function requireLocalModule(name) {
    if (name !== './classify.ts') throw new Error('Unsupported CCUH runtime module');
    return classifyExports;
  }
  ((exports, require) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTarget = createTarget;
exports.prepareTarget = prepareTarget;
exports.withTarget = withTarget;
exports.selectWindowFromMenu = selectWindowFromMenu;
const classify_ts_1 = require("./classify.ts");
const targets = new WeakMap();
const busyApps = new WeakSet();
// 유효한 대상 식별 문자열 검사
function validText(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}
// 분류할 수 없는 관측 요약 구성
function unknown(reason) {
    return { status: 'unknown', reason, basis: [] };
}
// 전체 스냅샷의 첫 창 헤더 추출
function readHeader(state) {
    const match = /^Window: "(.*)", App: ([^\r\n]+)\.$/u.exec(state.split(/\r?\n/u, 1)[0] ?? '');
    return match && validText(match[1]) && validText(match[2]) ? { window: match[1], app: match[2] } : undefined;
}
// 정규화된 표시 이름 비교
function equalText(left, right) {
    return left.normalize('NFC') === right.normalize('NFC');
}
// 같은 공식 앱 핸들의 최신 대상 분류
async function observeTarget(target) {
    try {
        const state = await target.app.getAXState({ disableDiffing: true, emit: false });
        const observedAtMs = Date.now();
        const header = typeof state === 'string' ? readHeader(state) : undefined;
        if (!header)
            return { recognition: unknown('invalid-evidence') };
        return {
            state,
            recognition: (0, classify_ts_1.classifyRecognition)(target.expected, {
                requestId: target.expected.requestId,
                observedAtMs,
                result: {
                    kind: 'observed',
                    app: { kind: 'app-name', value: header.app },
                    window: { kind: 'window-title', value: header.window },
                },
            }, { nowMs: Date.now(), maxAgeMs: target.maxAgeMs }),
        };
    }
    catch {
        return { recognition: unknown('unclassified-error') };
    }
}
// 창 불일치에 한정한 한 번의 재선택
async function prepare(target) {
    let observation = await observeTarget(target);
    let recoveryAttempts = 0;
    let recovered = false;
    if (observation.recognition.status === 'failed' &&
        observation.recognition.reason === 'window-selector-mismatch' &&
        target.reselect &&
        observation.state !== undefined) {
        recoveryAttempts = 1;
        try {
            const selected = await target.reselect({ app: target.app, state: observation.state });
            observation = await observeTarget(target);
            recovered = selected === true && observation.recognition.status === 'matched';
        }
        catch {
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
function blocked(reason) {
    return { status: 'blocked', recognition: unknown(reason), recoveryAttempts: 0, recovered: false };
}
// 호출자가 받은 공식 앱 핸들과 고정 대상 등록
function createTarget(options) {
    if (!options ||
        typeof options.app !== 'object' ||
        options.app === null ||
        typeof options.app.getAXState !== 'function' ||
        typeof options.app.click !== 'function' ||
        !validText(options.requestId) ||
        !validText(options.appName) ||
        (options.windowTitle !== undefined && !validText(options.windowTitle)) ||
        !Number.isFinite(options.maxAgeMs) ||
        options.maxAgeMs < 0 ||
        (options.reselect !== undefined && typeof options.reselect !== 'function'))
        throw new TypeError('A valid official App handle and target options are required.');
    const token = Object.freeze({});
    const expected = Object.freeze({
        requestId: options.requestId,
        app: Object.freeze({ kind: 'app-name', value: options.appName }),
        ...(options.windowTitle === undefined
            ? {}
            : { window: Object.freeze({ kind: 'window-title', value: options.windowTitle }) }),
    });
    targets.set(token, Object.freeze({ app: options.app, expected, maxAgeMs: options.maxAgeMs, reselect: options.reselect }));
    return token;
}
// 대상 재확인과 제한된 복구 결과 조회
async function prepareTarget(token) {
    const target = targets.get(token);
    if (!target)
        return blocked('invalid-evidence');
    if (busyApps.has(target.app))
        return blocked('unclassified-error');
    busyApps.add(target.app);
    try {
        return (await prepare(target)).summary;
    }
    finally {
        busyApps.delete(target.app);
    }
}
// 최신 대상 확인 후 작업 한 번 실행
async function withTarget(token, action) {
    const target = targets.get(token);
    if (!target)
        return blocked('invalid-evidence');
    if (busyApps.has(target.app))
        return blocked('unclassified-error');
    busyApps.add(target.app);
    try {
        const { summary, state } = await prepare(target);
        if (summary.status !== 'ready' || state === undefined)
            return { ...summary, status: 'blocked' };
        const value = await action({ app: target.app, state });
        const observation = await observeTarget(target);
        return {
            ...summary,
            status: 'executed',
            recognition: observation.recognition,
            ...(value === undefined ? {} : { value }),
        };
    }
    finally {
        busyApps.delete(target.app);
    }
}
// 전체 접근성 스냅샷의 메뉴 행 추출
function readMenuRows(state) {
    return state.split(/\r?\n/u).flatMap(line => {
        const row = /^(\s*)(\d+)\s+(.+)$/u.exec(line);
        if (!row)
            return [];
        const metadata = /(?:,\s*|\s+)(?:ID|Secondary Actions|Value|Description|Help):/u.exec(row[3]);
        const id = /(?:,\s*|\s+)ID: ([^,]+)(?:,|$)/u.exec(row[3])?.[1]?.trim();
        return [{ index: Number(row[2]), depth: row[1].length, label: row[3].slice(0, metadata?.index).trim(), id }];
    });
}
// 메뉴 모음의 유일한 직계 메뉴 항목 확인
function menuEntry(rows, name) {
    const bars = rows.filter(row => row.label === 'menu bar');
    if (bars.length !== 1)
        return undefined;
    const start = rows.indexOf(bars[0]);
    const children = [];
    for (let index = start + 1; index < rows.length && rows[index].depth > bars[0].depth; index++) {
        const row = rows[index];
        if (index === start + 1 || row.depth <= children[0]?.depth)
            children.push(row);
    }
    const matches = children.filter(row => equalText(row.label, name));
    return matches.length === 1 ? matches[0] : undefined;
}
// 공식 창 메뉴에서 유일한 대상 선택 요청
async function selectWindowFromMenu({ app, state }, menuName, title) {
    if (!validText(menuName) || !validText(title))
        return false;
    const initial = readHeader(state);
    const menu = menuEntry(readMenuRows(state), menuName);
    if (!initial || !menu)
        return false;
    try {
        await app.click(menu.index);
        const popup = await app.getAXState({ disableDiffing: true, emit: false });
        const header = readHeader(popup);
        const rows = readMenuRows(popup);
        const root = rows[0];
        if (!header || !equalText(initial.app, header.app) || !root || !equalText(root.label, menuName))
            return false;
        const end = rows.findIndex((row, index) => index > 0 && row.depth <= root.depth);
        const matches = rows
            .slice(1, end === -1 ? undefined : end)
            .filter(row => row.id === 'makeKeyAndOrderFront:' && equalText(row.label, title));
        if (matches.length !== 1)
            return false;
        await app.click(matches[0].index);
        return true;
    }
    catch {
        return false;
    }
}
  })(guardExports, requireLocalModule);
  return Object.freeze({ ...guardExports, sourceHash: '1ab7d4879e9a82a8eae75a1c8ba671b2107ea226b261fa695ae79b36722071de' });
})();
