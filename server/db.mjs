// SQLite through node's built-in driver. One file, no server to run.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,            -- Dynamic user id (JWT sub)
      wallet TEXT NOT NULL,           -- lowercase 0x address of the in-app or main wallet
      username TEXT, username_folded TEXT UNIQUE,
      x_username TEXT,                -- from the verified JWT, never from the client
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_wallet ON users(wallet);
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL,
      category INTEGER NOT NULL, life_sec INTEGER NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY,         -- onchain id
      creator TEXT NOT NULL, creator_id TEXT NOT NULL, category INTEGER NOT NULL,
      terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL, closes_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, created_block INTEGER NOT NULL,
      resolve_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT, scored INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS relays (
      market_id INTEGER NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL, tx TEXT,
      PRIMARY KEY (market_id, voter)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower TEXT NOT NULL, followee TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (follower, followee)
    );
    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY, creator TEXT NOT NULL, asset INTEGER NOT NULL,
      lock_time INTEGER NOT NULL, result_time INTEGER NOT NULL, entry_amount TEXT NOT NULL,
      price_attempts INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS guesses (          -- sealed guesses, held until reveal time
      pool_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, entrant TEXT NOT NULL,
      guess TEXT NOT NULL, salt TEXT NOT NULL, revealed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pool_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS events (            -- recent action log shown in the app
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const kvGet = (k, d = null) => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; };
  const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
  return Object.assign(db, { kvGet, kvSet });
}
