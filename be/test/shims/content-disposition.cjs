'use strict';
/* global exports */
// Jest-only stand-in (run 38): `@fastify/static@10` does `require('content-disposition')`, whose v3
// is ESM-only. Node 22 loads that fine at runtime (require(esm)), but Jest's module runtime cannot,
// so every spec that boots the real `configureApp` would fail to load. `create` is only used by
// `reply.download()`, which this app never calls; fail loudly if that ever changes.
exports.create = function create() {
  throw new Error('content-disposition shim: reply.download() is not supported under Jest');
};
