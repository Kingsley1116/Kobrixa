CREATE TABLE users (id TEXT PRIMARY KEY, login TEXT NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE upload_batches (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE INDEX upload_owner_date ON upload_batches(owner_id, created_at);
CREATE TABLE entries (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','audio')), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','published','rejected','withdrawn')),
 version INTEGER NOT NULL DEFAULT 1, upload_id TEXT NOT NULL REFERENCES upload_batches(id), files TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, published_at INTEGER
);
CREATE INDEX gallery_public ON entries(status, published_at DESC, id);
CREATE INDEX gallery_owner ON entries(owner_id, updated_at DESC);
CREATE INDEX gallery_upload ON entries(upload_id);
CREATE TABLE reviews (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), actor_id TEXT NOT NULL,
 status TEXT NOT NULL, version INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX review_quota ON reviews(actor_id, status, created_at);
CREATE TRIGGER upload_quota BEFORE INSERT ON upload_batches BEGIN
 SELECT RAISE(ABORT, 'gallery_quota') WHERE (SELECT COUNT(*) FROM upload_batches WHERE owner_id=NEW.owner_id AND created_at >= CAST(strftime('%s','now','start of day') AS INTEGER)) >= 100;
END;
CREATE TRIGGER submission_quota BEFORE UPDATE OF status ON entries WHEN NEW.status='pending' AND OLD.status!='pending' BEGIN
 SELECT RAISE(ABORT, 'gallery_quota') WHERE (SELECT COUNT(*) FROM reviews WHERE actor_id=NEW.owner_id AND status='pending' AND created_at >= CAST(strftime('%s','now','start of day') AS INTEGER)) >= 20;
END;
CREATE TRIGGER entry_review AFTER UPDATE ON entries BEGIN
 INSERT INTO reviews(entry_id, actor_id, status, version, reason, created_at) VALUES(NEW.id, NEW.actor_id, NEW.status, NEW.version, NEW.reason, NEW.updated_at);
END;
