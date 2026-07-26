import type { MemoryItem } from "@pa/shared-types";
import type { MemoryRepo } from "../repos.js";
import type { Db } from "./db.js";
import { DEFAULT_USER_ID } from "./default-user.js";

/**
 * Postgres-backed MemoryRepo (COD-4): persists memory_items with real SQL,
 * scoped to the pre-auth default user (COD-2). Same port as `MemoryMemoryRepo`.
 */

interface MemoryRow {
  id: string;
  content: string;
  category: string;
  source: string;
  confidence: number;
  expires_at: string | null;
  proactive_use_allowed: boolean;
  status: string;
}

function rowToItem(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    content: r.content,
    category: r.category as MemoryItem["category"],
    source: r.source as MemoryItem["source"],
    confidence: r.confidence,
    expiresAt: r.expires_at ?? undefined,
    proactiveUseAllowed: r.proactive_use_allowed,
    status: r.status as MemoryItem["status"],
  };
}

export class PgMemoryRepo implements MemoryRepo {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER_ID,
  ) {}

  async add(m: MemoryItem): Promise<MemoryItem> {
    await this.db.query(
      `INSERT INTO memory_items
         (id, user_id, content, category, source, confidence, expires_at, proactive_use_allowed, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.id, this.userId, m.content, m.category, m.source, m.confidence, m.expiresAt ?? null, m.proactiveUseAllowed, m.status],
    );
    return m;
  }

  async listActive(): Promise<MemoryItem[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `SELECT id, content, category, source, confidence, expires_at::text,
              proactive_use_allowed, status
       FROM memory_items WHERE user_id = $1 AND status <> 'deleted'
       ORDER BY created_at`,
      [this.userId],
    );
    return rows.map(rowToItem);
  }

  async softDelete(id: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE memory_items SET status = 'deleted'
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, this.userId],
    );
    return rows.length > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.query(`DELETE FROM memory_items WHERE user_id = $1`, [this.userId]);
  }
}
