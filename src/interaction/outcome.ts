export type ActionInvocation = 'returned' | 'threw';

export type VerificationVerdict = true | false | 'unknown';

export type ActionEvidence =
  | { kind: 'observed'; changed: boolean; verdict: VerificationVerdict }
  | { kind: 'unavailable'; reason: 'target-unconfirmed' | 'verification-threw' };

export type ActionOutcome = {
  invocation: ActionInvocation;
  status: 'confirmed' | 'not-observed' | 'unknown';
  reason:
    | 'postcondition-matched'
    | 'postcondition-not-observed'
    | 'no-observable-change'
    | 'verification-inconclusive'
    | 'target-unconfirmed'
    | 'verification-threw';
};

// 호출 결과와 관측 증거를 분리한 동작 결과 분류
export function classifyActionOutcome(invocation: ActionInvocation, evidence: ActionEvidence): ActionOutcome {
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
