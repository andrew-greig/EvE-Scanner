import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '..', 'eve_intel.db');
const db: Database.Database = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    character_id INTEGER PRIMARY KEY,
    character_name TEXT,
    refresh_token TEXT
  )
`);

export interface UserToken {
  character_id: number;
  character_name: string | null;
  refresh_token: string;
}

export function getUserToken(): UserToken | undefined {
  return db.prepare('SELECT * FROM tokens LIMIT 1').get() as UserToken | undefined;
}

export function upsertUserToken(token: UserToken): void {
  db.prepare(`
    INSERT INTO tokens (character_id, character_name, refresh_token)
    VALUES (@character_id, @character_name, @refresh_token)
    ON CONFLICT(character_id) DO UPDATE SET
      character_name = excluded.character_name,
      refresh_token = excluded.refresh_token
  `).run({
    character_id: token.character_id,
    character_name: token.character_name,
    refresh_token: token.refresh_token,
  });
}

export function deleteAllTokens(): void {
  db.prepare('DELETE FROM tokens').run();
}

export default db;
