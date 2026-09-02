#!/usr/bin/env node
// Decaid uses the manifest id as a directory name under web-ui/, so an unsafe
// id silently fails to install. Check it here rather than on the tablet.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const targets = [
  path.join(root, 'public', 'manifest.json'),
  path.join(root, 'dist', 'manifest.json')
].filter(existsSync);

if (targets.length === 0) fail('No manifest at public/manifest.json or dist/manifest.json.');

for (const file of targets) {
  const label = path.relative(root, file);
  const m = JSON.parse(readFileSync(file, 'utf8'));

  for (const field of ['id', 'name', 'description', 'version', 'author']) {
    if (typeof m[field] !== 'string' || m[field].trim() === '') {
      fail(`${label}: missing or empty "${field}".`);
    }
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(m.id)) {
    fail(`${label}: id "${m.id}" must be lowercase letters, digits, hyphen or underscore.`);
  }
  if (m.version !== pkg.version) {
    fail(`${label}: version ${m.version} does not match package.json ${pkg.version}.`);
  }
}

console.log(`ok - validated ${targets.length} manifest${targets.length === 1 ? '' : 's'}`);

function fail(message) {
  console.error(`manifest validation failed: ${message}`);
  process.exit(1);
}
