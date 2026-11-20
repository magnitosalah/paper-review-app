import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDriveOperations, driveWorkspaceSession, parseOperationFile, readDriveOperations, uploadWorkspacePdf } from "./drive-workspace";
import type { WorkspaceEntry } from "./storage";

const { token, account } = vi.hoisted(() => ({ token: vi.fn(), account: vi.fn() }));
vi.mock("./drive", () => ({ getDriveAccessToken: token, getGoogleUser: account, DriveError: class extends Error { constructor(message: string, readonly code: string) { super(message); } } }));
const session = { ownerId: "google-owner", token: "test-access-token" };
const operation: WorkspaceEntry = { key: "drafts:device:chat", kind: "drafts", value: { chatId: "chat", deviceId: "device", text: "Question" }, deleted: false, revision: 1, changeId: "change-one", updatedAt: "2026-11-20T00:00:00Z" };
const operationFile = (ownerId = session.ownerId) => ({ format: "paperdesk-operations", version: 1, ownerId, deviceId: "device", operations: [operation] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  token.mockReset().mockResolvedValue(session.token);
  account.mockReset().mockResolvedValue({ id: session.ownerId, email: "owner@example.com" });
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Drive-backed workspace transport", () => {
  it("checks the account before returning an authenticated workspace session", async () => {
    await expect(driveWorkspaceSession(session.ownerId)).resolves.toEqual(session);
    account.mockResolvedValue({ id: "different-account", email: "other@example.com" });
    await expect(driveWorkspaceSession(session.ownerId)).rejects.toThrow("계정이 바뀌었습니다");
  });

  it("rejects foreign-account and malformed operation payloads", () => {
    expect(parseOperationFile(operationFile(), session.ownerId)).toEqual([operation]);
    expect(() => parseOperationFile(operationFile("different-account"), session.ownerId)).toThrow();
    expect(() => parseOperationFile({ ...operationFile(), operations: [{ ...operation, revision: -1 }] }, session.ownerId)).toThrow();
    expect(() => parseOperationFile({ ...operationFile(), operations: [{ ...operation, kind: "papers", value: { id: "bad" } }] }, session.ownerId)).toThrow();
  });

  it("paginates hidden operation files and downloads only unseen files", async () => {
    fetchMock.mockResolvedValueOnce(json({ files: [{ id: "known" }], nextPageToken: "page-two" }))
      .mockResolvedValueOnce(json({ files: [{ id: "new-file", size: "500" }] }))
      .mockResolvedValueOnce(json(operationFile()));
    const result = await readDriveOperations(session, ["known"]);
    expect(result).toEqual({ operations: [operation], fileIds: ["new-file"] });
    expect(String(fetchMock.mock.calls[0][0])).toContain("spaces=appDataFolder");
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=page-two");
    expect(String(fetchMock.mock.calls[2][0])).toContain("files/new-file?alt=media");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("only creates new hidden operation files instead of replacing a shared snapshot", async () => {
    fetchMock.mockResolvedValue(json({ id: "created-operation-file" }));
    expect(await appendDriveOperations(session, "device", [operation])).toEqual(["created-operation-file"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    const body = await (init.body as Blob).text();
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('"changeId":"change-one"');
    expect(body).not.toContain(session.token);
  });

  it("does not create a duplicate PDF when the same paper was already uploaded", async () => {
    fetchMock.mockResolvedValueOnce(json({ files: [{ id: "existing-pdf" }] }));
    expect(await uploadWorkspacePdf(session, "paper-one", new Blob(["%PDF-test"]), "paper.pdf")).toBe("existing-pdf");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexpected upload URL without leaking an access token", async () => {
    fetchMock.mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [{ id: "paperdesk-folder" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { location: "https://external.example/upload" } }));
    await expect(uploadWorkspacePdf({ ...session, ownerId: "upload-owner" }, "paper-two", new Blob(["%PDF-test"]))).rejects.toThrow("허용되지 않은 Drive 요청");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(call => new URL(String(call[0])).origin === "https://www.googleapis.com")).toBe(true);
  });
});
