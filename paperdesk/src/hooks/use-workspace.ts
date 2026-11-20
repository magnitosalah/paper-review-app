"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { emptyWorkspace, type Paper, type WorkspaceState } from "@/lib/types";
import { authorizeDriveWorkspace, disconnectDrive, googleAuthConfigured, prepareGoogleAuth } from "@/lib/client/drive";
import { appendDriveOperations, downloadWorkspacePdf, driveWorkspaceSession, readDriveOperations, uploadWorkspacePdf } from "@/lib/client/drive-workspace";
import { acknowledgeReplicaOperations, getDeviceId, loadWorkspace, materializeWorkspace, mergeReplicaSnapshot, newStoredWorkspace, persistWorkspace, readPdf, recordChanges, removePdf, storePdf, type StoredWorkspace, type WorkspaceEntry } from "@/lib/client/storage";

type User = { id: string; email?: string };
const localStatus = (configured: boolean) => configured ? "이 기기에 저장됨 · Google Drive 연결 가능" : "이 기기에 저장됨 · Google 연결 미설정";
const scopeFor = (user: User | null) => user ? `google:${user.id}` : "local";

export function useWorkspace() {
  const [state, renderState] = useState<WorkspaceState>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("기기 저장소 여는 중");
  const [user, setUser] = useState<User | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const callerScope = scopeFor(user);
  const cloudReady = googleAuthConfigured();
  const stateRef = useRef(state), storedRef = useRef<StoredWorkspace>(newStoredWorkspace());
  const scopeRef = useRef("local"), userRef = useRef<User | null>(null), deviceRef = useRef("");
  const generationRef = useRef(0), readyRef = useRef(false), syncingRef = useRef(false), hasSyncedRef = useRef(false), mountedRef = useRef(true);
  const persistenceRef = useRef<Promise<void>>(Promise.resolve());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const showState = useCallback((next: WorkspaceState) => { stateRef.current = next; renderState(next); }, []);

  const persist = useCallback(async () => {
    const scope = scopeRef.current, generation = generationRef.current, snapshot = storedRef.current;
    const task = persistenceRef.current.catch(() => {}).then(() => persistWorkspace(scope, snapshot));
    persistenceRef.current = task;
    try { await task; }
    catch {
      if (generation === generationRef.current && mountedRef.current) setStatus("기기 저장 실패 · 저장 공간과 브라우저 권한을 확인해 주세요");
      throw new Error("기기 저장에 실패했습니다. 이 탭을 닫기 전에 기록을 내보내 주세요.");
    }
  }, []);

  const scheduleSync = useCallback(() => {
    // Bound the wait during continuous streaming while batching ordinary typing changes.
    if (syncTimer.current || !userRef.current) return;
    const delay = stateRef.current.messages.some(message => message.status === "streaming") ? 8000 : 2000;
    syncTimer.current = setTimeout(() => { syncTimer.current = undefined; void syncRef.current().catch(() => {}); }, delay);
  }, []);

  const setState: Dispatch<SetStateAction<WorkspaceState>> = useCallback(update => {
    if (!readyRef.current || scopeRef.current !== callerScope) return;
    const previous = stateRef.current, next = typeof update === "function" ? update(previous) : update;
    storedRef.current = recordChanges(storedRef.current, previous, next, deviceRef.current);
    showState(next);
    if (!syncingRef.current) setStatus("기기에 저장 중");
    const generation = generationRef.current;
    void persist().then(() => {
      if (generation !== generationRef.current || !mountedRef.current) return;
      if (!syncingRef.current) setStatus(userRef.current ? "기기에 저장됨 · Drive 동기화 대기" : localStatus(cloudReady));
      scheduleSync();
    }).catch(() => {});
    const retained = new Set(next.papers.map(paper => paper.id));
    for (const paper of previous.papers) if (!retained.has(paper.id)) void removePdf(scopeRef.current, paper.id).catch(() => {});
  }, [callerScope, cloudReady, persist, scheduleSync, showState]);

  const syncNow = useCallback(async () => {
    const owner = userRef.current;
    if (!readyRef.current) return;
    if (!owner) { setStatus(localStatus(cloudReady)); return; }
    if (syncingRef.current) return;
    const generation = generationRef.current, scope = scopeRef.current;
    const current = () => mountedRef.current && generation === generationRef.current;
    syncingRef.current = true; setStatus("내 Google Drive와 동기화 중");
    let pdfProblem = "";
    try {
      const session = await driveWorkspaceSession(owner.id);
      if (!current()) return;
      const remote = await readDriveOperations(session, storedRef.current.driveFiles);
      if (!current()) return;
      storedRef.current = mergeReplicaSnapshot(storedRef.current, remote.operations, remote.fileIds);
      // Another device may already have saved this PDF. Original Drive files are never copied here.
      const merged = materializeWorkspace(storedRef.current, deviceRef.current);
      for (const paper of merged.papers.filter(item => item.source === "local" && !item.storagePath?.startsWith("drive:"))) {
        if (!current()) return;
        try {
          const blob = await readPdf(scope, paper.id);
          if (!current()) return;
          if (!blob) { pdfProblem = "일부 PDF의 기기 사본을 다시 연결해 주세요"; continue; }
          const driveFileId = await uploadWorkspacePdf(session, paper.id, blob, paper.filename);
          if (!current()) return;
          const base = materializeWorkspace(storedRef.current, deviceRef.current);
          const next = { ...base, papers: base.papers.map(item => item.id === paper.id ? { ...item, storagePath: `drive:${driveFileId}`, driveFileId, updatedAt: new Date().toISOString() } : item) };
          storedRef.current = recordChanges(storedRef.current, base, next, deviceRef.current);
        } catch (error) { pdfProblem = error instanceof Error ? error.message : "PDF 업로드 대기"; }
      }
      if (!current()) return;
      const submitted = Object.values(storedRef.current.pending);
      const operations: WorkspaceEntry[] = submitted.map(entry => ({ key: entry.key, kind: entry.kind, value: entry.value, deleted: entry.deleted, revision: entry.baseRevision + 1, changeId: entry.changeId, updatedAt: entry.updatedAt }));
      const fileIds = await appendDriveOperations(session, deviceRef.current, operations);
      if (!current()) return;
      storedRef.current = acknowledgeReplicaOperations(storedRef.current, submitted, operations, fileIds);
      const next = materializeWorkspace(storedRef.current, deviceRef.current);
      if (hasSyncedRef.current) next.readingPositions = { ...next.readingPositions, ...stateRef.current.readingPositions };
      showState(next); await persist();
      if (!current()) return;
      hasSyncedRef.current = true;
      const pendingCount = Object.keys(storedRef.current.pending).length;
      setStatus(pdfProblem ? `기록 저장됨 · ${pdfProblem}` : pendingCount ? "추가 변경 Drive 동기화 대기" : "Google Drive 동기화 완료");
      if (pendingCount) scheduleSync();
    } catch (error) {
      if (current()) setStatus(`Drive 동기화 실패 · ${error instanceof Error ? error.message : "기기 사본은 유지됩니다."}`);
      throw error;
    } finally { if (current()) syncingRef.current = false; }
  }, [cloudReady, persist, scheduleSync, showState]);
  syncRef.current = syncNow;

  const switchAccount = useCallback(async (nextUser: User | null) => {
    const scope = scopeFor(nextUser), generation = ++generationRef.current;
    readyRef.current = false; syncingRef.current = false; hasSyncedRef.current = false;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = undefined;
    setReady(false); setUser(nextUser); userRef.current = nextUser; scopeRef.current = scope;
    showState(emptyWorkspace()); storedRef.current = newStoredWorkspace();
    setStatus("계정의 기기 저장소 여는 중");
    try {
      const [device, stored] = await Promise.all([getDeviceId(), loadWorkspace(scope)]);
      if (!mountedRef.current || generation !== generationRef.current) return;
      deviceRef.current = device; storedRef.current = stored;
      showState(materializeWorkspace(stored, device)); readyRef.current = true; setReady(true);
      setStatus(nextUser ? "기기 사본 열림 · Drive 동기화 대기" : localStatus(cloudReady));
      if (nextUser) scheduleSync();
    } catch (error) {
      if (mountedRef.current && generation === generationRef.current) setStatus("기기 저장소를 열 수 없습니다 · 브라우저 저장 권한을 확인해 주세요");
      throw error;
    }
  }, [cloudReady, scheduleSync, showState]);

  useEffect(() => {
    mountedRef.current = true;
    // Tokens stay in memory; a reload starts locally and asks for an explicit reconnect.
    void switchAccount(null).catch(() => {});
    if (cloudReady) void prepareGoogleAuth().catch(() => {});
    const onFocus = () => { if (document.visibilityState === "visible" && userRef.current) void syncRef.current().catch(() => {}); };
    const onOnline = () => { if (userRef.current) void syncRef.current().catch(() => {}); };
    document.addEventListener("visibilitychange", onFocus); window.addEventListener("online", onOnline);
    const interval = setInterval(onFocus, 30_000);
    return () => {
      mountedRef.current = false; generationRef.current += 1;
      clearInterval(interval); if (syncTimer.current) clearTimeout(syncTimer.current); syncTimer.current = undefined;
      document.removeEventListener("visibilitychange", onFocus); window.removeEventListener("online", onOnline);
    };
  }, [cloudReady, switchAccount]);

  const signIn = useCallback(async () => {
    if (!cloudReady) throw new Error("Google OAuth 클라이언트 설정이 필요합니다.");
    // Start the popup within the user gesture, before waiting for IndexedDB.
    const [nextUser] = await Promise.all([authorizeDriveWorkspace(), persist()]);
    setAuthRevision(value => value + 1);
    if (userRef.current?.id === nextUser.id && readyRef.current) {
      setUser(nextUser); userRef.current = nextUser; await syncRef.current();
    } else await switchAccount(nextUser);
  }, [cloudReady, persist, switchAccount]);

  const signOut = useCallback(async () => {
    await persist(); disconnectDrive(); await switchAccount(null);
  }, [persist, switchAccount]);

  const savePdf = useCallback(async (paperId: string, blob: Blob, options?: { localOnly?: boolean; filename?: string }): Promise<{ storagePath?: string; driveFileId?: string }> => {
    if (!readyRef.current) throw new Error("기기 저장소를 여는 중입니다.");
    if (scopeRef.current !== callerScope) throw new Error("계정이 변경되었습니다. 파일을 다시 선택해 주세요.");
    const generation = generationRef.current, owner = userRef.current;
    await storePdf(scopeRef.current, paperId, blob);
    if (generation !== generationRef.current) throw new Error("계정이 변경되었습니다. 파일을 다시 선택해 주세요.");
    if (!owner || options?.localOnly) return {};
    try {
      const session = await driveWorkspaceSession(owner.id);
      if (generation !== generationRef.current) throw new Error("계정이 변경되었습니다.");
      const driveFileId = await uploadWorkspacePdf(session, paperId, blob, options?.filename);
      if (generation !== generationRef.current) throw new Error("계정이 변경되었습니다.");
      return { storagePath: `drive:${driveFileId}`, driveFileId };
    } catch {
      if (generation !== generationRef.current) throw new Error("계정이 변경되었습니다. 파일을 다시 선택해 주세요.");
      setStatus("PDF는 이 기기에 저장됨 · Drive 업로드 대기"); return {};
    }
  }, [callerScope, authRevision]);

  const loadPdf = useCallback(async (paper: Paper): Promise<Blob | null> => {
    if (scopeRef.current !== callerScope) return null;
    const scope = scopeRef.current, generation = generationRef.current;
    const local = await readPdf(scope, paper.id);
    if (generation !== generationRef.current) return null;
    if (local) return local;
    const owner = userRef.current;
    const fileId = paper.storagePath?.startsWith("drive:") ? paper.storagePath.slice(6) : paper.driveFileId;
    if (!owner || !fileId) return null;
    const session = await driveWorkspaceSession(owner.id);
    if (generation !== generationRef.current) return null;
    const data = await downloadWorkspacePdf(session, fileId);
    if (generation !== generationRef.current) return null;
    if (paper.contentHash) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await data.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== paper.contentHash) { setStatus("Drive PDF 원본이 변경됨 · 새 버전으로 다시 연결해 주세요"); return null; }
    }
    await storePdf(scope, paper.id, data);
    return generation === generationRef.current ? data : null;
  }, [callerScope, authRevision]);

  return { state, setState, ready, status, user, cloudReady, signIn, signOut, syncNow, savePdf, loadPdf };
}
