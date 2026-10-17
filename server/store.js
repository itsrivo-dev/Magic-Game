'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function mergeObjects(oldValue, newValue) {
  if (!oldValue || typeof oldValue !== 'object' || Array.isArray(oldValue) || !newValue || typeof newValue !== 'object' || Array.isArray(newValue)) return clone(newValue);
  const out = clone(oldValue);
  for (const [key, value] of Object.entries(newValue)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && oldValue[key] && typeof oldValue[key] === 'object' && !Array.isArray(oldValue[key])) out[key] = mergeObjects(oldValue[key], value);
    else out[key] = clone(value);
  }
  return out;
}

class MemoryStore {
  constructor(seed = {}) {
    this.docs = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
    this._tail = Promise.resolve();
  }

  timestamp() { return new Date(); }
  async get(path) { return clone(this.docs.get(path) || null); }
  async set(path, data, options = {}) {
    const value = options.merge ? mergeObjects(this.docs.get(path) || {}, data) : clone(data);
    this.docs.set(path, value);
    return clone(value);
  }
  async create(path, data) {
    if (this.docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'ALREADY_EXISTS' });
    this.docs.set(path, clone(data));
    return clone(data);
  }
  async update(path, data) {
    if (!this.docs.has(path)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    const value = mergeObjects(this.docs.get(path), data);
    this.docs.set(path, value);
    return clone(value);
  }
  async list(collection, options = {}) {
    const prefix = `${collection}/`;
    const max = Math.max(1, Math.min(Number(options.limit) || 100, 5000));
    const rows = [];
    for (const [path, data] of this.docs.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      const item = { id: path.slice(prefix.length), data: clone(data), path };
      if (options.where && !matches(data, options.where)) continue;
      rows.push(item);
    }
    if (options.orderBy) {
      const field = options.orderBy;
      const direction = options.direction === 'asc' ? 1 : -1;
      rows.sort((a, b) => compare(a.data[field], b.data[field]) * direction);
    }
    return rows.slice(0, max);
  }
  async count(collection, options = {}) {
    if (options.where) return (await this.list(collection, { ...options, limit: 5000 })).length;
    return (await this.list(collection, { limit: 5000 })).length;
  }
  async findUsers(query, options = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.list('users', { ...options, orderBy: 'lastActivityAtMs', direction: 'desc' });
    if (/^\d{1,20}$/.test(q)) {
      const one = await this.get(`users/${q}`);
      return one ? [{ id: q, data: one, path: `users/${q}` }] : [];
    }
    const rows = await this.list('users', { limit: options.limit || 250, orderBy: 'lastActivityAtMs', direction: 'desc' });
    return rows.filter(row => `${row.data.username || ''} ${row.data.firstName || ''} ${row.data.lastName || ''}`.toLowerCase().includes(q)).slice(0, options.limit || 25);
  }

  async runTransaction(callback) {
    const before = this._tail;
    let release;
    this._tail = new Promise(resolve => { release = resolve; });
    await before;
    const writes = [];
    const staged = new Map();
    let writesStarted = false;
    const tx = {
      get: async path => {
        if (writesStarted) throw Object.assign(new Error('READ_AFTER_WRITE'),{code:'READ_AFTER_WRITE'});
        return clone(staged.has(path) ? staged.get(path) : (this.docs.get(path) || null));
      },
      set: (path, data, options = {}) => {
        writesStarted = true;
        const previous = staged.has(path) ? staged.get(path) : this.docs.get(path);
        staged.set(path, options.merge ? mergeObjects(previous || {}, data) : clone(data));
        writes.push({ path, action: 'set' });
      },
      create: (path, data) => {
        writesStarted = true;
        const current = staged.has(path) ? staged.get(path) : this.docs.get(path);
        if (current) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'ALREADY_EXISTS' });
        staged.set(path, clone(data));
        writes.push({ path, action: 'create' });
      },
      update: (path, data) => {
        writesStarted = true;
        const current = staged.has(path) ? staged.get(path) : this.docs.get(path);
        if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        staged.set(path, mergeObjects(current, data));
        writes.push({ path, action: 'update' });
      },
      delete: path => { writesStarted = true; staged.set(path, null); writes.push({ path, action: 'delete' }); }
    };
    try {
      const result = await callback(tx);
      for (const { path, action } of writes) {
        if (action === 'delete') this.docs.delete(path);
        else this.docs.set(path, clone(staged.get(path)));
      }
      return result;
    } finally {
      release();
    }
  }
}

function matches(data, where) {
  return Object.entries(where).every(([field, rule]) => {
    const value = data && data[field];
    if (typeof rule === 'function') return rule(value);
    if (Array.isArray(rule)) return rule.includes(value);
    if (rule && typeof rule === 'object' && Object.hasOwn(rule, 'op')) {
      const expected = rule.value;
      switch (rule.op) {
        case '==': case '===': return value === expected;
        case '!=': case '!==': return value !== expected;
        case '>': return value > expected;
        case '>=': return value >= expected;
        case '<': return value < expected;
        case '<=': return value <= expected;
        case 'in': return Array.isArray(expected) && expected.includes(value);
        case 'not-in': return Array.isArray(expected) && !expected.includes(value);
        case 'array-contains': return Array.isArray(value) && value.includes(expected);
        case 'array-contains-any': return Array.isArray(value) && Array.isArray(expected) && expected.some(item => value.includes(item));
        default: return false;
      }
    }
    return value === rule;
  });
}
function compare(a, b) {
  const aa = a instanceof Date ? a.getTime() : (typeof a === 'object' && a && typeof a.toMillis === 'function' ? a.toMillis() : a);
  const bb = b instanceof Date ? b.getTime() : (typeof b === 'object' && b && typeof b.toMillis === 'function' ? b.toMillis() : b);
  if (aa === bb) return 0;
  return aa < bb ? -1 : 1;
}

class FirestoreStore {
  constructor(db, FieldValue) {
    this.db = db;
    this.FieldValue = FieldValue;
  }
  timestamp() { return this.FieldValue.serverTimestamp(); }
  async get(path) {
    const snap = await this.db.doc(path).get();
    return snap.exists ? snap.data() : null;
  }
  async set(path, data, options = {}) {
    await this.db.doc(path).set(data, { merge: !!options.merge });
    return this.get(path);
  }
  async create(path, data) {
    await this.db.doc(path).create(data);
    return clone(data);
  }
  async update(path, data) {
    await this.db.doc(path).update(data);
    return this.get(path);
  }
  async list(collection, options = {}) {
    let query = this.db.collection(collection);
    if (options.where && typeof options.where === 'object') {
      for (const [field, rule] of Object.entries(options.where)) {
        if (Array.isArray(rule)) query = query.where(field, 'in', rule);
        else if (rule && typeof rule === 'object' && Object.hasOwn(rule, 'op')) query = query.where(field, rule.op, rule.value);
        else query = query.where(field, '==', rule);
      }
    }
    if (options.orderBy) query = query.orderBy(options.orderBy, options.direction === 'asc' ? 'asc' : 'desc');
    query = query.limit(Math.max(1, Math.min(Number(options.limit) || 100, 5000)));
    const snap = await query.get();
    return snap.docs.map(doc => ({ id: doc.id, path: doc.ref.path, data: doc.data() }));
  }
  async count(collection, options = {}) {
    let query = this.db.collection(collection);
    if (options.where) for (const [field, rule] of Object.entries(options.where)) {
      if (Array.isArray(rule)) query = query.where(field, 'in', rule);
      else if (rule && typeof rule === 'object' && Object.hasOwn(rule, 'op')) query = query.where(field, rule.op, rule.value);
      else query = query.where(field, '==', rule);
    }
    const result = await query.count().get();
    return result.data().count;
  }
  async findUsers(query, options = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.list('users', { orderBy: 'lastActivityAtMs', direction: 'desc', limit: options.limit || 25 });
    if (/^\d{1,20}$/.test(q)) {
      const row = await this.get(`users/${q}`);
      return row ? [{ id: q, path: `users/${q}`, data: row }] : [];
    }
    const docs = await this.db.collection('users')
      .where('usernameLower', '>=', q)
      .where('usernameLower', '<=', `${q}\uf8ff`)
      .orderBy('usernameLower')
      .limit(options.limit || 25)
      .get();
    return docs.docs.map(doc => ({ id: doc.id, path: doc.ref.path, data: doc.data() }));
  }
  runTransaction(callback) {
    return this.db.runTransaction(async firestoreTx => {
      const tx = {
        get: async path => {
          const snap = await firestoreTx.get(this.db.doc(path));
          return snap.exists ? snap.data() : null;
        },
        set: (path, data, options = {}) => firestoreTx.set(this.db.doc(path), data, { merge: !!options.merge }),
        create: (path, data) => firestoreTx.create(this.db.doc(path), data),
        update: (path, data) => firestoreTx.update(this.db.doc(path), data),
        delete: path => firestoreTx.delete(this.db.doc(path))
      };
      return callback(tx);
    });
  }
}

function makeFirebaseStore(config) {
  if (!config.firebaseServiceAccount && !config.firebaseCredentialsPath) return { store: null, admin: null, reason: 'firebase_credentials_missing' };
  let admin;
  try { admin = require('firebase-admin'); } catch { return { store: null, admin: null, reason: 'firebase_admin_sdk_missing' }; }
  try {
    const appName = 'mag-ia-backend';
    let app = admin.apps.find(existing => existing.name === appName);
    if (!app) {
      let credential;
      if (config.firebaseServiceAccount) credential = admin.credential.cert(config.firebaseServiceAccount);
      else if (config.firebaseCredentialsPath) {
        const credentialPath = path.isAbsolute(config.firebaseCredentialsPath)
          ? config.firebaseCredentialsPath
          : path.resolve(config.root || process.cwd(),config.firebaseCredentialsPath);
        const serviceAccount = JSON.parse(fs.readFileSync(credentialPath,'utf8'));
        credential = admin.credential.cert(serviceAccount);
      } else credential = admin.credential.applicationDefault();
      app = admin.initializeApp({
        credential,
        ...(config.firebaseProjectId ? { projectId: config.firebaseProjectId } : {}),
        ...(config.firebaseDatabaseUrl ? { databaseURL: config.firebaseDatabaseUrl } : {})
      }, appName);
    }
    const db = admin.firestore(app);
    return { store: new FirestoreStore(db, admin.firestore.FieldValue), admin, reason: null };
  } catch {
    return { store: null, admin, reason: 'firebase_initialization_failed' };
  }
}

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

module.exports = { MemoryStore, FirestoreStore, makeFirebaseStore, sha256, clone };
