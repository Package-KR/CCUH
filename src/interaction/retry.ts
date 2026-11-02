export type DraftReplaceEvidence =
  | { kind: 'unavailable'; reason: 'target-unconfirmed' | 'field-unconfirmed' | 'invocation-error' }
  | {
      kind: 'observed';
      value: 'desired' | 'initial' | 'unexpected';
      reference: 'invalid' | 'unchanged' | 'changed';
    };

export type DraftReplaceDecision =
  | { decision: 'set'; attempt: 1 | 2 }
  | {
      decision: 'stop';
      reason:
        | 'already-desired'
        | 'target-unconfirmed'
        | 'field-unconfirmed'
        | 'invocation-error'
        | 'unexpected-value'
        | 'invalid-reference'
        | 'unchanged-reference'
        | 'attempt-limit';
    };

// 새 관측과 참조에 따른 초안 값 교체 시도 판단
export function decideDraftReplace(attempts: 0 | 1 | 2, evidence: DraftReplaceEvidence): DraftReplaceDecision {
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
