const selectionNote =
  "Note: Pay special attention to the content selected by the user. If the user asks a question or refers to the content they are looking at on-screen, they might be referring to the selected content (but they might be referring to something else that's visible, too).";

// 렌더러의 선택 요약과 정확한 안내 접미부 분리
export function splitAXSelection(lines: string[]):
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
