import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const COMPUTER_USE_TOOL_NAMES = new Set(['mcp__cua_repl__js', 'mcp__cua_repl__js_reset']);
const MAX_INPUT_BYTES = 256 * 1024;

type ComputerUseEvent = {
  toolName: string;
  sessionId: string;
  callId: string;
  code?: string;
};

// 수신 값의 해시 생성
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// JSON 객체 판별
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 훅 호출 식별자 검사
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

// 제한된 훅 입력 읽기
async function readEvent(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) {
      process.stdin.destroy();
      return;
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Computer Use 이벤트 검증과 변환
function parseEvent(input: unknown): ComputerUseEvent | undefined {
  if (
    !isRecord(input) ||
    input.hook_event_name !== 'PreToolUse' ||
    typeof input.tool_name !== 'string' ||
    !COMPUTER_USE_TOOL_NAMES.has(input.tool_name) ||
    !validId(input.session_id) ||
    !validId(input.tool_use_id)
  )
    return;

  const code = isRecord(input.tool_input) ? input.tool_input.code : undefined;
  return {
    toolName: input.tool_name,
    sessionId: input.session_id,
    callId: input.tool_use_id,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

// 원문을 제외한 수신 증거 구성
function createReceipt(event: ComputerUseEvent, receiverHash: string) {
  return {
    schemaVersion: 1,
    receiptId: randomUUID(),
    receivedAt: new Date().toISOString(),
    toolName: event.toolName,
    sessionHash: hash(event.sessionId),
    callHash: hash(event.callId),
    codeHash: event.code === undefined ? null : hash(event.code),
    receiverHash,
  };
}

// 수신 증거 저장 경로 결정
function receiptDirectory(): string {
  const directory =
    process.env.CCUH_RECEIPT_DIR ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'ccuh', 'receiver');
  if (!isAbsolute(directory)) throw new Error('Receipt directory must be absolute');
  return directory;
}

// 마지막 수신 증거의 원자적 교체
async function saveReceipt(receipt: ReturnType<typeof createReceipt>): Promise<void> {
  const directory = receiptDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, receipt.receiptId + '.pending');
  try {
    await writeFile(temporary, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'last-receipt.json'));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// 허용된 훅 이벤트의 수신 처리
async function receive(): Promise<void> {
  const event = parseEvent(await readEvent());
  if (!event) return;
  const receiverHash = hash(await readFile(new URL(import.meta.url)));
  await saveReceipt(createReceipt(event, receiverHash));
}

try {
  await receive();
} catch {
  process.stderr.write('CCUH: receiver could not record the invocation\n');
}
