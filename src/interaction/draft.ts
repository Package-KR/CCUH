import { decideDraftReplace } from './retry.ts';
import { splitAXSelection } from '../common/snapshot.ts';

import type { DraftReplaceDecision, DraftReplaceEvidence } from './retry.ts';
import type { RecognitionResult } from '../recognition/classify.ts';

export type DraftValueOptions = {
  effect: 'local-draft';
  fieldId: string;
  value: string;
  readValue: (context: { row: string; state: string }) => string | undefined;
};
export type DraftObservation = { recognition: RecognitionResult; state?: string };
export type DraftValueReason =
  | Extract<DraftReplaceDecision, { decision: 'stop' }>['reason']
  | 'invalid-options'
  | 'app-busy';
export type DraftValueResult = {
  status: 'observed' | 'blocked' | 'stopped';
  reason: DraftValueReason;
  attempts: 0 | 1 | 2;
  lastInvocation: 'not-attempted' | 'returned' | 'threw';
  observedValue: 'desired' | 'initial' | 'unexpected' | 'unavailable';
  recognition: RecognitionResult;
};
type DraftRuntime = {
  setValue: (index: number, value: string) => Promise<unknown>;
  observe: () => Promise<DraftObservation>;
};
type DraftFrame = {
  observation: DraftObservation;
  evidence: DraftReplaceEvidence;
  field?: { index: number; value: string };
};

// 최신 스냅샷의 유일한 편집 가능 필드 확인
function readField(state: string, options: DraftValueOptions): DraftFrame['field'] {
  const sections = splitAXSelection(state.split(/\r?\n/u));
  if (!sections) return;
  const entries = sections.tree.flatMap(row => {
    const entry = /^\s*(\d+)\s+(.+)$/u.exec(row);
    if (!entry) return [];
    const ids = [...entry[2].matchAll(/(?:^|,\s*|\s+)ID: ([^,]+)(?=,|$)/gu)];
    const metadata = /(?:^|,\s*|\s+)(?:Value|Description|Help|ID|Secondary Actions):/u.exec(entry[2]);
    const attributes = entry[2].slice(0, metadata?.index);
    return [{ index: Number(entry[1]), body: entry[2], row, ids, attributes }];
  });
  const selected = sections.selected;
  if (selected && !entries.some(entry => entry.index === selected.index && entry.body === selected.body)) return;
  const rows = entries.filter(entry => entry.ids.some(id => id[1].trim() === options.fieldId));
  if (rows.length !== 1) return;
  const field =
    /^(?:text field|text entry area|text entry|텍스트 필드|텍스트 엔트리 영역) \(([^()]*)\)(?:\s|,|$)/u.exec(
      rows[0].attributes,
    );
  const fieldAttributes = field?.[1].split(',').map(attribute => attribute.trim()) ?? [];
  if (
    rows[0].ids.length !== 1 ||
    (rows[0].ids[0].index !== 0 && !rows[0].ids[0][0].startsWith(',')) ||
    !fieldAttributes.includes('settable') ||
    fieldAttributes.includes('disabled') ||
    !Number.isSafeInteger(rows[0].index) ||
    entries.filter(entry => entry.index === rows[0].index).length !== 1
  )
    return;
  try {
    const value = options.readValue({ row: rows[0].row, state });
    if (typeof value === 'string') return { index: rows[0].index, value };
  } catch {
    return;
  }
}

// 현재 값과 참조를 원래 초안에 대조
function inspectFrame(
  observation: DraftObservation,
  options: DraftValueOptions,
  baseline?: string,
  firstIndex?: number,
): DraftFrame {
  if (observation.recognition.status !== 'matched' || observation.state === undefined) {
    return { observation, evidence: { kind: 'unavailable', reason: 'target-unconfirmed' } };
  }
  const field = readField(observation.state, options);
  if (!field) return { observation, evidence: { kind: 'unavailable', reason: 'field-unconfirmed' } };
  return {
    observation,
    field,
    evidence: {
      kind: 'observed',
      value:
        field.value === options.value
          ? 'desired'
          : baseline === undefined || field.value === baseline
            ? 'initial'
            : 'unexpected',
      reference: firstIndex === undefined || field.index === firstIndex ? 'unchanged' : 'changed',
    },
  };
}

// UI 원문을 제외한 초안 처리 결과 구성
function summarize(
  frame: DraftFrame,
  reason: DraftValueReason,
  attempts: DraftValueResult['attempts'],
  lastInvocation: DraftValueResult['lastInvocation'],
): DraftValueResult {
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
function decideNext(
  frame: DraftFrame,
  attempts: DraftValueResult['attempts'],
  lastInvocation: DraftValueResult['lastInvocation'],
): DraftReplaceDecision {
  return decideDraftReplace(
    attempts,
    lastInvocation === 'threw' ? { kind: 'unavailable', reason: 'invocation-error' } : frame.evidence,
  );
}

// 같은 공식 앱에서 로컬 초안 교체를 최대 두 번 수행
export async function runDraftValue(
  initial: DraftObservation,
  runtime: DraftRuntime,
  options: DraftValueOptions,
): Promise<DraftValueResult> {
  let frame = inspectFrame(initial, options);
  const baseline = frame.field?.value;
  let firstIndex: number | undefined;
  let attempts: DraftValueResult['attempts'] = 0;
  let lastInvocation: DraftValueResult['lastInvocation'] = 'not-attempted';
  let decision = decideNext(frame, attempts, lastInvocation);

  // 같은 공식 앱의 재관측 실패를 미확인으로 변환
  async function observe(): Promise<DraftObservation> {
    try {
      return await runtime.observe();
    } catch {
      return { recognition: { status: 'unknown', reason: 'unclassified-error', basis: [] } };
    }
  }

  while (decision.decision === 'set') {
    if (attempts > 0) {
      frame = inspectFrame(await observe(), options, baseline, firstIndex);
      decision = decideNext(frame, attempts, lastInvocation);
      if (decision.decision === 'stop') break;
    }
    if (!frame.field) return summarize(frame, 'field-unconfirmed', attempts, lastInvocation);
    firstIndex ??= frame.field.index;
    attempts = decision.attempt;
    lastInvocation = 'returned';
    try {
      await runtime.setValue(frame.field.index, options.value);
    } catch {
      lastInvocation = 'threw';
    }
    frame = inspectFrame(await observe(), options, baseline, firstIndex);
    decision = decideNext(frame, attempts, lastInvocation);
  }
  return summarize(frame, decision.reason, attempts, lastInvocation);
}
