'use strict';

/**
 * Runs every smoke script in sequence and fails if any fails.
 *
 *   npm run smoke
 *
 * These are the verification that does not need Postgres: each script stubs the
 * database and exercises real code — the engine, the scoring math, the auth
 * matrix, the OpenAI envelope, ingestion containment.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const scripts = [
  'smoke-engine.js',
  'smoke-anomaly.js',
  'smoke-openai.js',
  'smoke-auth.js',
  'smoke-ingest.js',
  'smoke-sdk.js',
];

let failed = 0;

for (const script of scripts) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, script)], {
      stdio: 'inherit',
    });
  } catch {
    // The failing script has already explained itself.
    failed++;
  }
}

if (failed > 0) {
  console.error(`${failed} of ${scripts.length} smoke scripts failed.\n`);
  process.exit(1);
}

console.log(`All ${scripts.length} smoke scripts passed.\n`);
