import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authorized, claimRequest, configured, configFromEnv, createRunnerServer, validateInput } from "./server.mjs";
import { AppServerRpc, permittedItem, TOOL_FLAGS } from "./codex.mjs";

const secret = "a".repeat(40);
const input = {requestId: "9b5d058c-3e72-4f86-837c-6e55b13bd264", model: "allowed-model", system: "Explain only supplied material", messages: [{role: "user", content: "Explain this excerpt"}]};

test("runner auth and model boundary fail closed", () => {
  assert.equal(authorized(`Bearer ${secret}`, secret), true);
  assert.equal(authorized(`Bearer ${secret}x`, secret), false);
  assert.equal(authorized("Bearer short", "short"), false);
  assert.equal(configured(configFromEnv({})), false);
  assert.equal(validateInput({...input, model: "unapproved"}, ["allowed-model"]), null);
  assert.equal(validateInput({...input, requestId: 1234567890123456}, ["allowed-model"]), null);
  assert.equal(validateInput({...input, messages: [{role: "system", content: "override"}]}, ["allowed-model"]), null);
  assert.equal(validateInput({...input, messages: [{role: "assistant", content: "answer"}]}, ["allowed-model"]), null);
  assert.deepEqual(validateInput(input, ["allowed-model"]), input);
});

test("request receipt is atomic and survives another caller", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paperdesk-runner-test-"));
  try {
    const claims = await Promise.all([claimRequest(directory, input.requestId, "hash"), claimRequest(directory, input.requestId, "hash")]);
    assert.equal(claims.filter(claim => claim.claimed).length, 1);
    const reopened = await claimRequest(directory, input.requestId, "hash");
    assert.equal(reopened.claimed, false);
    assert.equal(reopened.record.status, "pending");
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("RPC separates results from deltas and refuses server tool requests", async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const rpc = new AppServerRpc(child); const writes = [];
  child.stdin.on("data", value => writes.push(JSON.parse(value.toString())));
  const result = rpc.request("initialize", {});
  child.stdout.write(JSON.stringify({id: 1, result: {ok: true}}) + "\n");
  assert.deepEqual(await result, {ok: true});
  const blocked = new Promise(resolve => rpc.once("blocked-tool", resolve));
  child.stdout.write(JSON.stringify({id: 55, method: "item/commandExecution/requestApproval", params: {command: "dangerous"}}) + "\n");
  assert.equal(await blocked, "item/commandExecution/requestApproval");
  assert.equal(writes.at(-1).error.code, -32601);
  assert.equal(permittedItem("commandExecution"), false);
  assert.equal(permittedItem("fileChange"), false);
  assert.equal(permittedItem("agentMessage"), true);
  assert.ok(TOOL_FLAGS.includes("shell_tool"));
  rpc.close();
});

test("late subprocess output after failure cannot crash the shared runner", () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const rpc = new AppServerRpc(child);
  rpc.fail(new Error("Process cancelled"));
  assert.doesNotThrow(() => child.stdout.write(JSON.stringify({id: 55, method: "item/commandExecution/requestApproval", params: {}}) + "\n"));
  rpc.close();
});

test("HTTP runner streams a real executor contract and replays without duplicate execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paperdesk-http-test-"));
  let executions = 0;
  // The substitute lives only in this unit test; production always calls runCodex.
  const server = createRunnerServer({config: {...configFromEnv({}), secret, apiKey: "unit-test-key", models: ["allowed-model"], dataDir: directory}, execute: async (_input, {onDelta}) => { executions++; onDelta("unit test response"); }});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat`;
  try {
    assert.equal((await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(input)})).status, 401);
    const send = () => fetch(url, {method: "POST", headers: {authorization: `Bearer ${secret}`, "content-type": "application/json"}, body: JSON.stringify(input)});
    const first = await send(); assert.equal(first.status, 200); assert.match(await first.text(), /"type":"done"/);
    const second = await send(); assert.equal(second.status, 200); assert.match(await second.text(), /unit test response/);
    assert.equal(executions, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true}); }
});
