import type { RenderedChunk } from 'rollup';

export interface DependencyTreeContext {
  chunk: RenderedChunk;
  dynamicImport: boolean;
}

export interface DependencyTreeOptions {

  filter?: (context: DependencyTreeContext) => boolean;

  walk?: (context: DependencyTreeContext) => boolean;

}

/**
 * Returns the transitive dependencies for a certain chunk
 * @param chunk - the chunk to get the dependencies of
 * @param chunks - all chunks
 * @param [opts] - the options to use
 * @return the transitive dependencies for the given chunk
 */
export function dependenciesForTree(chunk: RenderedChunk, allChunks: RenderedChunk[], opts?: DependencyTreeOptions): Set<RenderedChunk> {
  const result = new Set<RenderedChunk>();
  const visited = new Set<string>();
  dependenciesForTrees(result, visited, chunk, allChunks, false, opts);
  return result;
}

function addChunk(ctx: DependencyTreeContext, result: Set<RenderedChunk>, opts: DependencyTreeOptions) {
  if (!opts || !opts.filter || opts.filter(ctx)) {
    result.add(ctx.chunk);
  }
}

const visitKey = (ctx: DependencyTreeContext) => ctx.chunk.fileName + ':' + ctx.dynamicImport;

function dependenciesForTrees(
    result: Set<RenderedChunk>,
    visited: Set<string>,
    chunkToResolve: RenderedChunk,
    allChunks: RenderedChunk[], 
    dynamicImport: boolean,
    opts?: DependencyTreeOptions) {

  const ctx = {chunk: chunkToResolve, dynamicImport};
  if (opts && opts.walk && !opts.walk(ctx)) {
    return;
  }
  // need to hand the case where we come across a chunk as a dynamic import and static import
  visited.add(visitKey(ctx));
  addChunk(ctx, result, opts);
  chunkToResolve.imports.concat(chunkToResolve.dynamicImports).forEach(fileName => {
    let chunk = allChunks.find(c => c.fileName === fileName);
    if (!chunk) {
      return;
    }

    // avoid cycles
    const dynamicImport = chunkToResolve.imports.indexOf(chunk.fileName) < 0;
    if (visited.has(visitKey({chunk, dynamicImport}))) {
      return;
    }

    dependenciesForTrees(result, visited, chunk, allChunks, dynamicImport, opts);
  });
}
