import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { z } from "zod";
import type { OvermindSettings } from "../shared/settings.js";
import { fetchJson } from "./http.js";

type EmbeddingConfig = OvermindSettings["detection"]["embedding"];
export const BUILTIN_MODEL = "Xenova/all-MiniLM-L6-v2";
const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const OWNER = "paseo-plugin-overmind";
const VectorSchema = z.array(z.number().finite()).min(1);
const EmbeddingResponseSchema = z.object({ embeddings: z.array(VectorSchema).min(1) });
const TagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const SourceSchema = z
  .object({
    plugins: z.record(z.string(), z.object({ path: z.string() }).passthrough()).default({}),
  })
  .passthrough();
let runtimeDirectory: string | undefined;
let extractor: FeatureExtractionPipeline | undefined;
let preparing: Promise<void> | undefined;
let disposed = false;
let builtinState: {
  status: "idle" | "downloading" | "ready" | "error";
  progress: number;
  error: string | null;
} = { status: "idle", progress: 0, error: null };

function sourceDirectory(config: unknown) {
  return SourceSchema.parse(config).plugins[OWNER]?.path;
}

export async function configureEmbeddingRuntime(paseo: PaseoApi) {
  if (!runtimeDirectory) runtimeDirectory = sourceDirectory((await paseo.config.get()).config);
}

function loadTransformers(): typeof import("@huggingface/transformers") {
  if (!runtimeDirectory) {
    const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
    runtimeDirectory = sourceDirectory(
      JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")),
    );
  }
  if (!runtimeDirectory)
    throw new Error("Không tìm thấy thư mục plugin Overmind để nạp runtime embedding.");
  // Native ONNX binaries must stay beside their package, outside Paseo's evaluated JS bundle.
  const requireRuntime = createRequire(path.resolve(runtimeDirectory, "package.json"));
  return requireRuntime("@huggingface/transformers");
}

export function builtinEmbeddingStatus() {
  return { ...builtinState };
}

function validateVectors(vectors: number[][], count: number): number[][] {
  const parsed = z.array(VectorSchema).parse(vectors);
  if (
    parsed.length !== count ||
    parsed.some(
      (vector) => vector.length !== parsed[0].length || !vector.some((value) => value !== 0),
    )
  )
    throw new Error("Embedding trả về vector thiếu, rỗng hoặc không cùng số chiều.");
  return parsed;
}

export function prepareBuiltinEmbedding(): Promise<void> {
  if (extractor) return Promise.resolve();
  if (preparing) return preparing;
  if (disposed) return Promise.reject(new Error("Runtime embedding đã đóng."));
  builtinState = { status: "downloading", progress: 0, error: null };
  preparing = Promise.resolve()
    .then(async () => {
      try {
        const { env, pipeline } = loadTransformers();
        const cache = path.join(homedir(), ".cache", "overmind-models");
        env.allowLocalModels = false;
        env.useFSCache = true;
        env.cacheDir = cache;
        const model = await pipeline("feature-extraction", BUILTIN_MODEL, {
          dtype: "q8",
          device: "cpu",
          revision: MODEL_REVISION,
          cache_dir: cache,
          session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
          progress_callback: (event) => {
            if (!disposed && event.status === "progress" && event.file.endsWith(".onnx"))
              builtinState = { ...builtinState, progress: Math.min(99, event.progress) };
          },
        });
        if (disposed) {
          await model.dispose();
          return;
        }
        try {
          const sample = await model(["Overmind semantic sensor readiness test"], {
            pooling: "mean",
            normalize: true,
          });
          validateVectors(sample.tolist(), 1);
        } catch (error) {
          await model.dispose();
          throw error;
        }
        if (disposed) {
          await model.dispose();
          return;
        }
        extractor = model;
        builtinState = { status: "ready", progress: 100, error: null };
        return undefined;
      } catch (error) {
        if (!disposed)
          builtinState = {
            status: "error",
            progress: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        throw error;
      }
    })
    .finally(() => {
      preparing = undefined;
    });
  return preparing;
}

export async function listEmbeddingModels(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ models: string[] }> {
  const response = await fetchJson(new URL("/api/tags", baseUrl), {}, fetcher, 10000);
  if (!response.ok)
    throw new Error(`Ollama HTTP ${response.status}: không đọc được danh sách model.`);
  return { models: TagsSchema.parse(response.data).models.map((entry) => entry.name) };
}

export async function encodeTexts(
  config: EmbeddingConfig,
  input: string[],
  fetcher: typeof fetch = fetch,
): Promise<number[][]> {
  if (!input.length) return [];
  if (config.backend === "builtin") {
    await prepareBuiltinEmbedding();
    if (!extractor) throw new Error("Model ngữ nghĩa chưa sẵn sàng.");
    const result = await extractor(input, { pooling: "mean", normalize: true });
    return validateVectors(result.tolist(), input.length);
  }
  if (!config.model.trim()) throw new Error("Chưa chọn model embedding trên Ollama.");
  const response = await fetchJson(
    new URL("/api/embed", config.baseUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input, truncate: true }),
    },
    fetcher,
  );
  if (!response.ok)
    throw new Error(`Ollama HTTP ${response.status}: không tạo được embedding với model đã chọn.`);
  return validateVectors(EmbeddingResponseSchema.parse(response.data).embeddings, input.length);
}

export async function checkEmbedding(config: EmbeddingConfig, fetcher: typeof fetch = fetch) {
  let models: string[] = [];
  try {
    if (config.backend === "builtin") {
      if (builtinState.status !== "ready") {
        void prepareBuiltinEmbedding().catch(() => undefined);
        return {
          ok: false,
          message: "Đang chuẩn bị MiniLM. Theo dõi tiến trình rồi Test lại khi sẵn sàng.",
          dimensions: 0,
          models: [BUILTIN_MODEL],
        };
      }
      models = [BUILTIN_MODEL];
    } else {
      models = (await listEmbeddingModels(config.baseUrl, fetcher)).models;
      if (!config.model)
        return {
          ok: true,
          message: "Đã kết nối Ollama. Chọn model embedding rồi Test lại.",
          dimensions: 0,
          models,
        };
    }
    const vectors = await encodeTexts(config, ["Overmind embedding connection test"], fetcher);
    return {
      ok: true,
      message: `Model đã tạo vector ${vectors[0].length} chiều.`,
      dimensions: vectors[0].length,
      models,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      dimensions: 0,
      models,
    };
  }
}

export async function disposeEmbedding() {
  disposed = true;
  await preparing?.catch(() => undefined);
  await extractor?.dispose();
  extractor = undefined;
}
