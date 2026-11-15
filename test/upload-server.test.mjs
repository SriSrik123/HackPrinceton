// Regression coverage for the shared server after merging uploads and angles search.
// Uses dummy keys and invalid search input; never calls Marble or xAI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function startServer(t, env = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rewind-server-test-"));
  const child = spawn(process.execPath, [new URL("../scripts/upload-server.mjs", import.meta.url).pathname], {
    env: { ...process.env, UPLOAD_PORT: "0", WLT_API_KEY: "", XAI_API_KEY: "", UPLOAD_PIN: "", TMPDIR: temp, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    const timeout = setTimeout(() => reject(new Error("Upload server startup timed out")), 5000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(errors || "Upload server exited")); });
  });
  const request = async (route, options) => {
    const res = await fetch(base + route, options);
    return { status: res.status, body: await res.json() };
  };
  return { request, temp };
}

test("party and angles routes coexist without configured API keys", async (t) => {
  const { request } = await startServer(t);
  for (const route of ["party", "angles"]) {
    const status = await request(`/api/${route}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "idle");
    assert.equal(status.body.keyConfigured, false);
    assert.equal(status.body.pinRequired, false);
  }
  assert.equal((await request("/api/party/draft", { method: "POST" })).status, 503);
  assert.equal((await request("/api/angles", { method: "POST", body: "{}" })).status, 503);
  assert.equal((await request("/api/missing")).status, 404);
});

test("PIN protects both workflows and authenticated draft uploads still work", async (t) => {
  const { request, temp } = await startServer(t, { WLT_API_KEY: "test-only", XAI_API_KEY: "test-only", UPLOAD_PIN: "2468" });
  for (const route of ["party", "angles"]) {
    const status = await request(`/api/${route}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.keyConfigured, true);
    assert.equal(status.body.pinRequired, true);
  }
  for (const route of ["party/draft", "party/file", "party/start", "angles"]) {
    assert.equal((await request(`/api/${route}`, { method: "POST" })).status, 401);
    assert.equal((await request(`/api/${route}`, { method: "POST", headers: { "x-pin": "wrong" } })).status, 401);
  }
  const options = { method: "POST", headers: { "x-pin": "2468" } };
  const angles = await request("/api/angles", { ...options, body: "{}" });
  assert.equal(angles.status, 400);
  assert.match(angles.body.error, /Choose a video/);
  assert.equal((await request("/api/angles/status")).body.state, "idle");
  const draft = await request("/api/party/draft", options);
  assert.equal(draft.status, 200);
  assert.match(draft.body.id, /^[0-9a-f-]{36}$/);
  const route = `/api/party/file?draft=${draft.body.id}`;
  assert.equal((await request(`${route}&kind=video&ext=exe`, { ...options, body: "test" })).status, 400);
  assert.equal((await request(`${route}&kind=video&ext=mp4`, { ...options, body: "test video" })).status, 200);
  assert.equal(await readFile(path.join(temp, "party-mode-uploads", draft.body.id, "video.mp4"), "utf8"), "test video");
  for (let i = 0; i < 4; i++) {
    assert.equal((await request(`${route}&kind=image&ext=png`, { ...options, body: "test picture" })).status, 200);
  }
  assert.equal((await request(`${route}&kind=image&ext=png`, { ...options, body: "extra picture" })).status, 400);
  assert.equal((await request("/api/party/start", { ...options, body: JSON.stringify({ draft: "invalid" }) })).status, 400);
  assert.equal((await request("/api/party/status")).body.state, "idle");
});
