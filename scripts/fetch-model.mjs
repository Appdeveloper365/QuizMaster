#!/usr/bin/env node
/**
 * Fetch an MLC-WebLLM model into public/models/ so it ships inside the app
 * bundle (web assets → Capacitor APK) instead of being downloaded from
 * HuggingFace at runtime.
 *
 * Usage:
 *   node scripts/fetch-model.mjs [modelId ...] [--dry-run]
 *   npm run fetch:model [-- --dry-run]
 *
 * Defaults to the app's fast companion model (Qwen3.5-0.8B-q4f16_1-MLC) —
 * the one SageStrike uses for quick hints and the dual-generation race.
 *
 * Model URLs are read from the INSTALLED copy of @mlc-ai/web-llm
 * (prebuiltAppConfig), so the fetched weights always match the WebLLM
 * version this app is built with. Re-run after upgrading web-llm.
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODELS_DIR = path.resolve("public/models");
const MANIFEST_PATH = path.join(MODELS_DIR, "bundled-manifest.json");
const DEFAULT_MODELS = ["Qwen3.5-0.8B-q4f16_1-MLC"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wanted = args.filter((arg) => !arg.startsWith("--"));
const modelIds = wanted.length > 0 ? wanted : DEFAULT_MODELS;

const MB = 1048576;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function resolveEntry(id) {
  let webllm;
  try {
    webllm = await import("@mlc-ai/web-llm");
  } catch (error) {
    fail(`Could not import @mlc-ai/web-llm (${error.message}). Run npm install first.`);
  }
  const list = webllm.prebuiltAppConfig?.model_list ?? [];
  const entry = list.find((model) => model.model_id === id);
  if (!entry) {
    fail(
      `Model "${id}" is not in the built-in WebLLM config. Examples of known ids:\n  ` +
        [...new Set(list.map((model) => model.model_id))].slice(0, 24).join("\n  ")
    );
  }
  return entry;
}

function huggingfaceRepo(modelUrl) {
  const match = String(modelUrl).match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)/);
  if (!match) fail(`Expected a HuggingFace model URL, got: ${modelUrl}`);
  return match[1];
}

function wasmUrl(entry) {
  const lib = String(entry.model_lib);
  if (/^https?:\/\//.test(lib)) return lib;
  // Relative path → resolve against the official binary-mlc-llm-libs repo.
  return `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/webllm-models/${lib}`;
}

async function fileSize(url) {
  const head = await fetch(url, { method: "HEAD" });
  if (head.ok) {
    const len = Number(head.headers.get("content-length") ?? 0);
    if (len > 0) return len;
  }
  // Some mirrors omit content-length on HEAD. Fall back to a ranged GET and
  // read the total from Content-Range (the body is aborted after headers).
  const ctrl = new AbortController();
  try {
    const ranged = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: ctrl.signal });
    const total = Number(String(ranged.headers.get("content-range") ?? "").split("/").pop() ?? 0);
    if (total > 0) return total;
  } catch {
    /* fall through to the hard error below */
  } finally {
    ctrl.abort();
  }
  fail(`Could not determine the size of ${url} (no content-length) — aborting.`);
}

/** Download url → dest, skipping when the file already exists with the right size. */
async function download(url, dest) {
  const total = await fileSize(url);
  if (total === 0) fail(`Server did not report a content-length for ${url}`);

  if (existsSync(dest)) {
    const existing = statSync(dest).size;
    if (existing === total) {
      console.log(`  · ${path.basename(dest)} — already complete (${(total / MB).toFixed(1)} MB), skipping`);
      return total;
    }
    console.log(`  · ${path.basename(dest)} — incomplete (${existing}/${total} bytes), re-downloading`);
  }

  if (dryRun) {
    console.log(`  · ${path.basename(dest)} — would fetch ${(total / MB).toFixed(1)} MB`);
    return total;
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) fail(`HTTP ${response.status} for ${url}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  const written = (await stat(dest)).size;
  if (written !== total) fail(`${path.basename(dest)} size mismatch (${written} ≠ ${total} bytes)`);
  console.log(`  ✓ ${path.basename(dest)} — ${(written / MB).toFixed(1)} MB`);
  return written;
}

async function fetchModel(id) {
  const entry = await resolveEntry(id);
  const repo = huggingfaceRepo(entry.model);
  const libUrl = wasmUrl(entry);

  console.log(`\n◆ ${id}`);
  console.log(`  weights: https://huggingface.co/${repo}`);
  console.log(`  runtime: ${libUrl}`);

  const treeResponse = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`);
  if (!treeResponse.ok) fail(`HTTP ${treeResponse.status} listing ${repo}`);
  const tree = await treeResponse.json();
  const files = tree.filter((item) => item.type === "file");

  let totalBytes = 0;
  let fileCount = 0;

  for (const file of files) {
    const url = `https://huggingface.co/${repo}/resolve/main/${file.path}`;
    totalBytes += await download(url, path.join(MODELS_DIR, id, file.path));
    fileCount += 1;
  }

  const libName = path.basename(libUrl).replace(/\?.*$/, "");
  totalBytes += await download(libUrl, path.join(MODELS_DIR, id, libName));
  fileCount += 1;

  console.log(`  = ${(totalBytes / MB).toFixed(1)} MB total (${fileCount} files)`);
  return { id, repo, modelLib: libName, fileCount, sizeMB: Math.round(totalBytes / MB) };
}

async function main() {
  const models = [];
  for (const id of modelIds) models.push(await fetchModel(id));

  if (!dryRun) {
    await mkdir(MODELS_DIR, { recursive: true });
    // Keep metadata from previous runs for models not in this invocation.
    let previous = [];
    try {
      const existing = JSON.parse((await import("node:fs")).readFileSync(MANIFEST_PATH, "utf8"));
      previous = (existing.models ?? []).filter((model) => !models.some((entry) => entry.id === model.id));
    } catch {
      /* first run */
    }
    const manifest = { version: 1, generatedAt: new Date().toISOString(), models: [...previous, ...models] };
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\n✓ manifest written: public/models/bundled-manifest.json`);
  }

  const grand = models.reduce((sum, model) => sum + model.sizeMB, 0);
  console.log(`\nDone${dryRun ? " (dry run — nothing written)" : ""}: ${models.length} model(s), ~${grand} MB added to the bundle.`);
  console.log("The models ship under /models/<model_id>/ at runtime; the APK grows by the same amount on `npm run build` + `npx cap sync`.");
}

main().catch((error) => fail(error?.message ?? String(error)));
