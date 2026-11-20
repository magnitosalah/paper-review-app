import { createHash, randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "./auth";

export const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{16,200}$/;
const api = "https://www.googleapis.com/drive/v3/files";
const upload = "https://www.googleapis.com/upload/drive/v3/files";
export const driveFailure = (error: string, status = 503) => Response.json({error}, {status});

export function receiptProperties(userId: string, requestId: string) {
  // Google limits the combined key/value length of a custom property. Hash variable-length IDs.
  return {application: "paperdesk", kind: "chat-request", owner: createHash("sha256").update(userId).digest("hex"), request: createHash("sha256").update(requestId).digest("hex")};
}
async function driveFetch(user: AuthenticatedUser, url: string, init: RequestInit = {}): Promise<Response> {
  if (!user.accessToken) throw driveFailure("Google Drive 연결이 필요합니다.", 401);
  try {
    return await fetch(url, {...init, headers: {...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${user.accessToken}`}, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000)});
  } catch { throw driveFailure("Google Drive 요청 결과를 확인하지 못했습니다. 요청 상태를 확인한 뒤 다시 시도해 주세요."); }
}
function checkResponse(response: Response) {
  if (response.ok) return;
  if (response.status === 401) throw driveFailure("Google 연결이 만료되었습니다. 다시 연결해 주세요.", 401);
  if (response.status === 403) throw driveFailure("Google Drive 저장 권한 또는 저장 용량을 확인해 주세요.", 403);
  if (response.status === 429) throw driveFailure("Google Drive 요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429);
  throw driveFailure("Google Drive에 요청 기록을 보관하지 못했습니다.");
}
async function readJson(response: Response, limit = 600_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw driveFailure("Google Drive 요청 기록을 읽지 못했습니다.");
  const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); bytes += value?.byteLength ?? 0;
      if (bytes > limit) throw driveFailure("Google Drive 요청 기록이 허용 크기를 초과했습니다.");
      text += done ? decoder.decode() : decoder.decode(value, {stream: true});
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw driveFailure("Google Drive 요청 기록이 손상되었습니다. 자동 재실행하지 않습니다."); }
}
function metadataMatches(metadata: unknown, user: AuthenticatedUser, requestId: string): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const item = metadata as Record<string, unknown>;
  const properties = item.appProperties as Record<string, unknown> | undefined;
  const expected = receiptProperties(user.id, requestId);
  return item.id === requestId && item.mimeType === "application/json" && item.ownedByMe === true && item.trashed !== true && Array.isArray(item.spaces) && item.spaces.includes("appDataFolder")
    && Object.entries(expected).every(([key, value]) => properties?.[key] === value);
}
/** Reads only an app-owned, user-owned request file; never arbitrary files chosen by ID. */
export async function readDriveReceipt(user: AuthenticatedUser, requestId: string): Promise<unknown | null> {
  const response = await driveFetch(user, `${api}/${encodeURIComponent(requestId)}?fields=id,mimeType,ownedByMe,trashed,spaces,appProperties`);
  if (response.status === 404) {await response.body?.cancel().catch(() => {}); return null;}
  checkResponse(response);
  if (!metadataMatches(await readJson(response, 16_000), user, requestId)) throw driveFailure("이 계정의 Paperdesk 요청 기록이 아닙니다.", 403);
  const media = await driveFetch(user, `${api}/${encodeURIComponent(requestId)}?alt=media`);
  checkResponse(media);
  return readJson(media);
}
/** A Google-generated file ID is the idempotency key. Only confirmed creation permits inference. */
export async function createDriveReceipt(user: AuthenticatedUser, requestId: string, body: unknown): Promise<boolean> {
  const boundary = `paperdesk_${randomUUID().replaceAll("-", "")}`;
  const metadata = {id: requestId, name: `chat-request-${requestId}.json`, mimeType: "application/json", parents: ["appDataFolder"], appProperties: receiptProperties(user.id, requestId)};
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}--\r\n`;
  const response = await driveFetch(user, `${upload}?uploadType=multipart&fields=id`, {method: "POST", headers: {"content-type": `multipart/related; boundary=${boundary}`}, body: multipart});
  if (response.status === 409) {await response.body?.cancel().catch(() => {}); return false;}
  checkResponse(response);
  const created = await readJson(response, 16_000) as {id?: unknown};
  if (created?.id !== requestId) throw driveFailure("요청 기록 생성 결과를 확인하지 못했습니다. 자동 재실행하지 않습니다.");
  return true;
}
/** Call only after readDriveReceipt has verified ownership and file markers. */
export async function updateDriveReceipt(user: AuthenticatedUser, requestId: string, body: unknown): Promise<void> {
  const response = await driveFetch(user, `${upload}/${encodeURIComponent(requestId)}?uploadType=media&fields=id`, {method: "PATCH", headers: {"content-type": "application/json; charset=UTF-8"}, body: JSON.stringify(body)});
  checkResponse(response);
  const updated = await readJson(response, 16_000) as {id?: unknown};
  if (updated?.id !== requestId) throw driveFailure("답변 저장 결과를 확인하지 못했습니다. 요청 상태를 다시 확인해 주세요.");
}
