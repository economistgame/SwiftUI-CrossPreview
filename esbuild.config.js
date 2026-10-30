const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// WebAssembly files loaded at runtime by web-tree-sitter (no native build needed)
const wasmFiles = [
  require.resolve('web-tree-sitter/tree-sitter.wasm'),
  path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out', 'tree-sitter-swift.wasm'),
];

function copyWasm() {
  fs.mkdirSync('dist', { recursive: true });
  for (const file of wasmFiles) {
    fs.copyFileSync(file, path.join('dist', path.basename(file)));
  }
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node16',
  logLevel: 'info',
};

async function build() {
  try {
    copyWasm();
    if (isWatch) {
      const context = await esbuild.context(buildOptions);
      await context.watch();
      console.log('Watching for changes...');
    } else {
      await esbuild.build(buildOptions);
      console.log('Build complete!');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
