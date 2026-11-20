import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimChatRequest, finishChatRequest, getChatRequest } from "./chat-requests";

let temporary: string;
const localUser = {id: "local-development"};
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "paperdesk-requests-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(temporary);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ALLOW_LOCAL_DEV", "true");
  vi.stubEnv("VERCEL", "");
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temporary).startsWith("paperdesk-requests-test-")) await rm(temporary, { recursive: true, force: true });
});

describe("durable request idempotency", () => {
  it("claims a concurrently repeated request only once", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => claimChatRequest(localUser, "request-one-123456", "same-hash")));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.every(result => result.request.status === "pending")).toBe(true);
    await expect(claimChatRequest(localUser, "request-one-123456", "different-hash")).rejects.toMatchObject({ status: 409 });
  });
  it("persists the answer and never executes a completed request again", async () => {
    await claimChatRequest(localUser, "request-two-123456", "hash");
    await finishChatRequest(localUser, "request-two-123456", { status: "complete", answer: "Saved answer" });
    const duplicate = await claimChatRequest(localUser, "request-two-123456", "hash");
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.request.answer).toBe("Saved answer");
    const unchanged = await finishChatRequest(localUser, "request-two-123456", { status: "failed", error: "late failure" });
    expect(unchanged.status).toBe("complete");
    const files = await readdir(path.join(temporary, ".local-data", "chat-requests"));
    expect(files).toHaveLength(1);
  });
  it("marks an abandoned request interrupted without silently retrying", async () => {
    await claimChatRequest(localUser, "request-three-123456", "hash");
    const directory = path.join(temporary, ".local-data", "chat-requests");
    const [filename] = await readdir(directory);
    const file = path.join(directory, filename);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
    expect((await getChatRequest(localUser, "request-three-123456"))?.status).toBe("interrupted");
    expect((await claimChatRequest(localUser, "request-three-123456", "hash")).claimed).toBe(false);
  });
  it("never enables local file persistence in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(claimChatRequest(localUser, "request-four-123456", "hash")).rejects.toMatchObject({ status: 403 });
  });
});
