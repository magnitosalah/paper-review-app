import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodex } from "./codex.mjs";

const MAX_BODY_BYTES = 256_000;
const MAX_ANSWER_CHARS = 100_000;
const idPattern = /^[A-Za-z0-9_-]{16,128}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function configFromEnv(env = process.env) {
  return {
    secret: env.CODEX_RUNNER_SECRET ?? "", apiKey: env.OPENAI_API_KEY ?? "",
    models: [...new Set((env.CODEX_MODELS ?? "").split(",").map(value => value.trim()).filter(value => modelPattern.test(value)))],
    binary: env.CODEX_BINARY || "codex", dataDir: path.resolve(env.CODEX_RUNNER_DATA_DIR || "./.data"),
    maxConcurrent: Math.min(4, Math.max(1, Number.parseInt(env.CODEX_MAX_CONCURRENT || "2", 10) || 2)),
  };
}
export function configured(config) { return config.secret.length >= 32 && config.apiKey.trim().length > 0 && config.models.length > 0; }
export function authorized(header, secret) {
  if (secret.length < 32 || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7)); const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validateInput(body, models) {
  if (!body || typeof body !== "object" || typeof body.requestId !== "string" || !idPattern.test(body.requestId) || typeof body.model !== "string" || !models.includes(body.model)) return null;
  if (typeof body.system !== "string" || body.system.length < 1 || body.system.length > 12_000) return null;
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 40 || body.messages.at(-1)?.role !== "user") return null;
  if (body.messages.some(message => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim() || message.content.length > 120_000)) return null;
  if (body.messages.reduce((sum, message) => sum + message.content.length, 0) > 150_000) return null;
  return {requestId: body.requestId, model: body.model, system: body.system, messages: body.messages.map(({role, content}) => ({role, content}))};
}
export async function claimRequest(dataDir, requestId, hash) {
  await mkdir(dataDir, {recursive: true, mode: 0o700});
  const filename = path.join(dataDir, createHash("sha256").update(requestId).digest("hex") + ".json");
  let file;
  try { file = await open(filename, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A concurrent claimant may have created but not finished writing the receipt.
    let existing;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { existing = JSON.parse(await readFile(filename, "utf8")); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    if (!existing) return {claimed: false, filename, record: {status: "pending", hash}};
    return {claimed: false, filename, record: existing};
  }
  const record = {requestId, hash, status: "pending", createdAt: new Date().toISOString()};
  try { await file.writeFile(JSON.stringify(record)); } finally { await file.close(); }
  return {claimed: true, filename, record};
}
async function finishRequest(filename, record) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({...record, updatedAt: new Date().toISOString()}), {mode: 0o600});
  await rename(temporary, filename);
}
function json(response, status, value) { response.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"}); response.end(JSON.stringify(value)); }
async function readBody(request) {
  let size = 0; const pieces = [];
  for await (const piece of request) {
    size += piece.length; if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    pieces.push(piece);
  }
  return JSON.parse(Buffer.concat(pieces).toString("utf8"));
}

export function createRunnerServer({config = configFromEnv(), execute = runCodex} = {}) {
  let active = 0;
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") { json(response, configured(config) ? 200 : 503, {status: configured(config) ? "ready" : "not-configured"}); return; }
    if (request.method !== "POST" || request.url !== "/v1/chat") { json(response, 404, {error: "Not found"}); return; }
    if (!configured(config)) { json(response, 503, {error: "Codex runner is not configured"}); return; }
    if (!authorized(request.headers.authorization, config.secret)) { json(response, 401, {error: "Unauthorized"}); return; }
    if (!String(request.headers["content-type"] || "").startsWith("application/json")) { json(response, 415, {error: "JSON required"}); return; }
    if (active >= config.maxConcurrent) { json(response, 429, {error: "Codex runner is busy"}); return; }
    let input;
    try { input = validateInput(await readBody(request), config.models); }
    catch (error) { if (!response.destroyed) json(response, error.message === "BODY_TOO_LARGE" ? 413 : 400, {error: "Invalid request body"}); return; }
    if (!input) { json(response, 400, {error: "Invalid request or model"}); return; }
    // Recheck after the asynchronous body read so simultaneous callers cannot bypass the limit.
    if (active >= config.maxConcurrent) { json(response, 429, {error: "Codex runner is busy"}); return; }
    active++;
    let claim;
    try {
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      claim = await claimRequest(config.dataDir, input.requestId, hash);
      if (response.destroyed) {
        if (claim.claimed) await finishRequest(claim.filename, {...claim.record, status: "interrupted", answer: ""});
        return;
      }
      if (!claim.claimed) {
        if (claim.record.hash !== hash) { json(response, 409, {error: "Request ID already used"}); return; }
        if (claim.record.status !== "complete") { json(response, 409, {error: "Request already received; inspect the original status", status: claim.record.status}); return; }
        response.writeHead(200, {"content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store"});
        response.end(JSON.stringify({type: "delta", text: claim.record.answer}) + "\n" + JSON.stringify({type: "done"}) + "\n"); return;
      }
      const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(100_000)]);
      const onDisconnect = () => { if (!response.writableEnded) abort.abort(); };
      response.on("close", onDisconnect);
      response.writeHead(200, {"content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff"});
      response.flushHeaders();
      let answer = "";
      try {
        await execute(input, {apiKey: config.apiKey, binary: config.binary, signal, onDelta(text) {
          if (signal.aborted || response.destroyed) throw new Error("Request disconnected");
          answer += text; if (answer.length > MAX_ANSWER_CHARS) throw new Error("Answer too large");
          response.write(JSON.stringify({type: "delta", text}) + "\n");
        }});
        if (!answer.trim() || signal.aborted) throw new Error("Empty or interrupted response");
        await finishRequest(claim.filename, {...claim.record, status: "complete", answer});
        response.end(JSON.stringify({type: "done"}) + "\n");
      } catch {
        await finishRequest(claim.filename, {...claim.record, status: signal.aborted ? "interrupted" : "failed", answer}).catch(() => {});
        if (!response.destroyed) response.end(JSON.stringify({type: "error", message: "Codex response failed. Check runtime version, API credentials and model access."}) + "\n");
      } finally { response.off("close", onDisconnect); abort.abort(); }
    } catch {
      if (!response.headersSent) json(response, 503, {error: "Codex request storage is unavailable"});
      else if (!response.destroyed) response.end(JSON.stringify({type: "error", message: "Codex request failed"}) + "\n");
    } finally { active--; }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const server = createRunnerServer(); server.requestTimeout = 115_000; server.headersTimeout = 10_000;
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Paperdesk Codex runner listening on port ${port}\n`));
}
