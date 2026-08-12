import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  requirementId: string | null;
  template: string | null;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

const dataDir = process.env.DATA_DIR || "./data";
const runsDir = join(dataDir, "runs");

function ensureDir() {
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
}

function runPath(id: string) {
  return join(runsDir, `${id}.json`);
}

export function saveRun(run: WorkflowRun): void {
  ensureDir();
  writeFileSync(runPath(run.id), JSON.stringify(run, null, 2));
}

export function getRun(id: string): WorkflowRun | null {
  const path = runPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as WorkflowRun;
}

export function updateRun(id: string, patch: Partial<WorkflowRun>): WorkflowRun | null {
  const run = getRun(id);
  if (!run) return null;
  const updated = { ...run, ...patch, updatedAt: new Date().toISOString() };
  saveRun(updated);
  return updated;
}

export function listRuns(limit = 20): WorkflowRun[] {
  ensureDir();
  const files = readdirSync(runsDir).filter(f => f.endsWith(".json")).sort().reverse().slice(0, limit);
  return files.map(f => JSON.parse(readFileSync(join(runsDir, f), "utf-8")) as WorkflowRun);
}
