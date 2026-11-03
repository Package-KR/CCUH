import type { VerificationVerdict } from './outcome.ts';

export type ModalContainerRole =
  | 'sheet'
  | '시트'
  | 'dialog'
  | '대화상자'
  | 'standard window'
  | '표준 윈도우'
  | 'window'
  | '윈도우';
export type ModalRootSelector = { role: ModalContainerRole; id: string };
export type ModalDismissalOptions = {
  appName: string;
  modal: ModalRootSelector;
  parent: ({ kind: 'root-id' } & ModalRootSelector) | { kind: 'window-title'; title: string };
};
type ContainerRow = { index: number; depth: number; role: ModalContainerRole; name: string; id?: string };
type Snapshot = { app: string; title: string; root: ContainerRow; containers: ContainerRow[] };

const roles = ['standard window', '표준 윈도우', '대화상자', 'dialog', 'sheet', '시트', 'window', '윈도우'];
const selectionNote =
  "Note: Pay special attention to the content selected by the user. If the user asks a question or refers to the content they are looking at on-screen, they might be referring to the selected content (but they might be referring to something else that's visible, too).";

// 필수 자체 값 필드를 가진 일반 객체 검사
function hasDataFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'))
  );
}

// 제어 문자가 없는 관측 조건 문자열 검사
function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

// 명시한 컨테이너 역할과 식별자 검사
function validRoot(value: unknown): value is ModalRootSelector {
  return (
    hasDataFields(value, ['role', 'id']) &&
    typeof value.role === 'string' &&
    roles.includes(value.role) &&
    validText(value.id)
  );
}

// 종료 전 모달과 기대 부모 조건 검사
function validOptions(value: unknown): value is ModalDismissalOptions {
  if (!hasDataFields(value, ['appName', 'modal', 'parent']) || !validText(value.appName) || !validRoot(value.modal)) {
    return false;
  }
  const parent = value.parent;
  if (hasDataFields(parent, ['kind', 'title'])) return parent.kind === 'window-title' && validText(parent.title);
  return (
    hasDataFields(parent, ['kind', 'role', 'id']) &&
    parent.kind === 'root-id' &&
    typeof parent.role === 'string' &&
    roles.includes(parent.role) &&
    validText(parent.id) &&
    parent.id !== value.modal.id
  );
}

// 관측한 표시 문자열의 정규화된 일치 확인
function sameText(left: string, right: string): boolean {
  return left.normalize('NFC') === right.normalize('NFC');
}

// 본문 메타데이터를 제외한 컨테이너 행 판독
function readContainer(row: { index: number; depth: number; body: string }): ContainerRow | null | undefined {
  const role = roles.find(value => row.body === value || row.body.startsWith(value + ' '));
  if (!role) return null;
  const tail = row.body.slice(role.length).trimStart();
  if (/(?:^|,\s*|\s+)(?:Value|Description|Help):/u.test(tail)) return;
  const metadata = /(?:^|,\s*|\s+)(ID|URL|Secondary Actions):/u.exec(tail);
  const ids = [...tail.matchAll(/(?:^|,\s*|\s+)ID: ([^,]+)(?=,|$)/gu)];
  if (
    ids.length > 1 ||
    (ids.length === 1 &&
      (!metadata ||
        metadata[1] !== 'ID' ||
        ids[0].index !== metadata.index ||
        (metadata.index !== 0 && !metadata[0].startsWith(',')) ||
        !validText(ids[0][1].trim())))
  )
    return;
  return {
    index: row.index,
    depth: row.depth,
    role: role as ModalContainerRole,
    name: tail.slice(0, metadata?.index).trim(),
    ...(ids.length === 1 ? { id: ids[0][1].trim() } : {}),
  };
}

// 편집 가능한 한 줄 텍스트 필드의 값 판독
function readEditableValue(body: string): string | undefined {
  const field = /^(?:텍스트 필드|text field) \(([^()]*)\) (.+)$/u.exec(body);
  if (!field || !field[1].split(/,\s*/u).includes('settable')) return;
  const metadata = field[2];
  if (/(?:^|,\s*|\s+)(?:Description|Help|URL|Secondary Actions):/u.test(metadata)) return;
  const values = [...metadata.matchAll(/(?:^|,\s*|\s+)Value:/gu)];
  const ids = [...metadata.matchAll(/(?:^|,\s*|\s+)ID:/gu)];
  if (values.length !== 1 || ids.length > 1) return;
  if (ids.length === 0) return /^Value: (.+)$/u.exec(metadata)?.[1];
  const valueFirst = /^Value: (.+), ID: ([^,]+)$/u.exec(metadata);
  if (valueFirst && validText(valueFirst[2])) return valueFirst[1];
  const idFirst = /^ID: ([^,]+), Value: (.+)$/u.exec(metadata);
  return idFirst && validText(idFirst[1]) ? idFirst[2] : undefined;
}

// 렌더러의 선택 요약과 정확한 안내 접미부 분리
function splitSelection(lines: string[]):
  | {
      tree: string[];
      selected?: { index: number; body: string };
      selectedText?: string;
    }
  | undefined {
  const sections = lines.flatMap((line, index) =>
    line === 'Selected:' || line === 'Selected text: ```' ? [index] : [],
  );
  const prefix = sections.length === 1 ? lines.slice(0, sections[0]) : lines;
  if (sections.length > 1 || prefix.some(line => /^(?:Selected(?: text)?|Note):/u.test(line))) return;
  if (sections.length === 0) return { tree: lines };
  const remainder = lines.slice(sections[0] + 1);
  if (lines[sections[0]] === 'Selected text: ```') {
    const notes = remainder.slice(2).filter(line => line.trim() !== '');
    if (!remainder[0]?.trim() || remainder[1] !== '```' || notes.length !== 1 || notes[0] !== selectionNote) return;
    return { tree: prefix, selectedText: remainder[0] };
  }
  const suffix = remainder.filter(line => line.trim() !== '');
  if (suffix.length < 1 || suffix.length > 2 || (suffix.length === 2 && suffix[1] !== selectionNote)) return;
  const selected = /^[ \t]*(\d+) (.+)$/u.exec(suffix[0]);
  if (!selected || !Number.isSafeInteger(Number(selected[1]))) return;
  return { tree: prefix, selected: { index: Number(selected[1]), body: selected[2] } };
}

// 같은 앱의 유일한 최상위 컨테이너 관측 판독
function readSnapshot(state: string): Snapshot | undefined {
  const lines = state.split(/\r?\n/u);
  const header = /^Window: "(.*)", App: ([^\r\n]+)\.$/u.exec(lines[0] ?? '');
  if (!header || !validText(header[2]) || (header[1] !== '' && !validText(header[1]))) return;
  if (lines.slice(1).some(line => /^Window:/u.test(line))) return;
  const sections = splitSelection(lines.slice(1));
  if (!sections) return;
  const content = sections.tree.filter(line => line.trim() !== '');
  const rows = content.map(line => /^([ \t]*)(\d+) (.+)$/u.exec(line));
  if (!rows[0] || rows.some((row, index) => !row && /^[ \t]*[-+]?\d/u.test(content[index]))) return;
  const entries = rows.flatMap(row => (row ? [{ index: Number(row[2]), depth: row[1].length, body: row[3] }] : []));
  if (
    entries.some(row => !Number.isSafeInteger(row.index)) ||
    new Set(entries.map(row => row.index)).size !== entries.length
  )
    return;
  const selected = sections.selected;
  if (selected && !entries.some(row => row.index === selected.index && row.body === selected.body)) return;
  const selectedText = sections.selectedText;
  if (
    selectedText !== undefined &&
    entries.filter(row => readEditableValue(row.body)?.includes(selectedText)).length !== 1
  )
    return;
  const parsed = entries.map(readContainer);
  if (parsed.some(row => row === undefined)) return;
  const containers = parsed.filter((row): row is ContainerRow => row !== null && row !== undefined);
  const roots = containers.filter(row => row.depth === 0);
  const root = roots[0];
  if (roots.length !== 1 || !root || root.index !== entries[0].index || !sameText(root.name, header[1])) return;
  return { app: header[2], title: header[1], root, containers };
}

// 모달 소멸과 명시한 부모 복귀의 관측 결과 확인
export function verifyModalDismissal(
  snapshots: { before: string; after: string },
  options: ModalDismissalOptions,
): VerificationVerdict {
  try {
    if (
      !hasDataFields(snapshots, ['before', 'after']) ||
      typeof snapshots.before !== 'string' ||
      typeof snapshots.after !== 'string' ||
      !validOptions(options)
    )
      return 'unknown';
    const before = readSnapshot(snapshots.before);
    const after = readSnapshot(snapshots.after);
    if (!before || !after || !sameText(before.app, options.appName) || !sameText(after.app, options.appName))
      return 'unknown';
    const original = before.containers.filter(row => row.id === options.modal.id);
    if (original.length !== 1 || original[0] !== before.root || original[0].role !== options.modal.role)
      return 'unknown';
    const remaining = after.containers.filter(row => row.id === options.modal.id);
    if (remaining.length > 1 || remaining.some(row => row.role !== options.modal.role)) return 'unknown';
    if (remaining.length === 1) return false;
    const parent = options.parent;
    if (parent.kind === 'window-title') return sameText(after.title, parent.title) ? true : 'unknown';
    const parents = after.containers.filter(row => row.id === parent.id);
    return parents.length === 1 && parents[0] === after.root && parents[0].role === parent.role ? true : 'unknown';
  } catch {
    return 'unknown';
  }
}
