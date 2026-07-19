import esbuild from 'esbuild';
import fse, { move } from 'fs-extra';
import glob from 'glob';
import { exec } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { buildWeb };

const entry = './src/index.ts';
const target = 'es2022';

let nodePath = path.resolve(process.argv[1]);
let modulePath = path.resolve(fileURLToPath(import.meta.url));
let isMain = nodePath === modulePath;

if (isMain) {
  console.log('building', entry);
  await buildWeb({ production: process.env.NODE_ENV === 'production' });
  console.log('finished build');
}

async function buildWeb({ production }) {
  let minify = !!production;

  // prepare kimchi_wasm.js with bundled wasm in function-wrapped form
  let bindings = await readFile('./src/bindings/compiled/web_bindings/kimchi_wasm.js', 'utf8');
  bindings = rewriteWasmBindings(bindings);
  let tmpBindingsPath = 'src/bindings/compiled/web_bindings/kimchi_wasm.tmp.js';
  await writeFile(tmpBindingsPath, bindings);
  await esbuild.build({
    entryPoints: [tmpBindingsPath],
    bundle: true,
    format: 'esm',
    outfile: tmpBindingsPath,
    target: 'esnext',
    plugins: [wasmPlugin()],
    allowOverwrite: true,
    sourcemap: true,
  });
  bindings = await readFile(tmpBindingsPath, 'utf8');
  bindings = rewriteBundledWasmBindings(bindings);
  await writeFile(tmpBindingsPath, bindings);

  // run typescript
  await execPromise('npx tsc -p tsconfig.web.json');

  // copy over pure js files
  await copy({
    './src/bindings/compiled/web_bindings/': './dist/web/web_bindings/',
    './src/bindings.d.ts': './dist/web/bindings.d.ts',
    './src/bindings.web.js': './dist/web/bindings.js',
    './src/bindings/js/web/': './dist/web/bindings/js/web/',
  });

  if (minify) {
    let o1jsWebPath = './dist/web/web_bindings/o1js_web.bc.js';
    let o1jsWeb = await readFile(o1jsWebPath, 'utf8');
    let { code } = await esbuild.transform(o1jsWeb, {
      target,
      logLevel: 'error',
      minify,
    });
    await writeFile(o1jsWebPath, code);
  }

  // overwrite kimchi_wasm with bundled version
  await copy({ [tmpBindingsPath]: './dist/web/web_bindings/kimchi_wasm.js' });
  await unlink(tmpBindingsPath);

  // move all .web.js files to their .js counterparts
  let webFiles = glob.sync('./dist/web/**/*.web.js');
  await Promise.all(
    webFiles.map((file) => move(file, file.replace('.web.js', '.js'), { overwrite: true }))
  );

  // run esbuild on the js entrypoint
  let jsEntry = path.basename(entry).replace('.ts', '.js');
  await esbuild.build({
    entryPoints: [`./dist/web/${jsEntry}`],
    bundle: true,
    format: 'esm',
    outfile: 'dist/web/index.js',
    resolveExtensions: ['.js', '.ts'],
    plugins: [wasmPlugin(), srcStringPlugin(), nodeStubPlugin()],
    dropLabels: ['CJS'],
    external: ['*.bc.js'],
    target,
    allowOverwrite: true,
    logLevel: 'error',
    minify,
    sourcemap: true,
  });
}

async function copy(copyMap) {
  let promises = [];
  for (let [source, target] of Object.entries(copyMap)) {
    promises.push(
      fse.copy(source, target, {
        recursive: true,
        overwrite: true,
        dereference: true,
      })
    );
  }
  await Promise.all(promises);
}

function execPromise(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, (err, stdout) => {
      if (err) {
        console.log(stdout);
        return rej(err);
      }
      res(stdout);
    })
  );
}

function rewriteWasmBindings(src) {
  src = src
    .replace("new URL('kimchi_wasm_bg.wasm', import.meta.url)", 'wasmCode')
    .replace('import.meta.url', '"/"');
  return `import wasmCode from './kimchi_wasm_bg.wasm';
  let startWorkers, terminateWorkers;  
${src}`;
}
function rewriteBundledWasmBindings(src) {
  let i = src.indexOf('export {');
  let exportSlice = src.slice(i);
  let defaultExport = exportSlice.match(/\w* as default/)[0];
  exportSlice = exportSlice
    .replace(defaultExport, `default: __wbg_init`)
    .replace('export', 'return');
  src = src.slice(0, i) + exportSlice;

  src = src.replace('var startWorkers;\n', '');
  src = src.replace('var terminateWorkers;\n', '');
  return `import { startWorkers, terminateWorkers } from '../bindings/js/web/worker-helpers.js'
export {kimchiWasm as default};
function kimchiWasm() {
  ${src}
}
kimchiWasm.deps = [startWorkers, terminateWorkers]`;
}

// node:* imports only sit on dynamic node-only paths (native backend
// loader, debug dumps); stub them so dist/web carries no node: scheme —
// downstream bundlers (Next/webpack, vite) choke on it even when unused.
function nodeStubPlugin() {
  return {
    name: 'node-stub-plugin',
    setup(build) {
      build.onResolve({ filter: /^node:(fs|module)$/ }, (args) => ({
        path: args.path,
        namespace: 'node-stub',
      }));
      // The whole native-backend subtree is node-only (its module top level
      // calls createRequire); stub it as a proxy that only throws on USE.
      build.onResolve({ filter: /native\/native(\.js)?$/ }, (args) => ({
        path: 'native-stub',
        namespace: 'native-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'native-stub' }, () => ({
        contents:
          'const unavailable = new Proxy({}, {\n' +
          '  get(_t, prop) {\n' +
          "    throw new Error('the native backend is not available in the browser (' + String(prop) + ')');\n" +
          '  },\n' +
          '});\n' +
          'export default unavailable;\n',
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
        contents:
          // createRequire is CALLED at module top level by the (eagerly
          // inlined) native loader, inside a try/catch around the actual
          // require — so it must return a function that only throws when
          // invoked. fs functions throw on call (node-only paths).
          'function unavailable() {\n' +
          "  throw new Error('" + args.path + " is not available in the browser');\n" +
          '}\n' +
          'export const createRequire = () => unavailable;\n' +
          'export const writeFileSync = unavailable;\n' +
          'export const readFileSync = unavailable;\n' +
          'export default { createRequire: () => unavailable, writeFileSync: unavailable };\n',
        loader: 'js',
      }));
    },
  };
}

function wasmPlugin() {
  return {
    name: 'wasm-plugin',
    setup(build) {
      build.onLoad({ filter: /\.wasm$/ }, async ({ path }) => {
        return {
          contents: await readFile(path),
          loader: 'binary',
        };
      });
    },
  };
}

function srcStringPlugin() {
  return {
    name: 'src-string-plugin',
    setup(build) {
      build.onResolve({ filter: /^string:/ }, async ({ path: importPath, resolveDir }) => {
        let absPath = path.resolve(resolveDir, importPath.replace('string:', ''));
        return {
          path: absPath,
          namespace: 'src-string',
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'src-string' }, async ({ path }) => {
        return {
          contents: await readFile(path, 'utf8'),
          loader: 'text',
        };
      });
    },
  };
}
