import { describe, it, expect } from 'vitest';
import { createHonoApp } from '../src/api/server.js';
import type { ProjectManager } from '../src/projects/manager.js';

describe('health', () => {
  it('返回 API spec 版本与能力清单', async () => {
    const app = createHonoApp({} as ProjectManager);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      apiSpecVersion: string;
      capabilities: string[];
    };
    expect(data.apiSpecVersion).toBe('2.1.0');
    expect(data.capabilities).toEqual(expect.arrayContaining([
      'knowledge_trail', 'claims',
    ]));
  });
});
