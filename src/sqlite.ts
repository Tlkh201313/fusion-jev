// Minimal better-sqlite3-compatible surface over the built-in node:sqlite module.
// A built-in driver means `npx` installs need no native build or prebuilt binary.
type SqliteModule = typeof import('node:sqlite');
type Param = import('node:sqlite').SQLInputValue;
/** Rows are untyped like better-sqlite3's; callers cast to their row shapes. */
export interface Statement {
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
  run(...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

let sqlite: SqliteModule | undefined;

function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  // Node 22 labels node:sqlite experimental. Keep that single notice off stderr,
  // which carries command summaries; every other warning is still emitted.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (typeof message === 'string' && message.startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try { sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule; }
  finally { process.emitWarning = emitWarning; }
  if (!sqlite?.DatabaseSync) throw new Error('Fusion evidence storage requires Node 22.13 or later (node:sqlite)');
  return sqlite;
}

export class Database {
  private readonly db: InstanceType<SqliteModule['DatabaseSync']>;
  private depth = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.db = new (loadSqlite().DatabaseSync)(path, { readOnly: Boolean(options.readonly) });
  }

  prepare(sql: string): Statement {
    const statement = this.db.prepare(sql);
    // node:sqlite rows have a null prototype; return plain objects like better-sqlite3.
    return {
      get: (...params) => { const row = statement.get(...params); return row && { ...row }; },
      all: (...params) => statement.all(...params).map(row => ({ ...row })),
      run: (...params) => statement.run(...params),
    };
  }

  exec(sql: string): void { this.db.exec(sql); }

  pragma(statement: string): void { this.db.exec(`PRAGMA ${statement}`); }

  close(): void { this.db.close(); }

  /** Same contract as better-sqlite3: commit on return, roll back on throw, savepoints when nested. */
  transaction<T>(work: () => T): { immediate(): T } {
    return {
      immediate: () => {
        const savepoint = this.depth > 0 ? `fusion_${this.depth}` : undefined;
        this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
        this.depth++;
        try {
          const result = work();
          this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
          return result;
        } catch (error) {
          try { this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); }
          catch { /* Preserve the original failure. */ }
          throw error;
        } finally { this.depth--; }
      },
    };
  }
}
