import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { TaskRecordSchema, type TaskRecord } from "../shared/control.js";

/**
 * Task and notebook history live in the project root, not the workspace: worktrees and
 * agents get archived, the project's record of what was done must not.
 */
export async function projectRoot(paseo: PaseoApi, workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.projectRootPath) throw new Error(`Workspace ${workspaceId} is unavailable`);
  return workspace.projectRootPath;
}

const fileSchema = z.object({ version: z.literal(1), tasks: z.array(TaskRecordSchema) });
const writes = new Map<string, Promise<unknown>>();

function tasksPath(root: string): string {
  return join(root, ".overmind", "tasks.json");
}

async function load(path: string): Promise<TaskRecord[]> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(path, "utf8"))).tasks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readTasks(root: string): Promise<TaskRecord[]> {
  const path = tasksPath(root);
  await writes.get(path)?.catch(() => undefined);
  return load(path);
}

/** Upsert by agent; a task is never removed, so archive leaves its last state behind. */
export function recordTask(root: string, task: TaskRecord): Promise<undefined> {
  const path = tasksPath(root);
  const write = (writes.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const tasks = await load(path);
      const previous = tasks.find((entry) => entry.agentId === task.agentId);
      const next = { ...task, archivedAt: task.archivedAt ?? previous?.archivedAt ?? null };
      const updated = previous
        ? tasks.map((entry) => (entry === previous ? next : entry))
        : [...tasks, next];
      await mkdir(join(root, ".overmind"), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, tasks: updated }, null, 2));
      await rename(temporary, path);
      return undefined;
    });
  writes.set(path, write);
  void write
    .finally(() => {
      if (writes.get(path) === write) writes.delete(path);
    })
    .catch(() => undefined);
  return write;
}
