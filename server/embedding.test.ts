import type { PaseoApi } from "@getpaseo/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  env: {},
  pipeline: vi.fn(),
  load: vi.fn(),
}));

vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  createRequire: () => runtime.load,
}));

const ollama = {
  backend: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  model: "all-minilm:latest",
};
const builtin = { ...ollama, backend: "builtin" as const, model: "" };

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

async function moduleUnderTest() {
  const embedding = await import("./embedding.js");
  await embedding.configureEmbeddingRuntime({
    config: {
      get: async () => ({
        config: { plugins: { "paseo-plugin-overmind": { path: "test-runtime" } } },
      }),
    },
  } as unknown as PaseoApi);
  return embedding;
}

function fakeModel() {
  return Object.assign(
    vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => [0.6, 0.8]) })),
    { dispose: vi.fn(async () => undefined) },
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.pipeline.mockReset();
  runtime.load.mockReset();
  runtime.load.mockReturnValue({ env: runtime.env, pipeline: runtime.pipeline });
});

describe("Ollama embedding", () => {
  test("discovers locally installed model names", async () => {
    const { listEmbeddingModels } = await moduleUnderTest();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ models: [{ name: "all-minilm:latest" }, { name: "qwen3-embedding:0.6b" }] }),
      );
    await expect(listEmbeddingModels(ollama.baseUrl, fetcher)).resolves.toEqual({
      models: ["all-minilm:latest", "qwen3-embedding:0.6b"],
    });
    expect(String(fetcher.mock.calls[0][0])).toBe("http://127.0.0.1:11434/api/tags");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("sends the selected model and input batch to /api/embed", async () => {
    const { encodeTexts } = await moduleUnderTest();
    const vectors = [
      [1, 0],
      [0, 1],
    ];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ embeddings: vectors }));
    await expect(encodeTexts(ollama, ["first", "second"], fetcher)).resolves.toEqual(vectors);
    expect(String(fetcher.mock.calls[0][0])).toBe("http://127.0.0.1:11434/api/embed");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ model: ollama.model, input: ["first", "second"], truncate: true }),
    });
    expect(runtime.load).not.toHaveBeenCalled();
  });

  test.each([
    ["missing rows", [[1, 2]]],
    ["empty vectors", [[], []]],
    ["inconsistent dimensions", [[1, 2], [3]]],
    [
      "zero vector",
      [
        [0, 0],
        [1, 2],
      ],
    ],
    [
      "nonfinite values",
      [
        [Number.NaN, 1],
        [1, 2],
      ],
    ],
  ])("rejects %s", async (_name, embeddings) => {
    const { encodeTexts } = await moduleUnderTest();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ embeddings }));
    await expect(encodeTexts(ollama, ["first", "second"], fetcher)).rejects.toThrow();
  });

  test("does not request an empty batch or an unselected model", async () => {
    const { encodeTexts } = await moduleUnderTest();
    const fetcher = vi.fn<typeof fetch>();
    await expect(encodeTexts(ollama, [], fetcher)).resolves.toEqual([]);
    await expect(encodeTexts({ ...ollama, model: " " }, ["text"], fetcher)).rejects.toThrow(
      "Chưa chọn model",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("surfaces discovery and inference HTTP failures", async () => {
    const { listEmbeddingModels, encodeTexts } = await moduleUnderTest();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(null, 503));
    await expect(listEmbeddingModels(ollama.baseUrl, fetcher)).rejects.toThrow("Ollama HTTP 503");
    fetcher.mockResolvedValue(response(null, 400));
    await expect(encodeTexts(ollama, ["text"], fetcher)).rejects.toThrow("Ollama HTTP 400");
  });

  test("only reports inference dimensions after the model creates a vector", async () => {
    const { checkEmbedding } = await moduleUnderTest();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ models: [{ name: ollama.model }] }))
      .mockResolvedValueOnce(response({ embeddings: [[1, 2, 3]] }));
    await expect(checkEmbedding(ollama, fetcher)).resolves.toMatchObject({
      ok: true,
      dimensions: 3,
      models: [ollama.model],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("distinguishes connectivity from model readiness", async () => {
    const { checkEmbedding } = await moduleUnderTest();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ models: [{ name: ollama.model }] }));
    await expect(checkEmbedding({ ...ollama, model: "" }, fetcher)).resolves.toMatchObject({
      ok: true,
      dimensions: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(checkEmbedding(ollama, fetcher)).resolves.toMatchObject({
      ok: false,
      dimensions: 0,
      message: "connect ECONNREFUSED",
    });
  });
});

describe("builtin embedding lifecycle", () => {
  test("shares preparation and becomes ready only after a real inference call", async () => {
    const embedding = await moduleUnderTest();
    const model = fakeModel();
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.pipeline.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({ status: "progress", file: "model_quantized.onnx", progress: 50 });
      await loaded;
      return model;
    });
    const first = embedding.prepareBuiltinEmbedding();
    const second = embedding.prepareBuiltinEmbedding();
    expect(first).toBe(second);
    expect(embedding.builtinEmbeddingStatus()).toMatchObject({ status: "downloading" });
    release();
    await first;
    expect(runtime.pipeline).toHaveBeenCalledTimes(1);
    expect(runtime.pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      embedding.BUILTIN_MODEL,
      expect.objectContaining({ dtype: "q8", device: "cpu", revision: expect.any(String) }),
    );
    expect(model).toHaveBeenCalledWith(["Overmind semantic sensor readiness test"], {
      pooling: "mean",
      normalize: true,
    });
    expect(embedding.builtinEmbeddingStatus()).toEqual({
      status: "ready",
      progress: 100,
      error: null,
    });
    await embedding.disposeEmbedding();
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid readiness vectors and allows retry", async () => {
    const embedding = await moduleUnderTest();
    const bad = fakeModel();
    bad.mockResolvedValue({ tolist: () => [[0, 0]] });
    const good = fakeModel();
    runtime.pipeline.mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    await expect(embedding.prepareBuiltinEmbedding()).rejects.toThrow("vector thiếu");
    expect(embedding.builtinEmbeddingStatus().status).toBe("error");
    expect(bad.dispose).toHaveBeenCalledTimes(1);
    await embedding.prepareBuiltinEmbedding();
    expect(embedding.builtinEmbeddingStatus().status).toBe("ready");
    await embedding.disposeEmbedding();
  });

  test("retries a synchronous runtime loading failure", async () => {
    const embedding = await moduleUnderTest();
    runtime.load.mockImplementationOnce(() => {
      throw new Error("runtime missing");
    });
    runtime.pipeline.mockResolvedValue(fakeModel());
    await expect(embedding.prepareBuiltinEmbedding()).rejects.toThrow("runtime missing");
    expect(embedding.builtinEmbeddingStatus().status).toBe("error");
    await embedding.prepareBuiltinEmbedding();
    expect(embedding.builtinEmbeddingStatus().status).toBe("ready");
    expect(runtime.load).toHaveBeenCalledTimes(2);
    await embedding.disposeEmbedding();
  });

  test("builtin test prepares asynchronously and never calls Ollama", async () => {
    const embedding = await moduleUnderTest();
    runtime.pipeline.mockResolvedValue(fakeModel());
    const fetcher = vi.fn<typeof fetch>();
    await expect(embedding.checkEmbedding(builtin, fetcher)).resolves.toMatchObject({
      ok: false,
      dimensions: 0,
    });
    await embedding.prepareBuiltinEmbedding();
    await expect(embedding.checkEmbedding(builtin, fetcher)).resolves.toMatchObject({
      ok: true,
      dimensions: 2,
    });
    expect(fetcher).not.toHaveBeenCalled();
    await embedding.disposeEmbedding();
  });
});
