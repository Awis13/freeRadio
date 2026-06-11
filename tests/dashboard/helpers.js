/**
 * tests/dashboard/helpers.js
 *
 * Shared test utilities for dashboard route and module tests.
 * Eliminates duplication of mockRes(), getRouteHandler(), and spy management
 * across all route test files.
 */

import { vi } from 'vitest';
import fs from 'fs';

// ─── Spy management ───────────────────────────────────────────

let _spies = [];

/** Track a spy for automatic cleanup in afterEach. */
export function spy(s) {
  _spies.push(s);
  return s;
}

/** Restore and clear all tracked spies. Call in beforeEach/afterEach. */
export function restoreSpies() {
  _spies.forEach(s => s.mockRestore());
  _spies = [];
}

// ─── In-memory fs map ─────────────────────────────────────────

/**
 * Replaces fs.existsSync/readFileSync/writeFileSync with an in-memory file map.
 * Files exist iff their path is a key in the map; reads of missing paths throw
 * ENOENT like the real fs; writes land in the map. Mutate `files` directly in
 * tests to control what modules under test see.
 *
 * @param {Object} initialFiles - path -> content seed for the map
 * @returns {{files: Object, spies: import('vitest').MockInstance[]}}
 *   The live map and the three spies (for restoration via mockRestore,
 *   vi.restoreAllMocks(), or the spy()/restoreSpies() convention).
 */
export function mockFsMap(initialFiles = {}) {
  const files = { ...initialFiles };
  const spies = [
    vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files),
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    }),
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
      files[p] = data;
    })
  ];
  return { files, spies };
}

// ─── Mock response object ─────────────────────────────────────

/**
 * Creates a mock Express response with json(), status(), set(), send(), end().
 * After calling a handler, inspect res.statusCode and res.body.
 */
export function mockRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.set = vi.fn(() => res);
  res.send = vi.fn((data) => { res.body = data; return res; });
  res.end = vi.fn(() => { res.ended = true; });
  return res;
}

// ─── Route handler extraction ─────────────────────────────────

/**
 * Extracts the handler function for a given method+path from an Express router.
 * When multiple handlers exist on the same route (e.g. express.json() middleware),
 * returns the LAST one (the actual handler, not middleware).
 *
 * @param {Router} router - Express router instance
 * @param {string} method - HTTP method (lowercase: 'get', 'post', etc.)
 * @param {string} routePath - Route path (e.g. '/quality', '/:platform')
 * @returns {Function} The route handler function
 * @throws {Error} If no matching handler found
 */
export function getRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath) {
      const matches = layer.route.stack.filter(s => s.method === method);
      if (matches.length) return matches[matches.length - 1].handle;
    }
  }
  throw new Error(`No handler for ${method.toUpperCase()} ${routePath}`);
}
