import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONTRACT_LABEL = "overmind.contract.lock";
const artifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const lockSchema = z.object({
  version: z.literal(1),
  leadId: z.string().min(1),
  workspaceId: z.string().min(1),
  lockedAt: z.string().datetime(),
  schema: artifactSchema,
  api: artifactSchema,
});
export type ContractLock = z.infer<typeof lockSchema>;
interface ContractOwner {
  id: string;
  cwd?: string;
  workspaceId?: string;
  labels: Record<string, string>;
}

function denied(reason: string): never {
  throw new Error(`OVERMIND_CONTRACT_DENIED: ${reason}`);
}

async function artifact(owner: ContractOwner, file: string) {
  if (!owner.cwd || !owner.workspaceId) denied("Lead has no workspace");
  const root = await realpath(owner.cwd);
  // Check both the requested path and its symlink target before reading anything.
  const contained = (target: string) => {
    const relative = path.relative(root, target);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      denied("contract artifacts must stay inside the Lead workspace");
    return relative;
  };
  const requested = path.resolve(root, file);
  contained(requested);
  const resolved = await realpath(requested);
  contained(resolved);
  const content = await readFile(resolved);
  if (content.length === 0) denied("contract artifacts must not be empty");
  return { path: contained(requested), sha256: createHash("sha256").update(content).digest("hex") };
}

export function readContractLock(owner: ContractOwner): ContractLock | null {
  try {
    const lock = lockSchema.parse(JSON.parse(owner.labels[CONTRACT_LABEL] ?? ""));
    return lock.leadId === owner.id && lock.workspaceId === owner.workspaceId ? lock : null;
  } catch {
    return null;
  }
}

export async function createContractLock(
  owner: ContractOwner,
  schemaPath: string,
  apiContractPath: string,
): Promise<ContractLock> {
  const [schema, api] = await Promise.all([
    artifact(owner, schemaPath),
    artifact(owner, apiContractPath),
  ]);
  return {
    version: 1,
    leadId: owner.id,
    workspaceId: owner.workspaceId!,
    lockedAt: new Date().toISOString(),
    schema,
    api,
  };
}

export async function assertContractLocked(owner: ContractOwner): Promise<void> {
  const lock = readContractLock(owner);
  if (!lock) denied("Lead must contract_lock both schema and API artifacts before Peer test tasks");
  try {
    const [schema, api] = await Promise.all([
      artifact(owner, lock.schema.path),
      artifact(owner, lock.api.path),
    ]);
    if (schema.sha256 !== lock.schema.sha256 || api.sha256 !== lock.api.sha256)
      denied("contract artifacts changed; the Lead must lock them again");
  } catch (error) {
    denied(
      `cannot validate current contract artifacts (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
