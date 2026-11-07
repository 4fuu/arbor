/**
 * The semantic channel the journal uses when the caller names none
 * (docs/journal.md#search).
 *
 * The spec calls for event text to be embedded and searched by meaning beside
 * the lexical indexes, and the default is zvec when `@4fu/arbor-search-zvec` is
 * installed: `resolveSemanticIndex` loads it, and the journal uses what it
 * returns when the caller names no channel. The package is an optional peer
 * dependency, so a deployment that leaves it out keeps working.
 *
 * What is left here is the absence that answers when the package is not there:
 * no channel, and search is exactly lexical. That is also the answer when the
 * package is installed but its vector store will not open - zvec's prebuilt
 * binary does not load on this platform, or another host holds the collection -
 * and when no embedding model is available, because the package says so by
 * handing back nothing.
 */

import { createRequire } from "node:module";
import type { SemanticIndex } from "@4fu/arbor-interfaces";

/** The package that holds the zvec semantic index, when a deployment installed it. */
const ZVEC_PACKAGE = "@4fu/arbor-search-zvec";

/** What that package exports, as far as this loader reads it. */
interface SemanticIndexPackage {
  createZvecIndex?: (options: { path: string }) => SemanticIndex | null;
}

/**
 * Load the zvec semantic index over a store beside the journal's own, or `null`
 * when it is not there: the package is not installed, or it holds no index.
 */
function loadZvec(path: string): SemanticIndex | null {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(ZVEC_PACKAGE);
  const create = (loaded as SemanticIndexPackage | null)?.createZvecIndex;
  if (typeof create !== "function") return null;
  const index: unknown = create({ path });
  if (index === null || typeof index !== "object") return null;
  const shape = index as { add?: unknown; search?: unknown };
  if (typeof shape.add !== "function" || typeof shape.search !== "function") return null;
  return index as SemanticIndex;
}

/**
 * The semantic channel a journal uses when the caller names none: the zvec one
 * when the package is installed and its store opens, and none otherwise.
 *
 * `load` replaces how the zvec package is loaded. A host that resolves modules
 * its own way passes its own; so does a test that has no zvec package to load. A
 * load that fails falls back rather than stopping the journal, because the
 * package is optional: it may be missing, or its prebuilt binary may not load on
 * this platform.
 */
export function resolveSemanticIndex(
  path: string,
  load: (path: string) => SemanticIndex | null = loadZvec,
): SemanticIndex | null {
  try {
    return load(path);
  } catch {
    return null;
  }
}
