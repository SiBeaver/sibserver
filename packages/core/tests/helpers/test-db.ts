import postgres from 'postgres';
import { SCHEMA_SQL } from '../../src/storage/db.js';
import type { Sql } from '../../src/storage/db.js';

// 测试数据库：独立库 sibeaver_test（10.1.1.40），与生产 sibeaver 库隔离
export function testConnectionString(): string {
  return process.env.TEST_DATABASE_URL
    ?? 'postgres://sibeaver:sibeaver@10.1.1.40:5432/sibeaver_test';
}

const TRUNCATE_TABLES = [
  'projects', 'config', 'nodes', 'edges', 'events',
  'gap_baseline', 'gap_rows', 'gap_evidence', 'gap_evidence_log', 'gap_waivers',
  'workpack_claims',
];

// vector 扩展需 superuser 创建；缺失时跳过扩展语句避免 schema 初始化失败
function schemaSqlSansVector(): string {
  return SCHEMA_SQL.split('\n').filter(l => !/^\s*CREATE EXTENSION/i.test(l)).join('\n');
}

/**
 * 创建测试数据库连接：schema 初始化（幂等）+ 全表清空 + 默认项目。
 * 每个测试独立调用，隔离性由 truncate 保证。
 */
export async function createTestDb(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const sql = postgres(testConnectionString(), { max: 1 });
  try {
    await sql.unsafe(schemaSqlSansVector());
    await sql.unsafe(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} CASCADE`);
    await sql`
      INSERT INTO projects (slug, name, description, created_at, updated_at)
      VALUES ('default', 'Default Project', '', ${new Date().toISOString()}, ${new Date().toISOString()})
      ON CONFLICT (slug) DO NOTHING
    `;
  } catch (e) {
    await sql.end();
    throw e;
  }
  return {
    sql,
    close: () => sql.end(),
  };
}
