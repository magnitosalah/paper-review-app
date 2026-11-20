import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LOCAL_USER_ID, type AuthenticatedUser } from "./auth";
import { createDriveReceipt, driveFailure, GOOGLE_FILE_ID, readDriveReceipt, updateDriveReceipt } from "./google-drive";

export interface ChatRequestRecord {
  requestId: string;
  requestHash: string;
  status: "pending" | "complete" | "failed" | "interrupted";
  answer?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
type Finish = {status: "complete" | "failed" | "interrupted"; answer?: string; error?: string};
const recordSchema = z.object({
  requestId: z.string().regex(GOOGLE_FILE_ID), requestHash: z.string().min(1).max(128),
  status: z.enum(["pending", "complete", "failed", "interrupted"]),
  answer: z.string().max(110_000).optional(), error: z.string().max(4_000).optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
const envelopeSchema = z.object({version: z.literal(1), ownerId: z.string(), record: recordSchema});
const staleAfterMs = 10 * 60 * 1000;
const staleMessage = "이전 요청의 실행이 종료되었거나 응답 상태를 확인할 수 없습니다. 중복 전송을 피하기 위해 자동 재실행하지 않습니다.";
const locks = new Map<string, Promise<unknown>>();

function validateIds(user: AuthenticatedUser, requestId: string, hash?: string) {
  if (!user.id || user.id.length > 255 || !GOOGLE_FILE_ID.test(requestId) || (hash !== undefined && (!hash || hash.length > 128))) throw driveFailure("요청 식별자가 올바르지 않습니다.", 400);
}
function decodeRecord(value: unknown, user: AuthenticatedUser, requestId: string): ChatRequestRecord {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== user.id || parsed.data.record.requestId !== requestId) throw driveFailure("요청 기록의 소유자 또는 내용이 일치하지 않습니다. 자동 재실행하지 않습니다.", 409);
  return parsed.data.record;
}
function envelope(user: AuthenticatedUser, record: ChatRequestRecord) { return {version: 1, ownerId: user.id, record}; }
function staleView(record: ChatRequestRecord): ChatRequestRecord {
  // Do not write on GET: a late reader must never overwrite a just-completed answer.
  return record.status === "pending" && Date.now() - Date.parse(record.updatedAt) > staleAfterMs ? {...record, status: "interrupted", error: staleMessage} : record;
}
function localFile(user: AuthenticatedUser, requestId: string): string {
  if (user.id !== LOCAL_USER_ID || process.env.NODE_ENV !== "development" || process.env.ALLOW_LOCAL_DEV !== "true" || process.env.VERCEL) throw driveFailure("로컬 개발 요청 저장소가 활성화되지 않았습니다.", 403);
  const digest = createHash("sha256").update(`${user.id}\0${requestId}`).digest("hex");
  return path.join(process.cwd(), ".local-data", "chat-requests", `${digest}.json`);
}
async function withLocalLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation); locks.set(file, current);
  try { return await current; } finally { if (locks.get(file) === current) locks.delete(file); }
}
async function readLocal(file: string): Promise<ChatRequestRecord | null> {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw driveFailure("이전 요청 기록이 손상되었습니다. 자동 재실행하지 않습니다.");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Response) throw error;
    throw driveFailure("이전 요청 기록을 읽지 못했습니다. 자동 재실행하지 않습니다.");
  }
}
async function replaceLocal(file: string, record: ChatRequestRecord) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), {mode: 0o600}); await rename(temporary, file);
}

export async function getChatRequest(user: AuthenticatedUser, requestId: string): Promise<ChatRequestRecord | null> {
  validateIds(user, requestId);
  if (user.id === LOCAL_USER_ID) {
    const file = localFile(user, requestId);
    return withLocalLock(file, async () => {const record = await readLocal(file); return record ? staleView(record) : null;});
  }
  const body = await readDriveReceipt(user, requestId);
  return body ? staleView(decodeRecord(body, user, requestId)) : null;
}

export async function claimChatRequest(user: AuthenticatedUser, requestId: string, requestHash: string): Promise<{claimed: boolean; request: ChatRequestRecord}> {
  validateIds(user, requestId, requestHash);
  const now = new Date().toISOString();
  const record: ChatRequestRecord = {requestId, requestHash, status: "pending", createdAt: now, updatedAt: now};
  if (user.id === LOCAL_USER_ID) {
    const file = localFile(user, requestId);
    return withLocalLock(file, async () => {
      await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
      try {await writeFile(file, JSON.stringify(record), {flag: "wx", mode: 0o600}); return {claimed: true, request: record};}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw driveFailure("요청 기록을 보관하지 못했습니다.");}
      const existing = await readLocal(file);
      if (!existing) throw driveFailure("기존 요청 기록을 확인하지 못했습니다.");
      if (existing.requestHash !== requestHash) throw driveFailure("같은 요청 ID에 다른 질문을 사용할 수 없습니다.", 409);
      return {claimed: false, request: staleView(existing)};
    });
  }
  // Atomic creation with a pre-generated Drive ID is the only inference authorization gate.
  // A timeout or unknown response throws. Never infer success and never auto-create a new ID.
  if (await createDriveReceipt(user, requestId, envelope(user, record))) return {claimed: true, request: record};
  const existing = await getChatRequest(user, requestId);
  if (!existing) throw driveFailure("중복 요청의 기존 상태를 확인하지 못했습니다. 자동 재실행하지 않습니다.", 409);
  if (existing.requestHash !== requestHash) throw driveFailure("같은 요청 ID에 다른 질문을 사용할 수 없습니다.", 409);
  return {claimed: false, request: existing};
}

export async function finishChatRequest(user: AuthenticatedUser, requestId: string, result: Finish): Promise<ChatRequestRecord> {
  validateIds(user, requestId);
  if (user.id === LOCAL_USER_ID) {
    const file = localFile(user, requestId);
    return withLocalLock(file, async () => {
      const existing = await readLocal(file);
      if (!existing) throw driveFailure("저장된 요청을 찾을 수 없습니다.", 404);
      if (existing.status !== "pending") return existing;
      const finished: ChatRequestRecord = {...existing, ...result, updatedAt: new Date().toISOString()};
      await replaceLocal(file, finished); return finished;
    });
  }
  const body = await readDriveReceipt(user, requestId);
  if (!body) throw driveFailure("저장된 요청을 찾을 수 없습니다.", 404);
  const existing = decodeRecord(body, user, requestId);
  if (existing.status !== "pending") return existing;
  const finished: ChatRequestRecord = {...existing, ...result, updatedAt: new Date().toISOString()};
  if (!recordSchema.safeParse(finished).success) throw driveFailure("답변 기록 형식 또는 길이가 올바르지 않습니다.", 400);
  await updateDriveReceipt(user, requestId, envelope(user, finished));
  return finished;
}
