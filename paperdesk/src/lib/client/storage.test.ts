import { describe, expect, it } from "vitest";
import { emptyWorkspace, type Paper, type Scrap, type WorkspaceState } from "@/lib/types";
import { acceptRemoteEntries, acknowledgeEntry, acknowledgeReplicaOperations, materializeWorkspace, mergeReplicaSnapshot, newStoredWorkspace, recordChanges, type WorkspaceEntry } from "./storage";

const paper: Paper = { id: "paper-one", title: "논문", filename: "paper.pdf", source: "local", createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z" };
const scrap = (id: string): Scrap => ({ id, paperId: paper.id, page: 1, text: "Evidence", originalText: "Evidence", rects: [], note: "", createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z" });
const entry = (key: string, kind: WorkspaceEntry["kind"], value: unknown, revision = 1): WorkspaceEntry => ({ key, kind, value, revision, deleted: false, changeId: `change-${revision}`, updatedAt: "2026-11-20T00:00:00Z" });

describe("workspace record merging", () => {
  it("preserves independent scraps added on two devices without uploading a stale snapshot", () => {
    const baseline = { ...emptyWorkspace(), papers: [paper] };
    let local = acceptRemoteEntries(newStoredWorkspace(), [entry(`papers:${paper.id}`, "papers", paper)]);
    local = recordChanges(local, baseline, { ...baseline, scraps: [scrap("local")] }, "device-a");
    local = acceptRemoteEntries(local, [entry("scraps:remote", "scraps", scrap("remote"))]);
    expect(Object.keys(local.pending)).toEqual(["scraps:local"]);
    expect(materializeWorkspace(local, "device-a").scraps.map(item => item.id).sort()).toEqual(["local", "remote"]);
  });

  it("keeps an edit made while the earlier version is being uploaded", () => {
    const before: WorkspaceState = { ...emptyWorkspace(), papers: [paper], scraps: [scrap("one")] };
    let stored = acceptRemoteEntries(newStoredWorkspace(), [entry("scraps:one", "scraps", before.scraps[0])]);
    const first = { ...before, scraps: [{ ...before.scraps[0], note: "first edit" }] };
    stored = recordChanges(stored, before, first, "device-a");
    const submitted = stored.pending["scraps:one"];
    stored = recordChanges(stored, first, { ...first, scraps: [{ ...first.scraps[0], note: "second edit" }] }, "device-a");
    stored = acknowledgeEntry(stored, submitted, entry("scraps:one", "scraps", first.scraps[0], 2));
    expect((stored.pending["scraps:one"].value as Scrap).note).toBe("second edit");
    expect(stored.pending["scraps:one"].baseRevision).toBe(2);
  });

  it("honors cloud deletion tombstones and hides children of deleted papers", () => {
    let stored = acceptRemoteEntries(newStoredWorkspace(), [entry(`papers:${paper.id}`, "papers", paper), entry("scraps:one", "scraps", scrap("one"))]);
    stored = acceptRemoteEntries(stored, [{ ...entry(`papers:${paper.id}`, "papers", paper, 2), deleted: true }]);
    stored = acceptRemoteEntries(stored, [entry(`papers:${paper.id}`, "papers", paper, 1)]);
    const state = materializeWorkspace(stored, "device-a");
    expect(state.papers).toEqual([]);
    expect(state.scraps).toEqual([]);
  });

  it("resumes the latest reading position while preserving separate device drafts", () => {
    const stored = acceptRemoteEntries(newStoredWorkspace(), [
      entry("readingPositions:a:p", "readingPositions", { paperId: "p", deviceId: "a", position: { page: 3, scale: 1, updatedAt: "2026-11-20T00:00:00Z" } }),
      { ...entry("readingPositions:b:p", "readingPositions", { paperId: "p", deviceId: "b", position: { page: 9, scale: 2, updatedAt: "2026-11-20T01:00:00Z" } }), updatedAt: "2026-11-20T01:00:00Z" },
      entry("drafts:a:c", "drafts", { chatId: "c", deviceId: "a", text: "PC draft" }),
      entry("drafts:b:c", "drafts", { chatId: "c", deviceId: "b", text: "Phone draft" }),
    ]);
    expect(materializeWorkspace(stored, "a").readingPositions.p.page).toBe(9);
    expect(materializeWorkspace(stored, "b").readingPositions.p.page).toBe(9);
    expect(materializeWorkspace(stored, "a").drafts.c).toBe("PC draft");
    expect(materializeWorkspace(stored, "b").drafts.c).toBe("Phone draft");
    expect(materializeWorkspace(stored, "new-device").readingPositions.p.page).toBe(9);
  });

  it("restores quote-only drafts from the same record without mixing another device's attachment", () => {
    const quoteA = { id: "quote-a", paperId: paper.id, page: 2, text: "PC evidence", originalText: "PC evidence", rects: [] };
    const quoteB = { ...quoteA, id: "quote-b", page: 3, text: "Phone evidence" };
    let stored = recordChanges(newStoredWorkspace(), emptyWorkspace(), { ...emptyWorkspace(), draftQuotes: { chat: quoteA } }, "device-a");
    expect(Object.keys(stored.pending)).toEqual(["drafts:device-a:chat"]);
    stored = acceptRemoteEntries(stored, [{ ...entry("drafts:device-b:chat", "drafts", { chatId: "chat", deviceId: "device-b", text: "Phone question", quote: quoteB }), updatedAt: "2099-01-01T00:00:00Z" }]);
    // Structured cloning simulates the IndexedDB persistence boundary.
    const restoredA = materializeWorkspace(structuredClone(stored), "device-a");
    const restoredB = materializeWorkspace(structuredClone(stored), "device-b");
    expect(restoredA.drafts.chat).toBe("");
    expect(restoredA.draftQuotes?.chat).toEqual(quoteA);
    expect(restoredB.drafts.chat).toBe("Phone question");
    expect(restoredB.draftQuotes?.chat).toEqual(quoteB);
    const cleared = recordChanges(stored, restoredA, { ...restoredA, draftQuotes: { chat: null } }, "device-a");
    expect(materializeWorkspace(cleared, "device-a").draftQuotes?.chat).toBeNull();
  });

  it("loads older text-only draft records without requiring a migration", () => {
    const stored = acceptRemoteEntries(newStoredWorkspace(), [entry("drafts:a:chat", "drafts", { chatId: "chat", deviceId: "a", text: "Existing question" })]);
    const restored = materializeWorkspace(stored, "a");
    expect(restored.drafts.chat).toBe("Existing question");
    expect(restored.draftQuotes?.chat).toBeNull();
    expect(materializeWorkspace(newStoredWorkspace(), "a").draftQuotes).toEqual({});
  });
});

describe("immutable Drive replica convergence", () => {
  const operation = (key: string, kind: WorkspaceEntry["kind"], value: unknown, revision: number, changeId: string): WorkspaceEntry => ({ ...entry(key, kind, value, revision), changeId });
  const paperOperation = operation(`papers:${paper.id}`, "papers", paper, 1, "paper-create");

  it("merges concurrent additions in either download order and ignores duplicate uploads", () => {
    const a = operation("scraps:a", "scraps", scrap("a"), 1, "device-a-create");
    const b = operation("scraps:b", "scraps", scrap("b"), 1, "device-b-create");
    const first = mergeReplicaSnapshot(mergeReplicaSnapshot(newStoredWorkspace(), [paperOperation, a]), [b, a]);
    const second = mergeReplicaSnapshot(mergeReplicaSnapshot(newStoredWorkspace(), [b, paperOperation]), [a]);
    expect(first.entries).toEqual(second.entries);
    expect(Object.keys(first.operations ?? {})).toHaveLength(3);
    expect(materializeWorkspace(first, "device-a").scraps.map(value => value.id).sort()).toEqual(["a", "b"]);
  });

  it("preserves both simultaneously edited notes with a stable conflict copy on every device", () => {
    const initial = operation("scraps:one", "scraps", scrap("one"), 1, "initial");
    const a = operation("scraps:one", "scraps", { ...scrap("one"), note: "PC note" }, 2, "edit-a");
    const b = operation("scraps:one", "scraps", { ...scrap("one"), note: "Phone note" }, 2, "edit-b");
    const first = mergeReplicaSnapshot(newStoredWorkspace(), [paperOperation, initial, a, b]);
    const second = mergeReplicaSnapshot(newStoredWorkspace(), [b, a, initial, paperOperation]);
    expect(first.entries).toEqual(second.entries);
    const notes = materializeWorkspace(first, "device-a").scraps.map(value => value.note);
    expect(notes).toHaveLength(2);
    expect(notes.some(note => note.includes("PC note"))).toBe(true);
    expect(notes.some(note => note.includes("Phone note"))).toBe(true);
    const conflictKey = Object.keys(first.entries).find(key => key.startsWith("scraps:conflict_"))!;
    const deletion = { ...operation(conflictKey, "scraps", first.entries[conflictKey].value, 2, "delete-conflict"), deleted: true };
    expect(materializeWorkspace(mergeReplicaSnapshot(first, [deletion]), "device-a").scraps).toHaveLength(1);
  });

  it("keeps deletion tombstones when stale history arrives later", () => {
    const old = operation("scraps:one", "scraps", scrap("one"), 1, "initial");
    const deleted = { ...operation("scraps:one", "scraps", scrap("one"), 2, "delete"), deleted: true };
    let stored = mergeReplicaSnapshot(newStoredWorkspace(), [paperOperation, deleted]);
    stored = mergeReplicaSnapshot(stored, [old]);
    expect(materializeWorkspace(stored, "device-a").scraps).toEqual([]);
  });

  it("acknowledges a lost-response retry without clearing a newer local edit", () => {
    const before = { ...emptyWorkspace(), papers: [paper], scraps: [scrap("one")] };
    let stored = mergeReplicaSnapshot(newStoredWorkspace(), [paperOperation, operation("scraps:one", "scraps", scrap("one"), 1, "initial")]);
    const first = { ...before, scraps: [{ ...before.scraps[0], note: "first edit" }] };
    stored = recordChanges(stored, before, first, "device-a");
    const submitted = stored.pending["scraps:one"];
    const published = { ...submitted, revision: submitted.baseRevision + 1 };
    expect(mergeReplicaSnapshot(stored, [published]).pending).toEqual({});
    stored = recordChanges(stored, first, { ...first, scraps: [{ ...first.scraps[0], note: "second edit" }] }, "device-a");
    stored = acknowledgeReplicaOperations(stored, [submitted], [published], ["drive-file"]);
    expect((stored.pending["scraps:one"].value as Scrap).note).toBe("second edit");
    expect(stored.pending["scraps:one"].baseRevision).toBe(2);
    expect(stored.driveFiles).toEqual(["drive-file"]);
  });

  it("prefers a completed answer to a concurrent stale pending copy", () => {
    const message = { id: "reply", chatId: "chat", role: "assistant", content: "Saved answer", provider: "gemini", model: "configured", createdAt: "2026-11-20T00:00:00Z", status: "complete" };
    const completed = operation("messages:reply", "messages", message, 2, "completed");
    const stale = { ...operation("messages:reply", "messages", { ...message, content: "", status: "pending" }, 2, "stale"), updatedAt: "2099-01-01T00:00:00Z" };
    const stored = mergeReplicaSnapshot(newStoredWorkspace(), [completed, stale]);
    expect(stored.entries["messages:reply"].value).toEqual(message);
  });
});
