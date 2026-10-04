'use strict';

/**
 * Napoleon client — end-to-end walkthrough.
 *
 *   NAPOLEON_URL=https://your-host/api/v1 \
 *   NAPOLEON_KEY=sk_napoleon_… \
 *   node examples/quickstart.js
 *
 * Needs an ADMIN key: it ingests data as well as reading it.
 */

const { NapoleonClient } = require('..');

const napoleon = new NapoleonClient({
  baseUrl: process.env.NAPOLEON_URL || 'http://localhost:3010/api/v1',
  apiKey: process.env.NAPOLEON_KEY || '',
});

const today = new Date();
const daysAgo = (n, hour = 9) => {
  const d = new Date(today.getTime() - n * 24 * 60 * 60 * 1000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function main() {
  console.log('1. Liveness (no key needed)');
  console.log('  ', await napoleon.health());

  console.log('\n2. Before ingesting anything, the overview is honest about it');
  const before = await napoleon.insights.overview();
  console.log(`   dataStatus: ${before.dataStatus}`);
  if (before.dataStatus === 'EMPTY') {
    console.log(`   ${before.insights[0].title} — ${before.insights[0].recommendation}`);
  }

  console.log('\n3. Ingest a small but complete picture');
  await napoleon.ingest.sites([
    { externalId: 'riverside', name: 'Riverside Estate', riskLevel: 'CRITICAL' },
    { externalId: 'plaza', name: 'Okonkwo Plaza', riskLevel: 'LOW' },
  ]);
  await napoleon.ingest.guards([
    { externalId: 'g-1', fullName: 'Ada Okeke', siteExternalId: 'riverside', performanceScore: 92 },
    { externalId: 'g-2', fullName: 'Bola Adeyemi', siteExternalId: 'riverside', performanceScore: 48, currentShift: 'NIGHT' },
  ]);
  await napoleon.ingest.incidents([
    { externalId: 'inc-1', siteExternalId: 'riverside', severity: 'CRITICAL', type: 'THEFT', reportedAt: daysAgo(1, 22) },
    { externalId: 'inc-2', siteExternalId: 'riverside', severity: 'HIGH', type: 'TRESPASS', reportedAt: daysAgo(2, 23) },
    { externalId: 'inc-3', siteExternalId: 'riverside', severity: 'MEDIUM', type: 'TRESPASS', reportedAt: daysAgo(3, 21) },
    { externalId: 'inc-4', siteExternalId: 'riverside', severity: 'LOW', type: 'OTHER', reportedAt: daysAgo(4, 22) },
  ]);
  await napoleon.ingest.attendance([
    { externalId: 'att-1', guardExternalId: 'g-2', siteExternalId: 'riverside', createdAt: daysAgo(1), isLate: true, status: 'LATE' },
    { externalId: 'att-2', guardExternalId: 'g-2', siteExternalId: 'riverside', createdAt: daysAgo(2), isLate: true, status: 'LATE' },
    { externalId: 'att-3', guardExternalId: 'g-2', siteExternalId: 'riverside', createdAt: daysAgo(3), isLate: true, status: 'LATE' },
    { externalId: 'att-4', guardExternalId: 'g-2', siteExternalId: 'riverside', createdAt: daysAgo(4), isLate: true, status: 'LATE' },
    { externalId: 'att-5', guardExternalId: 'g-1', siteExternalId: 'riverside', createdAt: daysAgo(1), isLate: false, status: 'ON_TIME' },
    { externalId: 'att-6', guardExternalId: 'g-1', siteExternalId: 'plaza', createdAt: daysAgo(2), isLate: false, status: 'ON_TIME' },
  ]);
  await napoleon.ingest.patrols({
    routes: [{ externalId: 'route-1', siteExternalId: 'riverside' }],
    records: [
      { externalId: 'pr-1', guardExternalId: 'g-1', routeExternalId: 'route-1', completionPercentage: 90, createdAt: daysAgo(1) },
      { externalId: 'pr-2', guardExternalId: 'g-1', routeExternalId: 'route-1', completionPercentage: 55, createdAt: daysAgo(2) },
    ],
  });
  console.log('   ingested');

  console.log('\n4. Overview');
  const health = await napoleon.insights.overview();
  console.log(`   dataStatus: ${health.dataStatus}   health: ${health.healthScore}/100`);
  console.log(`   open incidents: ${health.openIncidents}   late rate: ${health.lateCheckInRate}%   patrols: ${health.patrolCompletionRate}%`);
  for (const insight of health.insights) {
    console.log(`   [${insight.severity}] ${insight.title}`);
    console.log(`        -> ${insight.recommendation}`);
  }

  console.log('\n5. Site risk');
  for (const site of await napoleon.insights.riskBySite()) {
    console.log(`   ${site.riskScore.toString().padStart(3)}  ${site.siteName} (${site.riskLevel})  incidents: ${site.incidentCount30d}, open: ${site.openIncidents30d}, late: ${site.lateCheckInRate}%`);
  }

  console.log('\n6. Personnel to look at');
  for (const guard of await napoleon.insights.atRiskGuards()) {
    console.log(`   ${guard.riskLevel.padEnd(6)} ${guard.fullName} — ${guard.riskFactors.join('; ')}`);
  }

  console.log('\n7. Incident metrics');
  const metrics = await napoleon.metrics.incidents({ days: 30 });
  console.log(`   total ${metrics.total}, in window ${metrics.inWindow}, today ${metrics.today}, open ${metrics.open}`);
  console.log(`   by type:`, metrics.byType);

  console.log('\n8. Score a value against its own history (no ingestion involved)');
  const scored = await napoleon.analyze.score({
    metric: 'failed_logins',
    value: 47,
    history: [3, 4, 2, 5, 3, 4, 2, 3, 5, 4, 3, 2, 4, 3, 5],
    entityId: 'gateway-7',
  });
  console.log(`   surprise ${scored.surprise} -> ${scored.severity} (baseline ${scored.baselineMean}, n=${scored.sampleSize})`);

  console.log('\n9. The same thing through the chat shape');
  const res = await napoleon.chat.completions.create({
    model: 'napoleon-risk',
    messages: [{ role: 'user', content: 'Which site worries you most?' }],
  });
  console.log(
    res.choices[0].message.content
      .split('\n')
      .slice(0, 6)
      .map((l) => `   ${l}`)
      .join('\n'),
  );
  console.log('   …structured payload:', Array.isArray(res.choices[0].message.napoleon.analysis) ? `${res.choices[0].message.napoleon.analysis.length} sites` : 'object');

  console.log('\n10. Clean up (leaves the organization and your keys intact)');
  console.log('  ', await napoleon.ingest.eraseData());
}

main().catch((err) => {
  console.error(`\n${err.name || 'Error'}: ${err.message}`);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
