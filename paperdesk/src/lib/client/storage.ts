import { emptyWorkspace, type WorkspaceState, type ReadingPosition, type Quote } from "@/lib/types";

export type EntryKind = "papers" | "scraps" | "references" | "chats" | "messages" | "readingPositions" | "drafts";
export interface WorkspaceEntry {
  key: string;
  kind: EntryKind;
  value: unknown;
  deleted: boolean;
  revision: number;
  changeId: string;
  updatedAt: string;
}
export interface PendingEntry extends WorkspaceEntry { baseRevision: number }
export interface StoredWorkspace {
  version: 1;
  entries: Record<string, WorkspaceEntry>;
  pending: Record<string, PendingEntry>;
  /** Immutable Drive operations, indexed by change ID so retried uploads are harmless. */
  operations?: Record<string, WorkspaceEntry>;
  driveFiles?: string[];
}
export const newStoredWorkspace = (): StoredWorkspace => ({ version: 1, entries: {}, pending: {} });
const collections = ["papers", "scraps", "references", "chats", "messages"] as const;
const DATABASE = "paperdesk-local-v1";
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("이 브라우저에서 기기 저장소를 사용할 수 없습니다."));
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("workspaces");
      db.createObjectStore("pdfs");
      db.createObjectStore("settings");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { databasePromise = undefined; reject(request.error); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error("다른 탭을 닫은 뒤 기기 저장소를 다시 열어 주세요.")); };
  });
  return databasePromise;
}

async function transact<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("기기 저장에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error ?? new Error("기기 저장이 중단되었습니다."));
  });
}

export async function getDeviceId(): Promise<string> {
  const existing = await transact("settings", "readonly", store => store.get("deviceId"));
  if (typeof existing === "string") return existing;
  const id = crypto.randomUUID();
  await transact("settings", "readwrite", store => store.put(id, "deviceId"));
  return id;
}

export async function loadWorkspace(scope: string): Promise<StoredWorkspace> {
  const stored = await transact("workspaces", "readonly", store => store.get(scope)) as StoredWorkspace | undefined;
  if (!stored || stored.version !== 1 || !stored.entries || !stored.pending) return newStoredWorkspace();
  return stored;
}

export async function persistWorkspace(scope: string, workspace: StoredWorkspace): Promise<void> {
  await transact("workspaces", "readwrite", store => store.put(workspace, scope));
}

export async function storePdf(scope: string, paperId: string, blob: Blob): Promise<void> {
  await transact("pdfs", "readwrite", store => store.put(blob, `${scope}:${paperId}`));
}

export async function readPdf(scope: string, paperId: string): Promise<Blob | null> {
  return (await transact("pdfs", "readonly", store => store.get(`${scope}:${paperId}`))) as Blob | undefined ?? null;
}

export async function removePdf(scope: string, paperId: string): Promise<void> {
  await transact("pdfs", "readwrite", store => store.delete(`${scope}:${paperId}`));
}

interface FlatEntry { kind: EntryKind; value: unknown }
function flatten(state: WorkspaceState, deviceId: string): Record<string, FlatEntry> {
  const flat: Record<string, FlatEntry> = {};
  for (const kind of collections) for (const value of state[kind]) flat[`${kind}:${value.id}`] = { kind, value };
  for (const [paperId, position] of Object.entries(state.readingPositions)) {
    flat[`readingPositions:${deviceId}:${paperId}`] = { kind: "readingPositions", value: { paperId, deviceId, position } };
  }
  for (const chatId of new Set([...Object.keys(state.drafts), ...Object.keys(state.draftQuotes ?? {})])) {
    // Text and its attached evidence are one device-specific draft, including quote-only drafts.
    flat[`drafts:${deviceId}:${chatId}`] = { kind: "drafts", value: { chatId, deviceId, text: state.drafts[chatId] ?? "", quote: state.draftQuotes?.[chatId] ?? null } };
  }
  return flat;
}

/** Only changed records are queued. A stale device never uploads a whole snapshot. */
export function recordChanges(stored: StoredWorkspace, previous: WorkspaceState, next: WorkspaceState, deviceId: string): StoredWorkspace {
  const before = flatten(previous, deviceId);
  const after = flatten(next, deviceId);
  const pending = { ...stored.pending };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const value = after[key] ?? before[key];
    pending[key] = {
      key, kind: value.kind, value: after[key]?.value ?? before[key]?.value ?? null, deleted: !after[key],
      revision: stored.entries[key]?.revision ?? 0,
      baseRevision: pending[key]?.baseRevision ?? stored.entries[key]?.revision ?? 0,
      changeId: crypto.randomUUID(), updatedAt: new Date().toISOString(),
    };
  }
  return { ...stored, pending };
}

/** Local pending changes win until acknowledged. Per-device reading and drafts do not overwrite each other. */
export function materializeWorkspace(stored: StoredWorkspace, deviceId: string): WorkspaceState {
  const state = emptyWorkspace();
  const entries = { ...stored.entries, ...stored.pending };
  const positions = new Map<string, { pending: boolean; updatedAt: string; position: ReadingPosition }>();
  const drafts = new Map<string, { own: boolean; updatedAt: string; text: string; quote: Quote | null }>();
  for (const entry of Object.values(entries)) {
    if (entry.deleted || !entry.value || typeof entry.value !== "object") continue;
    if (collections.includes(entry.kind as typeof collections[number])) {
      const value = entry.value as { id?: string };
      if (typeof value.id === "string") (state[entry.kind as typeof collections[number]] as unknown[]).push(entry.value);
    } else if (entry.kind === "readingPositions") {
      const value = entry.value as { paperId: string; deviceId: string; position: ReadingPosition };
      if (!value.paperId || !value.position) continue;
      const current = positions.get(value.paperId), pending = Boolean(stored.pending[entry.key]);
      if (!current || (pending && !current.pending) || (pending === current.pending && entry.updatedAt > current.updatedAt)) {
        positions.set(value.paperId, { pending, updatedAt: entry.updatedAt, position: value.position });
      }
    } else if (entry.kind === "drafts") {
      const value = entry.value as { chatId: string; deviceId: string; text: string; quote?: Quote | null };
      if (!value.chatId || typeof value.text !== "string") continue;
      const current = drafts.get(value.chatId), own = value.deviceId === deviceId;
      if (!current || (own && !current.own) || (own === current.own && entry.updatedAt > current.updatedAt)) {
        drafts.set(value.chatId, { own, updatedAt: entry.updatedAt, text: value.text, quote: value.quote ?? null });
      }
    }
  }
  for (const [paperId, value] of positions) state.readingPositions[paperId] = value.position;
  for (const [chatId, value] of drafts) {
    state.drafts[chatId] = value.text;
    state.draftQuotes![chatId] = value.quote;
  }
  for (const kind of collections) state[kind].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A deleted paper must not reappear through an older device's child records.
  const papers = new Set(state.papers.map(paper => paper.id));
  state.scraps = state.scraps.filter(scrap => papers.has(scrap.paperId));
  state.references = state.references.filter(reference => papers.has(reference.paperId));
  state.chats = state.chats.filter(chat => papers.has(chat.paperId));
  const chats = new Set(state.chats.map(chat => chat.id));
  state.messages = state.messages.filter(message => chats.has(message.chatId));
  return state;
}

export function acceptRemoteEntries(stored: StoredWorkspace, remote: WorkspaceEntry[]): StoredWorkspace {
  const entries = { ...stored.entries };
  for (const entry of remote) if (!entries[entry.key] || entry.revision >= entries[entry.key].revision) entries[entry.key] = entry;
  return { ...stored, entries };
}

/** Acknowledgements may arrive after a newer local edit. Never clear that edit. */
export function acknowledgeEntry(stored: StoredWorkspace, submitted: PendingEntry, remote: WorkspaceEntry): StoredWorkspace {
  const next = acceptRemoteEntries(stored, [remote]);
  const pending = { ...next.pending };
  if (pending[submitted.key]?.changeId === submitted.changeId) delete pending[submitted.key];
  else if (pending[submitted.key]) pending[submitted.key] = { ...pending[submitted.key], baseRevision: remote.revision };
  return { ...next, pending };
}

function compareOperations(left: WorkspaceEntry, right: WorkspaceEntry): number {
  // A server-recovered terminal answer must survive an older streaming device's
  // larger local revision counter. A new question uses a different message ID.
  if (left.kind === "messages" && right.kind === "messages") {
    const ranks: Record<string, number> = { pending: 0, streaming: 1, failed: 2, interrupted: 3, complete: 4 };
    const leftRank = left.deleted ? 5 : ranks[(left.value as { status?: string })?.status ?? ""] ?? 0;
    const rightRank = right.deleted ? 5 : ranks[(right.value as { status?: string })?.status ?? ""] ?? 0;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
  return left.updatedAt.localeCompare(right.updatedAt) || left.changeId.localeCompare(right.changeId);
}

/** Convergent replay of immutable Drive operations. No client replaces another client's file. */
export function mergeReplicaSnapshot(stored: StoredWorkspace, incoming: WorkspaceEntry[], driveFiles: string[] = []): StoredWorkspace {
  const operations: Record<string, WorkspaceEntry> = stored.operations ? { ...stored.operations } : Object.fromEntries(Object.values(stored.entries).map(entry => [entry.changeId, entry]));
  for (const entry of incoming) operations[entry.changeId] = entry;
  const groups = new Map<string, WorkspaceEntry[]>();
  for (const entry of Object.values(operations)) {
    const group = groups.get(entry.key) ?? [];
    group.push(entry); groups.set(entry.key, group);
  }
  const entries: Record<string, WorkspaceEntry> = {};
  const conflictCopies: WorkspaceEntry[] = [];
  for (const [key, group] of groups) {
    group.sort(compareOperations);
    entries[key] = group[group.length - 1];
    if (entries[key].kind !== "scraps") continue;
    const revisions = new Map<number, WorkspaceEntry[]>();
    for (const entry of group) {
      const candidates = revisions.get(entry.revision) ?? [];
      candidates.push(entry); revisions.set(entry.revision, candidates);
    }
    for (const candidates of revisions.values()) {
      if (candidates.length < 2) continue;
      const winner = candidates[candidates.length - 1];
      for (const losing of candidates.slice(0, -1)) {
        if (losing.deleted || !losing.value || JSON.stringify(losing.value) === JSON.stringify(winner.value)) continue;
        const value = losing.value as { id: string; note: string };
        const id = `conflict_${value.id}_${losing.changeId}`;
        conflictCopies.push({ ...losing, key: `scraps:${id}`, revision: 1, changeId: `conflict_${losing.changeId}`, value: { ...value, id, note: `${value.note}\n\n[다른 기기와 동시에 수정한 내용]` } });
      }
    }
  }
  for (const copy of conflictCopies) if (!entries[copy.key] || compareOperations(copy, entries[copy.key]) > 0) entries[copy.key] = copy;
  const pending = { ...stored.pending };
  for (const [key, entry] of Object.entries(pending)) if (operations[entry.changeId]) delete pending[key];
  return { ...stored, entries, pending, operations, driveFiles: Array.from(new Set([...(stored.driveFiles ?? []), ...driveFiles])) };
}

/** A later edit made during upload depends on the just-published operation. */
export function acknowledgeReplicaOperations(stored: StoredWorkspace, submitted: PendingEntry[], operations: WorkspaceEntry[], fileIds: string[]): StoredWorkspace {
  const next = mergeReplicaSnapshot(stored, operations, fileIds);
  const pending = { ...next.pending };
  for (const prior of submitted) {
    const newer = pending[prior.key];
    const published = operations.find(operation => operation.changeId === prior.changeId);
    if (newer && newer.changeId !== prior.changeId && published) pending[prior.key] = { ...newer, baseRevision: published.revision };
  }
  return { ...next, pending };
}
