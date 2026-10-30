// Live check of the address-to-miles lookup against real addresses (run on a machine that can
// reach geocoding.geo.census.gov):
//   npm run distance-check -- "<from address>" "<to address>" ["<from>" "<to>" ...]
//   npm run distance-check -- --file pairs.txt     one pair per line: from | to   (# comments ok)
// For each pair it prints the miles, whether they came from Google Routes or the free estimate, and a
// Google Maps link to compare with.
const fs = require('node:fs');
const { openDb } = require('../db');
const { createDistanceService, directionsUrl } = require('../maps');

const CENSUS_PING = 'https://geocoding.geo.census.gov/geocoder/benchmarks';

function readPairs(argv) {
  if (argv[0] === '--file') {
    return fs.readFileSync(argv[1], 'utf8').split('\n')
      .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
      .map((l) => l.split('|').map((s) => s.trim()));
  }
  const pairs = [];
  for (let i = 0; i + 1 < argv.length; i += 2) pairs.push([argv[i], argv[i + 1]]);
  return pairs;
}

async function main() {
  const pairs = readPairs(process.argv.slice(2));
  if (!pairs.length || pairs.some((p) => p.length !== 2 || !p[0] || !p[1])) {
    console.log('Usage: npm run distance-check -- "<from>" "<to>" [...]  |  --file pairs.txt (from | to per line)');
    process.exit(1);
  }

  const svc = createDistanceService({ db: openDb() });
  console.log(`Distance provider: ${svc.provider}${svc.provider === 'google' ? '' : `, road factor ${svc.roadFactor}`}`);
  if (svc.provider === 'census') {
    try {
      const res = await fetch(CENSUS_PING, { signal: AbortSignal.timeout(8000) });
      console.log(`Census geocoder reachable: ${res.ok ? 'yes' : `no (HTTP ${res.status})`}`);
    } catch (err) {
      console.log(`Census geocoder reachable: no (${err.cause?.code || err.message})`);
    }
  }

  let failed = 0;
  for (const [from, to] of pairs) {
    console.log(`\n${from}  ->  ${to}`);
    try {
      const r = await svc.distance(from, to);
      console.log(r.method === 'route'
        ? `  ${r.miles} mi driving, ${r.minutes} min (Google Routes)`
        : `  ${r.miles} mi estimated (straight ${r.straight_miles} mi × ${r.road_factor})`);
    } catch (err) {
      failed++;
      console.log(`  ERROR: ${err.message}`);
    }
    console.log(`  compare: ${directionsUrl([from, to])}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
