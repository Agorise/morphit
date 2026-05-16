# rollup-dependency-tree

Extracts js `import` transitive dependencies from a Rollup `OutputChunk[]` so that those dependencies can be `preload`ed.

Originally authored for use in [Sapper](https://github.com/sveltejs/sapper).
