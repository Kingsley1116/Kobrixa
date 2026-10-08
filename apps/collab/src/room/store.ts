import { chatMessageSchema, type ChatMessage, type Role } from "@kobrixa/collab-protocol";
import type { PasswordVerifier } from "../password.js";

export const PASSWORD_ATTEMPTS_PER_MINUTE = 20;

/** SQLite rows are limited to 2 MB; Y.Doc updates are split into parts below that. */
const CHUNK_BYTES = 512 * 1024;

export type RoomMeta = {
  roomId: string;
  projectName: string;
  inviteCode: string;
  hostId: string;
  createdAt: number;
};

export type ParticipantRow = {
  participantId: string;
  name: string;
  role: Role;
  revoked: boolean;
  joinedAt: number;
};

type RawParticipant = {
  id: string;
  name: string;
  role: string;
  revoked: number;
  joined_at: number;
};

function toParticipant(row: RawParticipant): ParticipantRow {
  return {
    participantId: row.id,
    name: row.name,
    role: row.role === "host" || row.role === "viewer" ? row.role : "editor",
    revoked: row.revoked !== 0,
    joinedAt: row.joined_at,
  };
}

/**
 * Synchronous accessors for the room's SQLite tables:
 * - `room_meta`: one row with the room metadata, present once `/init` ran.
 * - `participants`: every participant that joined (revoked ones are kept so their tokens stay dead).
 * - `doc_updates`: Y.Doc updates in apply order, each split into `part`s. After compaction
 *   the table holds a single merged snapshot.
 */
export class RoomStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS chat_receipts (id TEXT PRIMARY KEY, message TEXT NOT NULL)`,
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_identities (
      participant_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_closed (
      id INTEGER PRIMARY KEY CHECK (id = 1), closed_at INTEGER NOT NULL
    )`);
    // Separate tables keep existing rooms passwordless without rewriting room metadata.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_password (
      id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS join_attempts (
      client TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      host_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS awareness (
      client_id INTEGER PRIMARY KEY,
      socket_id TEXT NOT NULL,
      clock INTEGER NOT NULL,
      state TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS doc_updates (
      seq INTEGER NOT NULL,
      part INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (seq, part)
    )`);
  }

  meta(): RoomMeta | null {
    const row = this.sql
      .exec<{
        room_id: string;
        project_name: string;
        invite_code: string;
        host_id: string;
        created_at: number;
      }>(
        "SELECT room_id, project_name, invite_code, host_id, created_at FROM room_meta WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return null;
    return {
      roomId: row.room_id,
      projectName: row.project_name,
      inviteCode: row.invite_code,
      hostId: row.host_id,
      createdAt: row.created_at,
    };
  }

  password(): PasswordVerifier | null {
    const row = this.sql
      .exec<{ verifier: string }>("SELECT verifier FROM room_password WHERE id = 1")
      .toArray()[0];
    return row ? (JSON.parse(row.verifier) as PasswordVerifier) : null;
  }

  setPassword(verifier: PasswordVerifier): void {
    this.sql.exec(
      "INSERT INTO room_password (id, verifier) VALUES (1, ?)",
      JSON.stringify(verifier),
    );
  }

  /** Durable per-room/client limit, charged before password work, including concurrent attempts. */
  takePasswordAttempt(client: string, now: number): boolean {
    this.sql.exec("DELETE FROM join_attempts WHERE started_at <= ?", now - 60_000);
    const entry = this.sql
      .exec<{ attempts: number }>("SELECT attempts FROM join_attempts WHERE client = ?", client)
      .toArray()[0];
    if (entry) {
      if (entry.attempts >= PASSWORD_ATTEMPTS_PER_MINUTE) return false;
      this.sql.exec("UPDATE join_attempts SET attempts = attempts + 1 WHERE client = ?", client);
    } else {
      if (
        this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM join_attempts").one()
          .count >= 256
      )
        return false;
      this.sql.exec(
        "INSERT INTO join_attempts (client, started_at, attempts) VALUES (?, ?, 1)",
        client,
        now,
      );
    }
    return true;
  }

  clearPasswordAttempts(client: string): void {
    this.sql.exec("DELETE FROM join_attempts WHERE client = ?", client);
  }

  setMeta(meta: RoomMeta): void {
    this.sql.exec(
      "INSERT INTO room_meta (id, room_id, project_name, invite_code, host_id, created_at) VALUES (1, ?, ?, ?, ?, ?)",
      meta.roomId,
      meta.projectName,
      meta.inviteCode,
      meta.hostId,
      meta.createdAt,
    );
  }

  participant(participantId: string): ParticipantRow | null {
    const row = this.sql
      .exec<RawParticipant>(
        "SELECT id, name, role, revoked, joined_at FROM participants WHERE id = ?",
        participantId,
      )
      .toArray()[0];
    return row ? toParticipant(row) : null;
  }

  chatReceipt(id: string): ChatMessage | undefined {
    const row = this.sql
      .exec<{ message: string }>("SELECT message FROM chat_receipts WHERE id = ?", id)
      .toArray()[0];
    return row ? chatMessageSchema.parse(JSON.parse(row.message)) : undefined;
  }

  rememberChat(message: ChatMessage): void {
    this.sql.exec(
      "INSERT INTO chat_receipts (id, message) VALUES (?, ?)",
      message.id,
      JSON.stringify(message),
    );
  }

  setCredential(id: string, hash: string): void {
    this.sql.exec(
      "INSERT INTO room_identities (participant_id, credential_hash) VALUES (?, ?)",
      id,
      hash,
    );
  }

  credential(id: string): string | undefined {
    return this.sql
      .exec<{ credential_hash: string }>(
        "SELECT credential_hash FROM room_identities WHERE participant_id = ?",
        id,
      )
      .toArray()[0]?.credential_hash;
  }

  isClosed(): boolean {
    return this.sql.exec("SELECT id FROM room_closed").toArray().length > 0;
  }

  close(): void {
    this.sql.exec("INSERT OR IGNORE INTO room_closed (id, closed_at) VALUES (1, ?)", Date.now());
    this.sql.exec("UPDATE participants SET revoked = 1");
    this.sql.exec("DELETE FROM room_identities");
    this.sql.exec("DELETE FROM chat_receipts");
    this.sql.exec("DELETE FROM doc_updates");
    this.sql.exec("DELETE FROM awareness");
    this.sql.exec("DELETE FROM room_password");
  }

  /** Participants that were not kicked, in join order. */
  activeParticipants(): ParticipantRow[] {
    return this.sql
      .exec<RawParticipant>(
        "SELECT id, name, role, revoked, joined_at FROM participants WHERE revoked = 0 ORDER BY joined_at, rowid",
      )
      .toArray()
      .map(toParticipant);
  }

  addParticipant(participant: Omit<ParticipantRow, "revoked">): void {
    this.sql.exec(
      "INSERT INTO participants (id, name, role, revoked, joined_at) VALUES (?, ?, ?, 0, ?)",
      participant.participantId,
      participant.name,
      participant.role,
      participant.joinedAt,
    );
  }

  setName(participantId: string, name: string): void {
    this.sql.exec("UPDATE participants SET name = ? WHERE id = ?", name, participantId);
  }

  setRole(participantId: string, role: Role): void {
    this.sql.exec("UPDATE participants SET role = ? WHERE id = ?", role, participantId);
  }

  revoke(participantId: string): void {
    this.sql.exec("UPDATE participants SET revoked = 1 WHERE id = ?", participantId);
  }

  awareness(socketId: string): { clientId: number; clock: number; state: string }[] {
    return this.sql
      .exec<{ clientId: number; clock: number; state: string }>(
        "SELECT client_id AS clientId, clock, state FROM awareness WHERE socket_id = ?",
        socketId,
      )
      .toArray();
  }

  setAwareness(socketId: string, clientId: number, clock: number, state: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO awareness (client_id, socket_id, clock, state) VALUES (?, ?, ?, ?)",
      clientId,
      socketId,
      clock,
      state,
    );
  }

  removeAwareness(socketId: string, clientId?: number): void {
    if (clientId === undefined)
      this.sql.exec("DELETE FROM awareness WHERE socket_id = ?", socketId);
    else
      this.sql.exec(
        "DELETE FROM awareness WHERE socket_id = ? AND client_id = ?",
        socketId,
        clientId,
      );
  }

  /** All stored updates in apply order. */
  loadUpdates(): Uint8Array[] {
    const rows = this.sql
      .exec<{
        seq: number;
        data: ArrayBuffer;
      }>("SELECT seq, data FROM doc_updates ORDER BY seq, part")
      .toArray();
    const updates: Uint8Array[] = [];
    let seq: number | null = null;
    let parts: Uint8Array[] = [];
    const flush = () => {
      if (parts.length > 0) updates.push(concat(parts));
      parts = [];
    };
    for (const row of rows) {
      if (row.seq !== seq) {
        flush();
        seq = row.seq;
      }
      parts.push(new Uint8Array(row.data));
    }
    flush();
    return updates;
  }

  appendUpdate(update: Uint8Array): void {
    const next =
      this.sql
        .exec<{ next: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM doc_updates")
        .one().next ?? 0;
    this.writeUpdate(next, update);
  }

  /** Replaces every stored update with a single snapshot. Call inside a transaction. */
  replaceWithSnapshot(snapshot: Uint8Array): void {
    this.sql.exec("DELETE FROM doc_updates");
    this.writeUpdate(0, snapshot);
  }

  private writeUpdate(seq: number, update: Uint8Array): void {
    for (let offset = 0, part = 0; offset < update.byteLength || part === 0; part++) {
      const slice = update.slice(offset, offset + CHUNK_BYTES);
      this.sql.exec(
        "INSERT INTO doc_updates (seq, part, data) VALUES (?, ?, ?)",
        seq,
        part,
        slice.buffer,
      );
      offset += CHUNK_BYTES;
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
