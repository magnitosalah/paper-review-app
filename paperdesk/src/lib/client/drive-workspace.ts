"use client";

import { DriveError, getDriveAccessToken, getGoogleUser } from "@/lib/client/drive";
import type { WorkspaceEntry } from "@/lib/client/storage";

const API = "https://www.googleapis.com/drive/v3/";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/";
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const OPERATION_KIND = "operations-v1";
const folderPromises = new Map<string, Promise<string>>();
export interface DriveWorkspaceSession { ownerId: string; token: string }
interface DriveFileRecord { id: string; name?: string; size?: string; createdTime?: string }
interface OperationFile { format: "paperdesk-operations"; version: 1; ownerId: string; deviceId: string; operations: WorkspaceEntry[] }

export async function driveWorkspaceSession(ownerId: string): Promise<DriveWorkspaceSession> {
  const token = await getDriveAccessToken(false);
  const account = await getGoogleUser();
  if (account.id !== ownerId || token !== await getDriveAccessToken(false)) throw new DriveError("연결된 Google 계정이 바뀌었습니다. 다시 연결해 주세요.", "ACCOUNT_CHANGED");
  return { ownerId, token };
}

async function request(session: DriveWorkspaceSession, url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  if (target.origin !== "https://www.googleapis.com" || (!target.pathname.startsWith("/drive/v3/") && !target.pathname.startsWith("/upload/drive/v3/"))) throw new Error("허용되지 않은 Drive 요청입니다.");
  const timeout = AbortSignal.timeout(init.method === "PUT" ? 120_000 : 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(target, { ...init, signal, redirect: "error", headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${session.token}` } }); }
  catch (error) {
    if (timeout.aborted) throw new DriveError("Drive 응답 시간이 초과되었습니다. 기록은 기기에 남아 있습니다.", "DRIVE_TIMEOUT");
    throw error;
  }
  if (response.status === 401) throw new DriveError("Google 연결이 만료되었습니다. 다시 연결하면 저장을 이어갑니다.", "DRIVE_RECONNECT_REQUIRED");
  if (response.status === 403) throw new DriveError("Drive 저장 권한이나 저장 공간을 확인해 주세요. 다시 연결할 때 앱 데이터 권한도 허용해 주세요.", "DRIVE_FORBIDDEN");
  if (response.status === 404) throw new DriveError("Drive 파일을 찾을 수 없습니다. 기존 기기 기록은 보존됩니다.", "FILE_NOT_FOUND");
  if (!response.ok && response.status !== 308) throw new DriveError("Drive 요청에 실패했습니다. 기록을 기기에 보관하고 있습니다.", "DRIVE_REQUEST_FAILED");
  return response;
}

async function listFiles(session: DriveWorkspaceSession, query: string, space: "drive" | "appDataFolder"): Promise<DriveFileRecord[]> {
  const files: DriveFileRecord[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, spaces: space, pageSize: "1000", fields: "nextPageToken,files(id,name,size,createdTime)" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await request(session, `${API}files?${params}`);
    const data = await response.json() as { files?: DriveFileRecord[]; nextPageToken?: string };
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

const kinds = new Set(["papers", "scraps", "references", "chats", "messages", "readingPositions", "drafts"]);
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function hasStrings(value: Record<string, unknown>, fields: string[]): boolean { return fields.every(field => typeof value[field] === "string"); }
function validValue(entry: WorkspaceEntry): boolean {
  if (entry.deleted) return true;
  const value = entry.value;
  if (!isRecord(value)) return false;
  if (entry.kind === "drafts") return hasStrings(value, ["chatId", "deviceId", "text"]);
  if (entry.kind === "readingPositions") return hasStrings(value, ["paperId", "deviceId"]) && isRecord(value.position) && typeof value.position.page === "number" && typeof value.position.scale === "number";
  if (!hasStrings(value, ["id", "createdAt"])) return false;
  switch (entry.kind) {
    case "papers": return hasStrings(value, ["title", "filename", "updatedAt"]) && ["local", "drive", "sample"].includes(value.source as string);
    case "scraps": return hasStrings(value, ["paperId", "text", "originalText", "note", "updatedAt"]) && typeof value.page === "number" && Array.isArray(value.rects);
    case "references": return hasStrings(value, ["paperId", "label", "citation", "title", "authors"]) && ["unverified", "metadata", "abstract", "fulltext"].includes(value.evidence as string);
    case "chats": return hasStrings(value, ["paperId", "title"]);
    case "messages": return hasStrings(value, ["chatId", "content", "model"]) && ["user", "assistant"].includes(value.role as string) && ["gemini", "claude", "codex"].includes(value.provider as string) && ["pending", "streaming", "complete", "interrupted", "failed"].includes(value.status as string);
    default: return false;
  }
}

export function parseOperationFile(value: unknown, ownerId: string): WorkspaceEntry[] {
  if (!isRecord(value) || value.format !== "paperdesk-operations" || value.version !== 1 || value.ownerId !== ownerId || !Array.isArray(value.operations) || value.operations.length > 500) throw new Error("Drive 기록의 형식이나 계정을 확인할 수 없습니다.");
  for (const item of value.operations) {
    if (!isRecord(item) || typeof item.key !== "string" || item.key.length > 512 || !kinds.has(item.kind as string) || typeof item.changeId !== "string" || item.changeId.length > 256 || typeof item.deleted !== "boolean" || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)) || !validValue(item as unknown as WorkspaceEntry)) throw new Error("손상되거나 지원하지 않는 Drive 기록이 있습니다. 기기 사본은 유지됩니다.");
  }
  return value.operations as WorkspaceEntry[];
}

/** Discover append-only files and download only previously unseen files. */
export async function readDriveOperations(session: DriveWorkspaceSession, knownFiles: string[] = []): Promise<{ operations: WorkspaceEntry[]; fileIds: string[] }> {
  const files = await listFiles(session, `trashed = false and appProperties has { key='paperdeskKind' and value='${OPERATION_KIND}' }`, "appDataFolder");
  const known = new Set(knownFiles);
  const unread = files.filter(file => !known.has(file.id));
  const operations: WorkspaceEntry[] = [], fileIds: string[] = [];
  for (let offset = 0; offset < unread.length; offset += 4) {
    const results = await Promise.all(unread.slice(offset, offset + 4).map(async file => {
      if (Number(file.size) > MAX_OPERATION_BYTES) throw new Error("Drive 기록 파일이 허용 크기를 초과했습니다.");
      const response = await request(session, `${API}files/${encodeURIComponent(file.id)}?alt=media`);
      const blob = await response.blob();
      if (blob.size > MAX_OPERATION_BYTES) throw new Error("Drive 기록 파일이 허용 크기를 초과했습니다.");
      return { fileId: file.id, operations: parseOperationFile(JSON.parse(await blob.text()), session.ownerId) };
    }));
    for (const result of results) { operations.push(...result.operations); fileIds.push(result.fileId); }
  }
  return { operations, fileIds };
}

async function multipartCreate(session: DriveWorkspaceSession, metadata: Record<string, unknown>, content: Blob): Promise<string> {
  const boundary = `paperdesk_${crypto.randomUUID().replace(/-/g, "")}`;
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${content.type || "application/octet-stream"}\r\n\r\n`, content, `\r\n--${boundary}--\r\n`]);
  const response = await request(session, `${UPLOAD_API}files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  const file = await response.json() as { id?: string };
  if (!file.id) throw new Error("Drive에 저장한 파일을 확인할 수 없습니다.");
  return file.id;
}

export async function appendDriveOperations(session: DriveWorkspaceSession, deviceId: string, operations: WorkspaceEntry[]): Promise<string[]> {
  const fileIds: string[] = [];
  let batch: WorkspaceEntry[] = [];
  const contentFor = (entries: WorkspaceEntry[]) => new Blob([JSON.stringify({ format: "paperdesk-operations", version: 1, ownerId: session.ownerId, deviceId, operations: entries } satisfies OperationFile)], { type: "application/json" });
  const writeBatch = async () => {
    if (!batch.length) return;
    const content = contentFor(batch);
    if (content.size > MAX_OPERATION_BYTES) throw new Error("기록 한 항목이 너무 커서 Drive에 저장하지 못했습니다.");
    fileIds.push(await multipartCreate(session, { name: `paperdesk-operations-${crypto.randomUUID()}.json`, mimeType: "application/json", parents: ["appDataFolder"], appProperties: { paperdeskKind: OPERATION_KIND } }, content));
    batch = [];
  };
  for (const operation of operations) {
    if (batch.length && (batch.length >= 100 || contentFor([...batch, operation]).size > MAX_OPERATION_BYTES)) await writeBatch();
    batch.push(operation);
  }
  await writeBatch();
  return fileIds;
}

async function pdfFolder(session: DriveWorkspaceSession): Promise<string> {
  let promise = folderPromises.get(session.ownerId);
  if (!promise) {
    promise = (async () => {
      const folders = await listFiles(session, "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='paperdeskFolder' and value='v1' }", "drive");
      if (folders.length) return folders.sort((a, b) => a.id.localeCompare(b.id))[0].id;
      const response = await request(session, `${API}files?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Paperdesk", mimeType: "application/vnd.google-apps.folder", parents: ["root"], appProperties: { paperdeskFolder: "v1" } }) });
      const data = await response.json() as { id: string };
      return data.id;
    })().catch(error => { folderPromises.delete(session.ownerId); throw error; });
    folderPromises.set(session.ownerId, promise);
  }
  return promise;
}

/** Creates an app-owned PDF copy; never updates or deletes the user's existing Drive original. */
export async function uploadWorkspacePdf(session: DriveWorkspaceSession, paperId: string, blob: Blob, filename?: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(paperId)) throw new Error("문서 식별자가 올바르지 않습니다.");
  if (blob.size > MAX_PDF_BYTES) throw new Error("50MB 이하의 PDF만 Drive에 보관할 수 있습니다.");
  const existing = await listFiles(session, `trashed = false and mimeType = 'application/pdf' and appProperties has { key='paperdeskPaperId' and value='${paperId}' }`, "drive");
  if (existing.length) return existing.sort((a, b) => a.id.localeCompare(b.id))[0].id;
  const folder = await pdfFolder(session);
  const start = await request(session, `${UPLOAD_API}files?uploadType=resumable&fields=id`, { method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Content-Type": "application/pdf", "X-Upload-Content-Length": String(blob.size) }, body: JSON.stringify({ name: filename || `Paperdesk-${paperId}.pdf`, mimeType: "application/pdf", parents: [folder], appProperties: { paperdeskPaperId: paperId } }) });
  const location = start.headers.get("location");
  if (!location) throw new Error("Drive 업로드를 시작하지 못했습니다.");
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, blob.size);
    const response = await request(session, location, { method: "PUT", headers: { "Content-Type": "application/pdf", "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end) });
    if (response.ok) {
      const data = await response.json() as { id?: string };
      if (!data.id) throw new Error("Drive에 저장한 PDF를 확인할 수 없습니다.");
      return data.id;
    }
    const acknowledged = response.headers.get("range")?.match(/^bytes=0-(\d+)$/);
    if (!acknowledged || Number(acknowledged[1]) !== end - 1) throw new Error("PDF 업로드가 중단되었습니다. 다음 동기화에서 다시 시도합니다.");
  }
  throw new Error("PDF 업로드가 완료되지 않았습니다.");
}

export async function downloadWorkspacePdf(session: DriveWorkspaceSession, fileId: string): Promise<Blob> {
  if (!/^[\w-]+$/.test(fileId)) throw new Error("PDF 파일 식별자가 올바르지 않습니다.");
  const response = await request(session, `${API}files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) throw new Error("PDF 크기가 50MB를 초과했습니다.");
  const blob = await response.blob();
  if (blob.size > MAX_PDF_BYTES || !(await blob.slice(0, 1024).text()).includes("%PDF-")) throw new Error("Drive 파일을 지원하는 PDF로 확인할 수 없습니다.");
  return new Blob([blob], { type: "application/pdf" });
}
