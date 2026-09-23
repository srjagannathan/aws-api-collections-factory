#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Validates `npm audit --json` output (piped via stdin) contains, at most, the one known
// advisory this project cannot currently fix: @faker-js/faker GHSA-qxc2-j82w-r537, pulled in
// because postman-collection@5.3.1 (its latest published release) pins the exact vulnerable
// version 5.5.3 with no fixed release available -- forcing a patched faker breaks
// postman-collection at runtime (it still calls the pre-v8 faker.address.* API, renamed to
// faker.location.* years ago; confirmed by reproducing the crash directly). Any other
// high-severity finding, on any package, fails.
//
// Fails closed: malformed/unparseable input, an explicit audit-tool error, or a missing
// "vulnerabilities" field are all treated as failures, not as "no vulnerabilities found".

const ALLOWED_ADVISORY_URL = 'https://github.com/advisories/GHSA-qxc2-j82w-r537';
const ALLOWED_RANGE = '<=10.4.0';

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error('npm audit did not produce parseable JSON output:', error.message);
    process.exit(1);
  }

  if (data.error) {
    console.error('npm audit reported a tool error:', JSON.stringify(data.error));
    process.exit(1);
  }

  const vulnerabilities = data.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    console.error('npm audit output had no "vulnerabilities" field; treating as a tool error.');
    process.exit(1);
  }

  const names = Object.keys(vulnerabilities);
  if (names.length === 0) {
    console.log('No high-severity vulnerabilities.');
    process.exit(0);
  }

  const unexpected = [];
  for (const name of names) {
    const entry = vulnerabilities[name];
    const via = Array.isArray(entry.via) ? entry.via : [];
    const advisories = via.filter((v) => typeof v === 'object');

    // A "via" array of plain strings (package names) means this package is only flagged
    // because a dependency of *its own* has an advisory -- it doesn't have one itself.
    if (via.length > 0 && advisories.length === 0) {
      continue;
    }

    const onlyKnownAdvisory = advisories.length > 0
        && advisories.every((advisory) => advisory.url === ALLOWED_ADVISORY_URL)
        && entry.range === ALLOWED_RANGE;

    if (!onlyKnownAdvisory) {
      unexpected.push(name);
    }
  }

  if (unexpected.length > 0) {
    console.error('Unexpected high-severity advisories:', unexpected.join(', '));
    process.exit(1);
  }

  console.log(
      'Only the known, upstream-blocked advisory GHSA-qxc2-j82w-r537 '
      + '(@faker-js/faker via postman-collection, no fixed release available) is present. Passing.'
  );
});
