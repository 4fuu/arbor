/**
 * The default embedder: a small bilingual retrieval model that runs in-process
 * through transformers.js and needs no key (docs/journal.md#search).
 *
 * The model files are fetched from the Hugging Face Hub on first use and cached
 * from then on. Nothing a host holds leaves it: only the text being embedded is
 * handed to the model, and the fetch is of the model, never of the text. A
 * deployment that must not fetch anything names a local directory with `model`,
 * or passes its own embed function - the only way text reaches anything outside
 * the host.
 *
 * transformers.js reads its model source from `env`, a process-global singleton,
 * so `cacheDir` and `endpoint` are written once here and apply to every pipeline
 * in the process. Neither has an environment variable: the setting is
 * `env.remoteHost`, which is what `endpoint` writes, and `env.cacheDir`, which
 * is what `cacheDir` writes.
 */

import { createRequire } from "node:module";
import type { Embedder } from "@4fu/arbor-interfaces";

/** The package that runs the model in-process. */
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

/** The model the channel embeds with when the caller names none. */
export const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";

/** The quantized build of the default model: 24 MB instead of 94 MB. */
const DEFAULT_DTYPE = "q8";

/** The pooling the default model was trained with. */
const DEFAULT_POOLING = "cls";

/** One text, embedded only to learn the model's dimension. */
const PROBE = "arbor";

export interface LocalEmbedderOptions {
  /** A Hugging Face repo id, or a path to a directory that holds a model. */
  model?: string;
  /** Where fetched model files are cached. */
  cacheDir?: string;
  /** Where models are fetched from, for a mirror. Defaults to huggingface.co. */
  endpoint?: string;
  /** The build to load. Defaults to `q8`. */
  dtype?: string;
  /** How the token vectors become one vector. Defaults to `cls`. */
  pooling?: string;
}

/** The default embedder, which has to load its model before it can embed. */
export interface LocalEmbedder extends Embedder {
  /** Load the model. Resolves once the channel can embed, rejects when it cannot. */
  load(): Promise<void>;
}

/** A loaded feature-extraction pipeline, as far as this package uses it. */
interface Extractor {
  (texts: readonly string[], options: Record<string, unknown>): Promise<{
    readonly dims: readonly number[];
    readonly data: Float32Array;
  }>;
}

/** Whether transformers.js is installed, without loading it. */
export function transformersInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default embedder, lazy: nothing is loaded and nothing is fetched until
 * `load` is called, so constructing a semantic channel costs nothing and a
 * journal that never searches never downloads a model.
 */
export function localEmbedder(options: LocalEmbedderOptions = {}): LocalEmbedder {
  const model = options.model ?? DEFAULT_MODEL;
  const pooling = options.pooling ?? DEFAULT_POOLING;
  let extractor: Extractor | null = null;
  let dimension = 0;

  const load = async (): Promise<void> => {
    const loaded: { pipeline?: unknown; env?: Record<string, unknown> } = await import(
      TRANSFORMERS_PACKAGE
    );
    const pipeline = loaded.pipeline;
    if (typeof pipeline !== "function") {
      throw new Error(`${TRANSFORMERS_PACKAGE} exports no pipeline`);
    }
    const env = loaded.env;
    if (env !== undefined && typeof env === "object") {
      if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir;
      // A mirror, for a network where huggingface.co is unreachable.
      if (options.endpoint !== undefined) env.remoteHost = options.endpoint;
    }
    extractor = (await (pipeline as (
      task: string,
      model: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>)("feature-extraction", model, {
      dtype: options.dtype ?? DEFAULT_DTYPE,
    })) as Extractor;
    // One short text, so the dimension is known before anything is stored: the
    // vector store is created with it.
    const [probe] = await embedWith(extractor, [PROBE], pooling);
    if (probe === undefined || probe.length === 0) {
      throw new Error(`${model} returned no embedding dimension`);
    }
    dimension = probe.length;
  };

  return {
    get dimension(): number {
      return dimension;
    },
    load,
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      if (extractor === null) await load();
      if (extractor === null) return [];
      return embedWith(extractor, texts, pooling);
    },
  };
}

async function embedWith(
  extractor: Extractor,
  texts: readonly string[],
  pooling: string,
): Promise<readonly number[][]> {
  if (texts.length === 0) return [];
  const output = await extractor(texts, { pooling, normalize: true });
  const width = output.dims[output.dims.length - 1] ?? 0;
  if (width <= 0) throw new Error("the embedding model returned no dimension");
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += 1) {
    vectors.push(Array.from(output.data.slice(index * width, (index + 1) * width)));
  }
  return vectors;
}
