/**
 * tests/dashboard/helpers.js
 *
 * Shared test utilities for dashboard route and module tests.
 * Eliminates duplication of mockRes(), getRouteHandler(), and spy management
 * across all route test files.
 *
 * WHICH STYLE TO USE FOR A NEW ROUTER SUITE
 *
 * Default to the real thing: mount the router on an express app and drive it
 * over HTTP with supertest via helpers/serverAgent.js. That exercises the
 * middleware stack the router actually runs behind — body parsing, error
 * handling, multipart — so the test fails when the composition breaks and not
 * only when the handler does. overlayHarness.js and playlistStore.test.js are
 * the worked examples.
 *
 * mockRes() + getRouteHandler() is the older style and is kept because a large
 * body of tests uses it. It reaches past Express to call the handler function
 * directly, which makes it fast and precise for branch-level assertions but
 * blind to everything Express would have done first: a route whose middleware
 * is missing still passes. Reach for it when you are pinning handler branches
 * on a router that is already covered end-to-end elsewhere.
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
 *   The live map and every spy it installed (for restoration via mockRestore,
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
    }),
    // jsonStore writes <file>.tmp and renames it into place, so the mock fs has
    // to model the move (and tolerate the mkdir) or a store write vanishes.
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from in files) {
        files[to] = files[from];
        delete files[from];
      }
    }),
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {})
  ];
  return { files, spies };
}

// ─── Mock response object ─────────────────────────────────────

/**
 * Creates a mock Express response with json(), status(), set(), send(), end().
 * After calling a handler, inspect res.statusCode and res.body.
 */
export function mockRes() {
  const res = { statusCode: 200, body: null, ended: false, redirectUrl: null, headers: {} };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.set = vi.fn((k, v) => { if (typeof k === 'string') res.headers[k] = v; return res; });
  res.setHeader = vi.fn((k, v) => { res.headers[k] = v; return res; });
  res.send = vi.fn((data) => { res.body = data; return res; });
  res.redirect = vi.fn((url) => { res.redirectUrl = url; return res; });
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
