import { randomUUID } from 'node:crypto';

import { HttpError } from './errors.js';
import { cleanupSource, inspectSource } from './sources.js';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export class DocumentStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, remoteMirrorLimit = 64 * 1024 * 1024 } = {}) {
    this.docs = new Map();
    this.ttlMs = ttlMs;
    this.remoteMirrorLimit = remoteMirrorLimit;
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async open({ source = 'auto', value }) {
    const inspected = await inspectSource({
      source,
      value,
      remoteMirrorLimit: this.remoteMirrorLimit,
    });

    const now = Date.now();
    const doc = {
      ...inspected,
      id: randomUUID(),
      createdAt: now,
      lastAccess: now,
      stats: {
        requests: 0,
        rangeRequests: 0,
        fullRequests: 0,
        bytesServed: 0,
        activeRequests: 0,
        lastRange: null,
        lastActivityAt: null,
      },
    };

    this.docs.set(doc.id, doc);
    return doc;
  }

  get(id) {
    const doc = this.docs.get(id);
    if (!doc) {
      return null;
    }
    doc.lastAccess = Date.now();
    return doc;
  }

  require(id) {
    const doc = this.get(id);
    if (!doc) {
      throw new HttpError(
        404,
        'DOCUMENT_NOT_FOUND',
        '该文档会话不存在或已过期，请重新打开。',
      );
    }
    return doc;
  }

  remove(id) {
    const doc = this.docs.get(id);
    if (!doc) {
      return false;
    }
    this.docs.delete(id);

    if (doc.cleanupDir) {
      // Give an in-flight response a moment to finish before deleting the
      // temporary mirror on platforms that lock open files.
      const delay = doc.stats.activeRequests > 0 ? 30_000 : 0;
      const timer = setTimeout(() => {
        cleanupSource(doc).catch(() => {});
      }, delay);
      timer.unref?.();
    }
    return true;
  }

  publicInfo(doc) {
    return {
      id: doc.id,
      name: doc.name,
      size: doc.size,
      contentType: doc.contentType,
      source: doc.kind === 'local' ? 'path' : 'url',
      display: doc.display,
      location: doc.kind === 'local' ? doc.path : doc.display,
      mirrored: doc.mirrored === true,
      rangeSupported: doc.mirrored !== true,
      contentUrl: `/api/documents/${doc.id}/content`,
      createdAt: new Date(doc.createdAt).toISOString(),
      lastModified: doc.lastModified ?? null,
      etag: doc.etag,
    };
  }

  publicStats(doc) {
    return {
      ...doc.stats,
      openedAt: new Date(doc.createdAt).toISOString(),
      lastAccessAt: new Date(doc.lastAccess).toISOString(),
    };
  }

  statsFor(id) {
    const doc = this.require(id);
    return this.publicStats(doc);
  }

  startRequest(doc, { isRange, start, end }) {
    const stats = doc.stats;
    stats.requests += 1;
    stats.activeRequests += 1;
    stats.lastActivityAt = Date.now();
    if (isRange) {
      stats.rangeRequests += 1;
      stats.lastRange = { start, end, at: stats.lastActivityAt };
    } else {
      stats.fullRequests += 1;
    }
  }

  finishRequest(doc) {
    doc.stats.activeRequests = Math.max(0, doc.stats.activeRequests - 1);
  }

  addServedBytes(doc, count) {
    doc.stats.bytesServed += count;
    doc.stats.lastActivityAt = Date.now();
  }

  sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, doc] of this.docs) {
      if (doc.lastAccess < cutoff && doc.stats.activeRequests === 0) {
        this.remove(id);
      }
    }
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }
}
