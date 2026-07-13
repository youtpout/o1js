#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const marker = 'MINA_RUNTIME_PARITY=';
const args = new Set(process.argv.slice(2));
const enforce = args.has('--enforce');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const output = resolve(outputArg?.slice('--output='.length) ?? 'mina-runtime-parity.json');

let jsoo = await probe('jsoo');
let rust = await probe('rust');

let bothProbesSucceeded = jsoo.ok && rust.ok;
let checks = {
  jsooProbeSucceeded: jsoo.ok,
  rustProbeSucceeded: rust.ok,
  jsooProofValid: Boolean(
    jsoo.ok && jsoo.valid && jsoo.roundTrip && jsoo.globalVerify && jsoo.rejectsTamper
  ),
  rustProofValid: Boolean(
    rust.ok && rust.valid && rust.roundTrip && rust.globalVerify && rust.rejectsTamper
  ),
  userCircuitDigest: Boolean(bothProbesSucceeded && jsoo.method.digest === rust.method.digest),
  userCircuitRows: Boolean(bothProbesSucceeded && jsoo.method.rows === rust.method.rows),
  userCircuitGateHistogram:
    Boolean(bothProbesSucceeded) &&
    JSON.stringify(jsoo.method.gateHistogram) === JSON.stringify(rust.method.gateHistogram),
  verificationKeyHash: Boolean(
    bothProbesSucceeded && jsoo.verificationKey.hash === rust.verificationKey.hash
  ),
  proofFormatParity: Boolean(bothProbesSucceeded && jsoo.proof.format === rust.proof.format),
  verificationKeyFormatParity: Boolean(
    bothProbesSucceeded && jsoo.verificationKey.format === rust.verificationKey.format
  ),
  crossBackendProofVerification: false,
  regularN1Recursion: false,
  regularN2Recursion: false,
  smartContractProofs: false,
  provingIndexCacheRoundTrip: false,
  browserRuntimeIntegration: false,
};

let blockers = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
let report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ready: blockers.length === 0,
  checks,
  blockers,
  measurements: { jsoo, rust },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
printSummary(report, output);
if (enforce && !report.ready) process.exitCode = 1;

async function probe(backend) {
  let transport = backend === 'jsoo' ? 'wasm' : 'native';
  let env = {
    ...process.env,
    O1JS_BACKEND: transport,
    O1JS_PROOF_SYSTEM: backend,
  };
  let { code, stdout, stderr } = await command(
    './run',
    ['src/tests/mina-runtime-parity-probe.ts'],
    env
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (code !== 0) {
    return {
      ok: false,
      backend,
      error: {
        exitCode: code,
        message: `${backend} parity probe exited with ${code}`,
        stderr: stderr.slice(-4000),
      },
    };
  }
  let line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(marker));
  if (line === undefined) {
    return {
      ok: false,
      backend,
      error: { exitCode: code, message: `${backend} parity probe produced no result` },
    };
  }
  return { ok: true, ...JSON.parse(line.slice(marker.length)) };
}

function command(file, commandArgs, env) {
  return new Promise((resolvePromise, reject) => {
    let child = spawn(file, commandArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function printSummary(report, path) {
  console.log('\nmina-runtime release gate');
  console.log('-------------------------');
  for (let [name, passed] of Object.entries(report.checks)) {
    console.log(`${passed ? 'PASS' : 'BLOCK'}  ${name}`);
  }
  console.log(`\nReady: ${report.ready ? 'yes' : 'no'}`);
  console.log(`Report: ${path}`);
}
