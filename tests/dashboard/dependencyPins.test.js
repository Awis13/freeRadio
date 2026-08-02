/**
 * tests/dashboard/dependencyPins.test.js
 *
 * Guards the bump-in-two-places hazard.
 *
 * The runtime dependencies exist in three files that nothing keeps in step:
 *
 *   dashboard/package.json        exact pins — what the image is asked for
 *   dashboard/package-lock.json   what `npm ci` installs into the image
 *   package-lock.json (root)      what the test suite actually runs against
 *
 * Bump one and forget another and the suite goes green against a version the
 * image never ships, which is precisely how the multer 2.x behaviour change
 * reached a pin during T6 — the failure surfaced as a mysterious test result
 * rather than as a dependency problem. Nothing in npm enforces the
 * relationship, so this test does.
 *
 * It reads the JSON directly instead of resolving modules: the point is what
 * the files declare, not what happens to be installed in node_modules right
 * now.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO, relative), 'utf8'));
}

const dashboardPkg = readJson('dashboard/package.json');
const dashboardLock = readJson('dashboard/package-lock.json');
const rootLock = readJson('package-lock.json');
const rootPkg = readJson('package.json');

const PINNED = Object.entries(dashboardPkg.dependencies);

/** Version a lockfile resolves for a top-level package, or undefined. */
function resolved(lock, name) {
  const entry = lock.packages && lock.packages['node_modules/' + name];
  return entry && entry.version;
}

describe('dashboard dependency pins', () => {
  it('declares every runtime dependency as an exact version', () => {
    // A range here would make the two lockfiles free to drift apart on their
    // own, without anyone editing a version.
    for (const [name, spec] of PINNED) {
      expect(spec, `${name} must be an exact version, got "${spec}"`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('pins what the image installs (dashboard lockfile agrees)', () => {
    for (const [name, spec] of PINNED) {
      expect(resolved(dashboardLock, name), `${name} in dashboard/package-lock.json`).toBe(spec);
    }
  });

  it('pins what the test suite runs against (root lockfile agrees)', () => {
    // The suite imports these from the ROOT node_modules. When this fails, the
    // tests are exercising a different build of a dependency than the image
    // ships — bump both sides or neither.
    for (const [name, spec] of PINNED) {
      expect(resolved(rootLock, name), `${name} in the root package-lock.json`).toBe(spec);
    }
  });

  it('keeps every pinned runtime dependency present at the root, so nothing is untested', () => {
    const rootDev = rootPkg.devDependencies || {};
    for (const [name] of PINNED) {
      expect(rootDev, `${name} must exist at the root or the suite cannot load it`).toHaveProperty(name);
    }
  });

  it('covers the dependencies that actually exist, so a new one cannot slip in unguarded', () => {
    // A literal membership list: adding a runtime dependency has to be a
    // conscious edit here rather than something the loops above silently absorb.
    expect(PINNED.map(([name]) => name).sort()).toEqual([
      '@aws-sdk/client-s3',
      'express',
      'express-rate-limit',
      'multer',
      'ws',
    ]);
  });
});
