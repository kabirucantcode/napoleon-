'use strict';

/**
 * Bootstrap: create an organization and issue its first ADMIN key.
 *
 * A standalone service cannot be unlocked through its own API — every route
 * needs a key, and there is no user account to log in with. This is that
 * chicken-and-egg breaker, and the only way in.
 *
 *   node scripts/bootstrap.js
 *   node scripts/bootstrap.js --name "Acme Security" --slug acme
 *
 * Safe to re-run: the organization is matched on slug, so a second run adds
 * another key rather than a duplicate organization. Run it again if you ever
 * revoke every ADMIN key.
 */

const { config } = require('dotenv');
config();

const { PrismaClient } = require('@prisma/client');
const { createHash, randomBytes } = require('crypto');

const KEY_PREFIX = 'sk_napoleon_';
const KEY_PREFIX_LENGTH = 16;

function readFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function main() {
  const flags = readFlags(process.argv.slice(2));

  const orgName =
    flags.name ?? process.env.BOOTSTRAP_ORG_NAME ?? 'My Organization';
  const orgSlug =
    flags.slug ?? process.env.BOOTSTRAP_ORG_SLUG ?? 'default';
  const keyName =
    flags.key ?? process.env.BOOTSTRAP_KEY_NAME ?? 'bootstrap';

  if (typeof orgName !== 'string' || orgName.trim() === '') {
    throw new Error('--name must be a non-empty string');
  }
  if (!/^[a-z0-9-]+$/.test(orgSlug)) {
    throw new Error(
      `--slug "${orgSlug}" must be lowercase letters, digits and hyphens only`,
    );
  }

  const prisma = new PrismaClient();

  try {
    const organization = await prisma.organization.upsert({
      where: { slug: orgSlug },
      update: { name: orgName },
      create: { name: orgName, slug: orgSlug },
      select: { id: true, name: true, slug: true, createdAt: true },
    });

    const existingAdmins = await prisma.apiKey.count({
      where: {
        organizationId: organization.id,
        scope: 'ADMIN',
        isActive: true,
      },
    });

    const plaintext = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const key = await prisma.apiKey.create({
      data: {
        organizationId: organization.id,
        name: keyName,
        scope: 'ADMIN',
        keyHash: createHash('sha256').update(plaintext).digest('hex'),
        prefix: plaintext.slice(0, KEY_PREFIX_LENGTH),
      },
      select: { id: true, name: true, scope: true },
    });

    if (existingAdmins > 0) {
      console.log(
        `\nNote: this organization already had ${existingAdmins} active ADMIN key(s).`,
      );
      console.log(
        'A new one was issued anyway. Revoke the old ones once this is stored.\n',
      );
    }

    console.log('Organization');
    console.log(`  name  ${organization.name}`);
    console.log(`  slug  ${organization.slug}`);
    console.log(`  id    ${organization.id}`);
    console.log('\nAPI key (shown once — it cannot be recovered)');
    console.log(`  name   ${key.name}`);
    console.log(`  scope  ${key.scope}`);
    console.log(`  value  ${plaintext}`);
    console.log('\nUse it:');
    console.log(`  curl -H "X-API-KEY: ${plaintext}" \\`);
    console.log('       http://localhost:3010/api/v1/insights/overview');
    console.log('\nThen ingest something to analyse:');
    console.log('  POST /api/v1/ingest/sites     { "sites": [...] }');
    console.log('  POST /api/v1/ingest/guards    { "guards": [...] }');
    console.log('  POST /api/v1/ingest/incidents { "incidents": [...] }');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\nBootstrap failed: ${err.message}`);
  if (/Environment variable not found: DATABASE_URL/.test(String(err.message))) {
    console.error('Set DATABASE_URL in .env (copy .env.example) and retry.');
  }
  if (/Can't reach database server/.test(String(err.message))) {
    console.error('Is Postgres running, and is DATABASE_URL correct?');
  }
  if (/does not exist in the current database/.test(String(err.message))) {
    console.error('Run `npm run prisma:push` to create the tables first.');
  }
  process.exit(1);
});
