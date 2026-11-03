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
  const outcomeExports = {};
  ((exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyActionOutcome = classifyActionOutcome;
// 호출 결과와 관측 증거를 분리한 동작 결과 분류
function classifyActionOutcome(invocation, evidence) {
    if (evidence.kind === 'unavailable') {
        return { invocation, status: 'unknown', reason: evidence.reason };
    }
    if (!evidence.changed) {
        return { invocation, status: 'not-observed', reason: 'no-observable-change' };
    }
    if (evidence.verdict === true) {
        return { invocation, status: 'confirmed', reason: 'postcondition-matched' };
    }
    if (evidence.verdict === false) {
        return { invocation, status: 'not-observed', reason: 'postcondition-not-observed' };
    }
    return { invocation, status: 'unknown', reason: 'verification-inconclusive' };
}
  })(outcomeExports);
  const retryExports = {};
  ((exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideDraftReplace = decideDraftReplace;
// 새 관측과 참조에 따른 초안 값 교체 시도 판단
function decideDraftReplace(attempts, evidence) {
    if (evidence.kind === 'unavailable') {
        return { decision: 'stop', reason: evidence.reason };
    }
    if (evidence.value === 'desired') {
        return { decision: 'stop', reason: 'already-desired' };
    }
    if (evidence.value === 'unexpected') {
        return { decision: 'stop', reason: 'unexpected-value' };
    }
    if (attempts === 2) {
        return { decision: 'stop', reason: 'attempt-limit' };
    }
    if (evidence.reference === 'invalid') {
        return { decision: 'stop', reason: 'invalid-reference' };
    }
    if (attempts === 1 && evidence.reference === 'unchanged') {
        return { decision: 'stop', reason: 'unchanged-reference' };
    }
    return { decision: 'set', attempt: attempts === 0 ? 1 : 2 };
}
  })(retryExports);
  const snapshotExports = {};
  ((exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitAXSelection = splitAXSelection;
const selectionNote = "Note: Pay special attention to the content selected by the user. If the user asks a question or refers to the content they are looking at on-screen, they might be referring to the selected content (but they might be referring to something else that's visible, too).";
// 렌더러의 선택 요약과 정확한 안내 접미부 분리
function splitAXSelection(lines) {
    const sections = lines.flatMap((line, index) => line === 'Selected:' || line === 'Selected text: ```' ? [index] : []);
    const prefix = sections.length === 1 ? lines.slice(0, sections[0]) : lines;
    if (sections.length > 1 || prefix.some(line => /^(?:Selected(?: text)?|Note):/u.test(line)))
        return;
    if (sections.length === 0)
        return { tree: lines };
    const remainder = lines.slice(sections[0] + 1);
    if (lines[sections[0]] === 'Selected text: ```') {
        const notes = remainder.slice(2).filter(line => line.trim() !== '');
        if (!remainder[0]?.trim() || remainder[1] !== '```' || notes.length !== 1 || notes[0] !== selectionNote)
            return;
        return { tree: prefix, selectedText: remainder[0] };
    }
    const suffix = remainder.filter(line => line.trim() !== '');
    if (suffix.length < 1 || suffix.length > 2 || (suffix.length === 2 && suffix[1] !== selectionNote))
        return;
    const selected = /^[ \t]*(\d+) (.+)$/u.exec(suffix[0]);
    if (!selected || !Number.isSafeInteger(Number(selected[1])))
        return;
    return { tree: prefix, selected: { index: Number(selected[1]), body: selected[2] } };
}
  })(snapshotExports);
  const draftExports = {};
  // 초안 처리의 순수 로컬 모듈 제공
  function requireDraftModule(name) {
    if (name === './retry.ts') return retryExports;
    if (name === '../common/snapshot.ts') return snapshotExports;
    throw new Error('Unsupported CCUH runtime module');
  }
  ((exports, require) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDraftValue = runDraftValue;
const retry_ts_1 = require("./retry.ts");
const snapshot_ts_1 = require("../common/snapshot.ts");
// 최신 스냅샷의 유일한 편집 가능 필드 확인
function readField(state, options) {
    const sections = (0, snapshot_ts_1.splitAXSelection)(state.split(/\r?\n/u));
    if (!sections)
        return;
    const entries = sections.tree.flatMap(row => {
        const entry = /^\s*(\d+)\s+(.+)$/u.exec(row);
        if (!entry)
            return [];
        const ids = [...entry[2].matchAll(/(?:^|,\s*|\s+)ID: ([^,]+)(?=,|$)/gu)];
        const metadata = /(?:^|,\s*|\s+)(?:Value|Description|Help|ID|Secondary Actions):/u.exec(entry[2]);
        const attributes = entry[2].slice(0, metadata?.index);
        return [{ index: Number(entry[1]), body: entry[2], row, ids, attributes }];
    });
    const selected = sections.selected;
    if (selected && !entries.some(entry => entry.index === selected.index && entry.body === selected.body))
        return;
    const rows = entries.filter(entry => entry.ids.some(id => id[1].trim() === options.fieldId));
    if (rows.length !== 1)
        return;
    const field = /^(?:text field|text entry area|text entry|텍스트 필드|텍스트 엔트리 영역) \(([^()]*)\)(?:\s|,|$)/u.exec(rows[0].attributes);
    if (rows[0].ids.length !== 1 ||
        (rows[0].ids[0].index !== 0 && !rows[0].ids[0][0].startsWith(',')) ||
        !field?.[1].split(',').some(attribute => attribute.trim() === 'settable') ||
        !Number.isSafeInteger(rows[0].index) ||
        entries.filter(entry => entry.index === rows[0].index).length !== 1)
        return;
    try {
        const value = options.readValue({ row: rows[0].row, state });
        if (typeof value === 'string')
            return { index: rows[0].index, value };
    }
    catch {
        return;
    }
}
// 현재 값과 참조를 원래 초안에 대조
function inspectFrame(observation, options, baseline, firstIndex) {
    if (observation.recognition.status !== 'matched' || observation.state === undefined) {
        return { observation, evidence: { kind: 'unavailable', reason: 'target-unconfirmed' } };
    }
    const field = readField(observation.state, options);
    if (!field)
        return { observation, evidence: { kind: 'unavailable', reason: 'field-unconfirmed' } };
    return {
        observation,
        field,
        evidence: {
            kind: 'observed',
            value: field.value === options.value
                ? 'desired'
                : baseline === undefined || field.value === baseline
                    ? 'initial'
                    : 'unexpected',
            reference: firstIndex === undefined || field.index === firstIndex ? 'unchanged' : 'changed',
        },
    };
}
// UI 원문을 제외한 초안 처리 결과 구성
function summarize(frame, reason, attempts, lastInvocation) {
    return {
        status: reason === 'already-desired' ? 'observed' : attempts === 0 ? 'blocked' : 'stopped',
        reason,
        attempts,
        lastInvocation,
        observedValue: frame.evidence.kind === 'observed' ? frame.evidence.value : 'unavailable',
        recognition: frame.observation.recognition,
    };
}
// 예외가 있었던 입력의 자동 반복 차단
function decideNext(frame, attempts, lastInvocation) {
    return (0, retry_ts_1.decideDraftReplace)(attempts, lastInvocation === 'threw' ? { kind: 'unavailable', reason: 'invocation-error' } : frame.evidence);
}
// 같은 공식 앱에서 로컬 초안 교체를 최대 두 번 수행
async function runDraftValue(initial, runtime, options) {
    let frame = inspectFrame(initial, options);
    const baseline = frame.field?.value;
    let firstIndex;
    let attempts = 0;
    let lastInvocation = 'not-attempted';
    let decision = decideNext(frame, attempts, lastInvocation);
    // 같은 공식 앱의 재관측 실패를 미확인으로 변환
    async function observe() {
        try {
            return await runtime.observe();
        }
        catch {
            return { recognition: { status: 'unknown', reason: 'unclassified-error', basis: [] } };
        }
    }
    while (decision.decision === 'set') {
        if (attempts > 0) {
            frame = inspectFrame(await observe(), options, baseline, firstIndex);
            decision = decideNext(frame, attempts, lastInvocation);
            if (decision.decision === 'stop')
                break;
        }
        if (!frame.field)
            return summarize(frame, 'field-unconfirmed', attempts, lastInvocation);
        firstIndex ??= frame.field.index;
        attempts = decision.attempt;
        lastInvocation = 'returned';
        try {
            await runtime.setValue(frame.field.index, options.value);
        }
        catch {
            lastInvocation = 'threw';
        }
        frame = inspectFrame(await observe(), options, baseline, firstIndex);
        decision = decideNext(frame, attempts, lastInvocation);
    }
    return summarize(frame, decision.reason, attempts, lastInvocation);
}
  })(draftExports, requireDraftModule);
  const transitionExports = {};
  // 모달 판정의 순수 스냅샷 모듈 제공
  function requireTransitionModule(name) {
    if (name !== '../common/snapshot.ts') throw new Error('Unsupported CCUH runtime module');
    return snapshotExports;
  }
  ((exports, require) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyModalDismissal = verifyModalDismissal;
const snapshot_ts_1 = require("../common/snapshot.ts");
const roles = ['standard window', '표준 윈도우', '대화상자', 'dialog', 'sheet', '시트', 'window', '윈도우'];
// 필수 자체 값 필드를 가진 일반 객체 검사
function hasDataFields(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (Reflect.ownKeys(descriptors).length === keys.length &&
        keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')));
}
// 제어 문자가 없는 관측 조건 문자열 검사
function validText(value) {
    return (typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
// 명시한 컨테이너 역할과 식별자 검사
function validRoot(value) {
    return (hasDataFields(value, ['role', 'id']) &&
        typeof value.role === 'string' &&
        roles.includes(value.role) &&
        validText(value.id));
}
// 종료 전 모달과 기대 부모 조건 검사
function validOptions(value) {
    if (!hasDataFields(value, ['appName', 'modal', 'parent']) || !validText(value.appName) || !validRoot(value.modal)) {
        return false;
    }
    const parent = value.parent;
    if (hasDataFields(parent, ['kind', 'title']))
        return parent.kind === 'window-title' && validText(parent.title);
    return (hasDataFields(parent, ['kind', 'role', 'id']) &&
        parent.kind === 'root-id' &&
        typeof parent.role === 'string' &&
        roles.includes(parent.role) &&
        validText(parent.id) &&
        parent.id !== value.modal.id);
}
// 관측한 표시 문자열의 정규화된 일치 확인
function sameText(left, right) {
    return left.normalize('NFC') === right.normalize('NFC');
}
// 본문 메타데이터를 제외한 컨테이너 행 판독
function readContainer(row) {
    const role = roles.find(value => row.body === value || row.body.startsWith(value + ' '));
    if (!role)
        return null;
    const tail = row.body.slice(role.length).trimStart();
    if (/(?:^|,\s*|\s+)(?:Value|Description|Help):/u.test(tail))
        return;
    const metadata = /(?:^|,\s*|\s+)(ID|URL|Secondary Actions):/u.exec(tail);
    const ids = [...tail.matchAll(/(?:^|,\s*|\s+)ID: ([^,]+)(?=,|$)/gu)];
    if (ids.length > 1 ||
        (ids.length === 1 &&
            (!metadata ||
                metadata[1] !== 'ID' ||
                ids[0].index !== metadata.index ||
                (metadata.index !== 0 && !metadata[0].startsWith(',')) ||
                !validText(ids[0][1].trim()))))
        return;
    return {
        index: row.index,
        depth: row.depth,
        role: role,
        name: tail.slice(0, metadata?.index).trim(),
        ...(ids.length === 1 ? { id: ids[0][1].trim() } : {}),
    };
}
// 편집 가능한 한 줄 텍스트 필드의 값 판독
function readEditableValue(body) {
    const field = /^(?:텍스트 필드|text field) \(([^()]*)\) (.+)$/u.exec(body);
    if (!field || !field[1].split(/,\s*/u).includes('settable'))
        return;
    const metadata = field[2];
    if (/(?:^|,\s*|\s+)(?:Description|Help|URL|Secondary Actions):/u.test(metadata))
        return;
    const values = [...metadata.matchAll(/(?:^|,\s*|\s+)Value:/gu)];
    const ids = [...metadata.matchAll(/(?:^|,\s*|\s+)ID:/gu)];
    if (values.length !== 1 || ids.length > 1)
        return;
    if (ids.length === 0)
        return /^Value: (.+)$/u.exec(metadata)?.[1];
    const valueFirst = /^Value: (.+), ID: ([^,]+)$/u.exec(metadata);
    if (valueFirst && validText(valueFirst[2]))
        return valueFirst[1];
    const idFirst = /^ID: ([^,]+), Value: (.+)$/u.exec(metadata);
    return idFirst && validText(idFirst[1]) ? idFirst[2] : undefined;
}
// 같은 앱의 유일한 최상위 컨테이너 관측 판독
function readSnapshot(state) {
    const lines = state.split(/\r?\n/u);
    const header = /^Window: "(.*)", App: ([^\r\n]+)\.$/u.exec(lines[0] ?? '');
    if (!header || !validText(header[2]) || (header[1] !== '' && !validText(header[1])))
        return;
    if (lines.slice(1).some(line => /^Window:/u.test(line)))
        return;
    const sections = (0, snapshot_ts_1.splitAXSelection)(lines.slice(1));
    if (!sections)
        return;
    const content = sections.tree.filter(line => line.trim() !== '');
    const rows = content.map(line => /^([ \t]*)(\d+) (.+)$/u.exec(line));
    if (!rows[0] || rows.some((row, index) => !row && /^[ \t]*[-+]?\d/u.test(content[index])))
        return;
    const entries = rows.flatMap(row => (row ? [{ index: Number(row[2]), depth: row[1].length, body: row[3] }] : []));
    if (entries.some(row => !Number.isSafeInteger(row.index)) ||
        new Set(entries.map(row => row.index)).size !== entries.length)
        return;
    const selected = sections.selected;
    if (selected && !entries.some(row => row.index === selected.index && row.body === selected.body))
        return;
    const selectedText = sections.selectedText;
    if (selectedText !== undefined &&
        entries.filter(row => readEditableValue(row.body)?.includes(selectedText)).length !== 1)
        return;
    const parsed = entries.map(readContainer);
    if (parsed.some(row => row === undefined))
        return;
    const containers = parsed.filter((row) => row !== null && row !== undefined);
    const roots = containers.filter(row => row.depth === 0);
    const root = roots[0];
    if (roots.length !== 1 || !root || root.index !== entries[0].index || !sameText(root.name, header[1]))
        return;
    return { app: header[2], title: header[1], root, containers };
}
// 모달 소멸과 명시한 부모 복귀의 관측 결과 확인
function verifyModalDismissal(snapshots, options) {
    try {
        if (!hasDataFields(snapshots, ['before', 'after']) ||
            typeof snapshots.before !== 'string' ||
            typeof snapshots.after !== 'string' ||
            !validOptions(options))
            return 'unknown';
        const before = readSnapshot(snapshots.before);
        const after = readSnapshot(snapshots.after);
        if (!before || !after || !sameText(before.app, options.appName) || !sameText(after.app, options.appName))
            return 'unknown';
        const original = before.containers.filter(row => row.id === options.modal.id);
        if (original.length !== 1 || original[0] !== before.root || original[0].role !== options.modal.role)
            return 'unknown';
        const remaining = after.containers.filter(row => row.id === options.modal.id);
        if (remaining.length > 1 || remaining.some(row => row.role !== options.modal.role))
            return 'unknown';
        if (remaining.length === 1)
            return false;
        const parent = options.parent;
        if (parent.kind === 'window-title')
            return sameText(after.title, parent.title) ? true : 'unknown';
        const parents = after.containers.filter(row => row.id === parent.id);
        return parents.length === 1 && parents[0] === after.root && parents[0].role === parent.role ? true : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
  })(transitionExports, requireTransitionModule);
  const localModules = Object.freeze({ './classify.ts': classifyExports, '../interaction/outcome.ts': outcomeExports, '../interaction/draft.ts': draftExports, '../interaction/transition.ts': transitionExports });
  const guardExports = {};
  // 허용된 순수 로컬 모듈 제공
  function requireLocalModule(name) {
    if (!Object.hasOwn(localModules, name)) throw new Error('Unsupported CCUH runtime module');
    return localModules[name];
  }
  ((exports, require) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyModalDismissal = void 0;
exports.getMode = getMode;
exports.setMode = setMode;
exports.createTarget = createTarget;
exports.prepareTarget = prepareTarget;
exports.withTarget = withTarget;
exports.withVerifiedTarget = withVerifiedTarget;
exports.setDraftValue = setDraftValue;
exports.selectWindowFromMenu = selectWindowFromMenu;
const classify_ts_1 = require("./classify.ts");
const outcome_ts_1 = require("../interaction/outcome.ts");
const draft_ts_1 = require("../interaction/draft.ts");
var transition_ts_1 = require("../interaction/transition.ts");
Object.defineProperty(exports, "verifyModalDismissal", { enumerable: true, get: function () { return transition_ts_1.verifyModalDismissal; } });
const targets = new WeakMap();
const busyApps = new WeakSet();
let executionMode = 'background';
let activeOperations = 0;
// 현재 REPL의 실행 모드 조회
function getMode() {
    return executionMode;
}
// 진행 중인 작업을 보존하며 실행 모드 변경
function setMode(mode) {
    if (mode !== 'background' && mode !== 'visible') {
        throw new TypeError('A background or visible execution mode is required.');
    }
    if (mode === executionMode)
        return Object.freeze({ status: 'kept', mode: executionMode });
    if (activeOperations > 0) {
        return Object.freeze({ status: 'blocked', mode: executionMode, reason: 'operation-in-progress' });
    }
    executionMode = mode;
    return Object.freeze({ status: 'changed', mode: executionMode });
}
// 현재 모드와 대상별 창 올림 제한 확인
function windowRaiseAllowed(permission) {
    return executionMode === 'visible' && permission !== false;
}
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
    if (!match || !validText(match[2]) || (match[1] !== '' && !validText(match[1])))
        return;
    return { app: match[2], ...(match[1] === '' ? {} : { window: match[1] }) };
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
                    ...(header.window === undefined ? {} : { window: { kind: 'window-title', value: header.window } }),
                },
            }, { nowMs: Date.now(), maxAgeMs: target.maxAgeMs }),
        };
    }
    catch {
        return { recognition: unknown('unclassified-error') };
    }
}
// 확인한 앱의 창 조건에 한정한 한 번의 재선택
async function prepare(target) {
    let observation = await observeTarget(target);
    let recoveryAttempts = 0;
    let recovered = false;
    const menuTitle = target.windowMenu !== undefined && target.expected.window?.kind === 'window-title'
        ? target.expected.window.value
        : undefined;
    const windowMismatch = observation.recognition.status === 'failed' && observation.recognition.reason === 'window-selector-mismatch';
    const windowUnobserved = menuTitle !== undefined &&
        observation.recognition.status === 'unknown' &&
        observation.recognition.reason === 'window-unobserved' &&
        observation.recognition.basis.length === 1 &&
        observation.recognition.basis[0] === 'app-name';
    if ((windowMismatch || windowUnobserved) &&
        (target.reselect || menuTitle !== undefined) &&
        observation.state !== undefined) {
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
            const selected = target.windowMenu !== undefined && menuTitle !== undefined
                ? await selectWindowFromMenu(context, target.windowMenu, menuTitle)
                : await target.reselect?.(context);
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
        (options.reselect !== undefined && typeof options.reselect !== 'function') ||
        (options.allowWindowRaise !== undefined && typeof options.allowWindowRaise !== 'boolean') ||
        (options.windowMenu !== undefined &&
            (!validText(options.windowMenu) || options.windowTitle === undefined || options.reselect !== undefined)))
        throw new TypeError('A valid official App handle and target options are required.');
    const token = Object.freeze({});
    const expected = Object.freeze({
        requestId: options.requestId,
        app: Object.freeze({ kind: 'app-name', value: options.appName }),
        ...(options.windowTitle === undefined
            ? {}
            : { window: Object.freeze({ kind: 'window-title', value: options.windowTitle }) }),
    });
    targets.set(token, Object.freeze({
        app: options.app,
        expected,
        maxAgeMs: options.maxAgeMs,
        reselect: options.reselect,
        windowMenu: options.windowMenu,
        allowWindowRaise: options.allowWindowRaise,
    }));
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
    activeOperations += 1;
    try {
        return (await prepare(target)).summary;
    }
    finally {
        busyApps.delete(target.app);
        activeOperations -= 1;
    }
}
// 최신 대상 확인 후 작업 한 번 실행
async function withTarget(token, action) {
    const target = targets.get(token);
    if (!target || typeof action !== 'function')
        return blocked('invalid-evidence');
    if (busyApps.has(target.app))
        return blocked('unclassified-error');
    busyApps.add(target.app);
    activeOperations += 1;
    try {
        const { summary, state } = await prepare(target);
        if (summary.status !== 'ready' || state === undefined)
            return { ...summary, status: 'blocked' };
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
    }
    finally {
        busyApps.delete(target.app);
        activeOperations -= 1;
    }
}
// 작업 한 번 실행 후 같은 대상의 실제 변화 확인
async function withVerifiedTarget(token, action, verify) {
    const target = targets.get(token);
    if (!target || typeof action !== 'function' || typeof verify !== 'function')
        return blocked('invalid-evidence');
    if (busyApps.has(target.app))
        return blocked('unclassified-error');
    busyApps.add(target.app);
    activeOperations += 1;
    try {
        const { summary, state } = await prepare(target);
        if (summary.status !== 'ready' || state === undefined)
            return { ...summary, status: 'blocked' };
        let invocation = 'returned';
        let value;
        try {
            value = await action({ app: target.app, state, allowWindowRaise: windowRaiseAllowed(target.allowWindowRaise) });
        }
        catch {
            invocation = 'threw';
        }
        const observation = await observeTarget(target);
        let evidence = { kind: 'unavailable', reason: 'target-unconfirmed' };
        if (observation.recognition.status === 'matched' && observation.state !== undefined) {
            evidence = { kind: 'observed', changed: state !== observation.state, verdict: 'unknown' };
            if (evidence.changed) {
                try {
                    const verdict = await verify({ before: state, after: observation.state });
                    evidence.verdict = verdict === true || verdict === false ? verdict : 'unknown';
                }
                catch {
                    evidence = { kind: 'unavailable', reason: 'verification-threw' };
                }
            }
        }
        return {
            ...summary,
            status: 'checked',
            recognition: observation.recognition,
            outcome: (0, outcome_ts_1.classifyActionOutcome)(invocation, evidence),
            ...(invocation === 'returned' && value !== undefined ? { value } : {}),
        };
    }
    finally {
        busyApps.delete(target.app);
        activeOperations -= 1;
    }
}
// 명시한 로컬 초안 필드의 교체와 제한된 재시도
async function setDraftValue(token, options) {
    const target = targets.get(token);
    const initial = {
        status: 'blocked',
        reason: 'invalid-options',
        attempts: 0,
        lastInvocation: 'not-attempted',
        observedValue: 'unavailable',
        recognition: unknown('invalid-evidence'),
    };
    if (!target ||
        !options ||
        options.effect !== 'local-draft' ||
        !validText(options.fieldId) ||
        typeof options.value !== 'string' ||
        typeof options.readValue !== 'function' ||
        typeof target.app.setValue !== 'function')
        return initial;
    if (busyApps.has(target.app))
        return { ...initial, reason: 'app-busy', recognition: unknown('unclassified-error') };
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
        return await (0, draft_ts_1.runDraftValue)({ recognition: summary.recognition, state }, { setValue, observe: () => observeTarget(target) }, settings);
    }
    finally {
        busyApps.delete(target.app);
        activeOperations -= 1;
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
function isUniqueMenuReference(rows, index) {
    return Number.isSafeInteger(index) && index >= 0 && rows.filter(row => row.index === index).length === 1;
}
// 유일한 메뉴 모음의 직계 항목 조회
function menuBarEntries(rows) {
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
    return children;
}
// 메뉴 모음의 유일한 직계 메뉴 항목 확인
function menuEntry(rows, name) {
    const matches = menuBarEntries(rows)?.filter(row => equalText(row.label, name)) ?? [];
    return matches.length === 1 && isUniqueMenuReference(rows, matches[0].index) ? matches[0] : undefined;
}
// 단일 메뉴 팝업의 최상위 범위 확인
function menuPopupRoot(rows) {
    const root = rows[0];
    if (!root ||
        root.depth !== 0 ||
        root.contentMetadata ||
        rows.length < 2 ||
        !isUniqueMenuReference(rows, root.index) ||
        rows.slice(1).some(row => row.depth <= root.depth || row.label === 'menu bar'))
        return;
    return root;
}
// 확인한 창 메뉴 안의 고유한 대상 참조 조회
function windowMenuTarget(rows, menuName, title) {
    const root = menuPopupRoot(rows);
    if (!root || !equalText(root.label, menuName))
        return;
    const matches = rows.slice(1).filter(row => row.id === 'makeKeyAndOrderFront:' && equalText(row.label, title));
    return matches.length === 1 && isUniqueMenuReference(rows, matches[0].index) ? matches[0] : undefined;
}
// 직전 메뉴 모음에 속한 다른 팝업인지 확인
function isKnownOtherMenuPopup(rows, originalRows, menuName) {
    const root = menuPopupRoot(rows);
    if (!root || equalText(root.label, menuName))
        return false;
    return menuBarEntries(originalRows)?.filter(row => equalText(row.label, root.label)).length === 1;
}
// 공식 창 메뉴에서 유일한 대상 선택 요청
async function selectWindowFromMenu(context, menuName, title, observer) {
    const trace = {
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
    function complete(reason, result = false) {
        trace.reason = reason;
        return result;
    }
    // 원문 없는 팝업 구조와 대상 개수 요약
    function describeRows(rows) {
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
    function report() {
        if (typeof observer !== 'function')
            return;
        try {
            Promise.resolve(observer(Object.freeze({ ...trace }))).catch(() => { });
        }
        catch {
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
        if (!initial)
            return complete('initial-header-unconfirmed');
        const originalRows = readMenuRows(state);
        let menuRows = originalRows;
        let rows = originalRows;
        describeRows(rows);
        if (!rows[0] || !equalText(rows[0].label, menuName)) {
            trace.stage = 'menu-bar';
            trace.menuEntryCount = menuBarEntries(originalRows)?.filter(row => equalText(row.label, menuName)).length ?? 0;
            const initialMenu = menuEntry(originalRows, menuName);
            trace.menuRefUnique = initialMenu !== undefined;
            if (!initialMenu)
                return complete('menu-unconfirmed');
            trace.stage = 'menu-confirmation';
            trace.confirmationReadCount = 1;
            const confirmation = await app.getAXState({ disableDiffing: true, emit: false });
            const confirmedHeader = typeof confirmation === 'string' ? readHeader(confirmation) : undefined;
            if (!confirmedHeader)
                return complete('menu-confirmation-header-unconfirmed');
            if (!equalText(initial.app, confirmedHeader.app))
                return complete('app-mismatch');
            if (!equalText(initial.window ?? '', confirmedHeader.window ?? '')) {
                return complete('menu-confirmation-window-mismatch');
            }
            menuRows = readMenuRows(confirmation);
            rows = menuRows;
            describeRows(rows);
            trace.menuEntryCount = menuBarEntries(menuRows)?.filter(row => equalText(row.label, menuName)).length ?? 0;
            const menu = menuEntry(menuRows, menuName);
            trace.menuRefUnique = menu !== undefined;
            if (!menu)
                return complete('menu-unconfirmed');
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
            if (!header)
                return complete('popup-header-unconfirmed');
            if (!equalText(initial.app, header.app))
                return complete('app-mismatch');
            if (isKnownOtherMenuPopup(rows, menuRows, menuName)) {
                trace.stage = 'popup-observation';
                trace.refreshCount = 2;
                describeRows([]);
                popup = await app.getAXState({ disableDiffing: true, emit: false });
                trace.stage = 'popup-validation';
                rows = readMenuRows(popup);
                describeRows(rows);
                header = readHeader(popup);
                if (!header)
                    return complete('popup-header-unconfirmed');
                if (!equalText(initial.app, header.app))
                    return complete('app-mismatch');
            }
        }
        trace.stage = 'popup-validation';
        const root = menuPopupRoot(rows);
        if (!root || !equalText(root.label, menuName))
            return complete('popup-unconfirmed');
        const target = windowMenuTarget(rows, menuName, title);
        if (!target)
            return complete('target-unconfirmed');
        trace.stage = 'target-click';
        if (executionMode !== 'visible' || context.allowWindowRaise !== true) {
            return complete('window-raise-not-authorized');
        }
        trace.targetClickAttempted = true;
        await app.click(target.index);
        return complete('selection-requested', true);
    }
    catch {
        return complete(trace.stage === 'menu-confirmation'
            ? 'menu-confirmation-threw'
            : trace.stage === 'menu-open'
                ? 'menu-open-threw'
                : trace.stage === 'popup-observation'
                    ? 'observation-threw'
                    : trace.stage === 'target-click'
                        ? 'target-click-threw'
                        : 'operation-threw');
    }
    finally {
        report();
        activeOperations -= 1;
    }
}
  })(guardExports, requireLocalModule);
  return Object.freeze({ ...guardExports, sourceHash: '98b85894efdf719060bf6f398c25fdc598573a55855728bb33da9c53094d18b2' });
})();
