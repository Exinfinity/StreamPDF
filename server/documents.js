import { randomUUID } from 'node:crypto';

import { HttpError } from './errors.js';
import { DEFAULT_REMOTE_POLICY } from './http-client.js';
import { DEFAULT_MAX_REMOTE_BYTES, inspectSource } from './sources.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DOCUMENTS = 100;
const DEFAULT_MAX_DOCUMENTS_PER_IP = 5;

export class DocumentStore {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxDocuments = DEFAULT_MAX_DOCUMENTS,
    maxDocumentsPerIp = DEFAULT_MAX_DOCUMENTS_PER_IP,
    maxRemoteBytes = DEFAULT_MAX_REMOTE_BYTES,
    remotePolicy = DEFAULT_REMOTE_POLICY,
    remoteHeadersTimeoutMs,
    remoteBodyIdleTimeoutMs,
  } = {}) {
    this.docs = new Map();
    this.ttlMs = ttlMs;
    this.maxDocuments = maxDocuments;
    this.maxDocumentsPerIp = maxDocumentsPerIp;
    this.maxRemoteBytes = maxRemoteBytes;
    this.remotePolicy = remotePolicy;
    this.remoteHeadersTimeoutMs = remoteHeadersTimeoutMs;
    this.remoteBodyIdleTimeoutMs = remoteBodyIdleTimeoutMs;
    this.ipCounts = new Map();
    this.pendingOpens = 0;
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async open({ value, ip = 'unknown' }) {
    if (this.docs.size + this.pendingOpens >= this.maxDocuments) {
      throw new HttpError(
        503,
        'MAX_DOCUMENTS_REACHED',
        '服务器文档会话数量已达上限，请稍后重试。',
      );
    }

    const currentForIp = this.ipCounts.get(ip) ?? 0;
    if (currentForIp >= this.maxDocumentsPerIp) {
      throw new HttpError(
        429,
        'DOCUMENT_QUOTA_EXCEEDED',
        '当前客户端的文档会话数量已达上限，请关闭部分文档后重试。',
      );
    }

    this.pendingOpens += 1;
    this.ipCounts.set(ip, currentForIp + 1);

    let success = false;
    try {
      const inspected = await inspectSource({
        value,
        policy: this.remotePolicy,
        maxRemoteBytes: this.maxRemoteBytes,
        headersTimeoutMs: this.remoteHeadersTimeoutMs,
        bodyIdleTimeoutMs: this.remoteBodyIdleTimeoutMs,
      });

      const now = Date.now();
      const doc = {
        ...inspected,
        id: randomUUID(),
        ownerIp: ip,
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
      success = true;
      return doc;
    } finally {
      this.pendingOpens -= 1;
      if (!success) {
        const remaining = (this.ipCounts.get(ip) ?? 1) - 1;
        if (remaining <= 0) {
          this.ipCounts.delete(ip);
        } else {
          this.ipCounts.set(ip, remaining);
        }
      }
    }
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

    const count = (this.ipCounts.get(doc.ownerIp) ?? 1) - 1;
    if (count <= 0) {
      this.ipCounts.delete(doc.ownerIp);
    } else {
      this.ipCounts.set(doc.ownerIp, count);
    }
    return true;
  }

  publicInfo(doc) {
    // Keep this list deliberately small: no owner IP, upstream URL, absolute
    // path, upstream ETag/Last-Modified or document counters. Those values
    // help an attacker map the deployment without being needed by the UI.
    return {
      id: doc.id,
      name: doc.name,
      size: doc.size,
      contentType: doc.contentType,
      source: 'url',
      display: doc.display,
      mirrored: false,
      rangeSupported: true,
      contentUrl: `/api/documents/${doc.id}/content`,
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

  async cleanupAll() {
    this.stop();
    this.docs.clear();
    this.ipCounts.clear();
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }
}
