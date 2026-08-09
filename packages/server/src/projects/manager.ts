import { getPool, type Sql, OperationContext } from '../index.js';
import { Registry } from './registry.js';
import type { ProjectMeta, CreateProjectInput, UpdateProjectInput } from './types.js';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export class ProjectManager {
  private sql!: Sql;
  private registry!: Registry;
  private contexts = new Map<string, OperationContext>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.sql = await getPool();
    this.registry = new Registry(this.sql);
    this.initialized = true;
  }

  getContext(slug: string): OperationContext {
    const existing = this.contexts.get(slug);
    if (existing) return existing;
    const ctx = new OperationContext(this.sql, slug);
    this.contexts.set(slug, ctx);
    return ctx;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectMeta> {
    validateSlug(input.slug);
    const existing = await this.registry.getProject(input.slug);
    if (existing) {
      throw new Error(`项目「${input.slug}」已存在`);
    }
    return this.registry.insertProject(input);
  }

  async listProjects(): Promise<ProjectMeta[]> {
    return this.registry.listProjects();
  }

  async getProject(slug: string): Promise<ProjectMeta | null> {
    return this.registry.getProject(slug);
  }

  async updateProject(slug: string, patch: UpdateProjectInput): Promise<ProjectMeta> {
    const result = await this.registry.updateProject(slug, patch);
    if (!result) throw new Error(`项目「${slug}」不存在`);
    return result;
  }

  async archiveProject(slug: string): Promise<void> {
    await this.registry.archiveProject(slug);
    this.contexts.delete(slug);
  }

  async deleteProject(slug: string): Promise<void> {
    await this.registry.deleteProject(slug);
    this.contexts.delete(slug);
  }

  async getDefaultProject(): Promise<string> {
    return process.env.SI_BEAVER_DEFAULT_PROJECT
      ?? await this.registry.getConfig('default_project')
      ?? 'default';
  }

  async setDefaultProject(slug: string): Promise<void> {
    const project = await this.registry.getProject(slug);
    if (!project) {
      throw new Error(`项目「${slug}」不存在`);
    }
    await this.registry.setConfig('default_project', slug);
  }

  async close(): Promise<void> {
    this.contexts.clear();
    await this.registry.close();
  }
}

function validateSlug(slug: string): void {
  if (!slug || slug.length > 64) {
    throw new Error('slug 必须为 1-64 个字符');
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new Error('slug 必须是小写字母数字加连字符（如 "my-project"）');
  }
}
