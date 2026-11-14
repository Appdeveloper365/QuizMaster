/* Bundled local WebLLM models (shared by SageStrike and BrainForge).
 *
 * `scripts/fetch-model.mjs` downloads compiled model shards + the matching
 * WebLLM runtime wasm from HuggingFace into public/models/ and writes
 * bundled-manifest.json. The folder ships inside the app bundle (APK assets
 * through Capacitor), so a bundled model needs no runtime download: the
 * engine loads it from same-origin /models/ URLs via a custom appConfig.
 *
 * When the manifest is missing (weights not fetched — e.g. plain browser
 * builds), everything falls back to the stock prebuilt HuggingFace config.
 */

export interface BundledModel {
  id: string; // WebLLM model_id (matches prebuiltAppConfig entries)
  repo?: string; // source HuggingFace repo, informational
  modelLib: string; // wasm file name inside /models/<id>/
  sizeMB?: number;
}

const MANIFEST_URL = "/models/bundled-manifest.json";

let manifestPromise: Promise<Map<string, BundledModel>> | null = null;

async function loadManifest(): Promise<Map<string, BundledModel>> {
  const map = new Map<string, BundledModel>();
  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { models?: BundledModel[] };
    for (const model of data.models ?? []) if (model?.id && model.modelLib) map.set(model.id, model);
  } catch {
    /* No bundled weights in this build — fall back to stock downloads. */
  }
  return map;
}

export function getBundledModels(): Promise<Map<string, BundledModel>> {
  return (manifestPromise ??= loadManifest());
}

export async function isBundledModel(id: string): Promise<boolean> {
  return (await getBundledModels()).has(id);
}

/** Merge bundled local models into the stock WebLLM app config (removes the HuggingFace entry, adds the local one). */
export async function buildAppConfig(prebuiltAppConfig: any): Promise<any> {
  const bundled = await getBundledModels();
  if (!bundled.size || !prebuiltAppConfig?.model_list) return prebuiltAppConfig;
  const modelList = prebuiltAppConfig.model_list.filter((m: any) => !bundled.has(m.model_id));
  for (const [id, bundledInfo] of bundled) {
    const original = prebuiltAppConfig.model_list.find((m: any) => m.model_id === id) ?? {};
    modelList.push({
      ...original,
      model: `/models/${id}/`,
      model_id: id,
      model_lib: `/models/${id}/${bundledInfo.modelLib}`,
    });
  }
  return { ...prebuiltAppConfig, model_list: modelList };
}