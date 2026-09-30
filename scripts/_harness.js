'use strict';

/**
 * Minimal assertion harness shared by the smoke scripts.
 *
 * These exist because the app can be built but not run end-to-end without
 * Postgres. Stubbing Prisma lets the parts that hold logic — the engine, the
 * scoring math, the auth matrix, the OpenAI envelope — be exercised for real.
 */

let failures = 0;
let checks = 0;

function boot(name) {
  console.log(`\n${name}`);
}

function check(label, condition, extra) {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(
      `  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ''}`,
    );
  }
}

function summary() {
  if (failures === 0) {
    console.log(`\nAll ${checks} checks passed.\n`);
  } else {
    console.log(`\n${failures} of ${checks} checks failed.\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** Fails loudly if the app has not been compiled, rather than a raw MODULE_NOT_FOUND. */
function requireDist(relative) {
  const fs = require('fs');
  const path = require('path');
  const target = path.join(__dirname, '..', 'dist', relative);
  const resolved = fs.existsSync(target) ? target : `${target}.js`;
  if (!fs.existsSync(resolved)) {
    console.error(
      `Compiled output missing (${path.relative(process.cwd(), resolved)}).\nRun \`npm run build\` first.`,
    );
    process.exit(1);
  }
  return require(resolved);
}

module.exports = { boot, check, summary, requireDist };
