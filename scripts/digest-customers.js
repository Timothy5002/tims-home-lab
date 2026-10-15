'use strict';
// Prints the Slack digest's customer registry for review: each customer with its channels and the aliases used to
// find mentions, the channels that matched no customer (with the derived key and any ambiguous candidates), the
// general channels, and the mention channels. Names and IDs only, never message text. No Slack calls: it reads
// data/slack-channels.json and the configs. Usage: node scripts/digest-customers.js [--json]
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS_FILE, loadConfig, placeChannel, ROOT } = require('../src/slack');
const { loadCustomerConfig, buildRegistry } = require('../src/digest/customers');
const { convLabel } = require('../src/digest/render');

const digestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'slack-digest.json'), 'utf8'));
const bus = loadConfig();
const saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
const convs = saved.channels.map((c) => ({ ...c, ...placeChannel(bus, c) })).filter((c) => c.bu)
  .map((c) => ({ ...c, label: convLabel(c, digestCfg.myName) }));
const reg = buildRegistry(convs, loadCustomerConfig());
const byId = new Map(convs.map((c) => [c.id, c]));
const label = (id) => { const c = byId.get(id); return `${c.label}${c.sub ? ` [${c.sub}]` : ''}`; };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    customers: reg.customers.map((c) => ({ key: c.key, name: c.name, unmatched: c.unmatched, channels: c.convIds.map(label), aliases: c.aliases })),
    unmatched: reg.unmatched.map((u) => ({ channel: label(u.conv.id), key: u.key, candidates: u.candidates })),
    general: reg.general.map((c) => label(c.id)),
    mentionChannels: [...reg.mentionConvs].map(([id, kind]) => ({ channel: label(id), kind })),
  }, null, 2));
  process.exit(0);
}

const matched = reg.customers.filter((c) => !c.unmatched);
const unmatched = reg.customers.filter((c) => c.unmatched);
console.log(`Customers: ${matched.length} (from the anchor channels and config), plus ${unmatched.length} unmatched records\n`);
for (const c of matched) {
  console.log(`${c.name}  (key ${c.key})`);
  console.log(`  channels: ${c.convIds.map(label).join(', ') || '(none)'}`);
  console.log(`  mention aliases: ${c.aliases.length ? c.aliases.map((a) => `"${a}"`).join(', ') : '(none: not matched in mention channels)'}`);
}
console.log(`\nChannels that matched no customer (${reg.unmatched.length}); each group below is analyzed as its own record:`);
for (const c of unmatched) {
  const why = reg.unmatched.filter((u) => c.convIds.includes(u.conv.id))
    .map((u) => (u.candidates.length ? `ambiguous: ${u.candidates.join(' / ')}` : u.key ? `key "${u.key}"` : 'no key')).join('; ');
  console.log(`  ${c.convIds.length === 1 && c.name === byId.get(c.convIds[0]).label ? label(c.convIds[0]) : `${c.name}: ${c.convIds.map(label).join(', ')}`}  (${why})`);
}
console.log(`\nGeneral channels (notCustomers; summarized as a unit, not a customer): ${reg.general.map((c) => label(c.id)).join(', ') || '(none)'}`);
const lead = [...reg.mentionConvs].filter(([, k]) => k === 'leadership').map(([id]) => label(id));
const internal = [...reg.mentionConvs].filter(([, k]) => k === 'internal').map(([id]) => label(id));
console.log(`\nMention channels: Leadership (${lead.length}): ${lead.join(', ')}`);
console.log(`  Internal (${internal.length}): ${internal.join(', ')}`);
