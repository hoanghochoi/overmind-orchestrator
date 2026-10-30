export const OVERMIND_PROFILES = {
  supervisor: { id: "overmind-supervisor", label: "Overmind Supervisor" },
  lead: { id: "overmind-lead", label: "Overmind Lead" },
  peer: { id: "overmind-peer", label: "Overmind Peer" },
} as const;
export type ProfileRole = keyof typeof OVERMIND_PROFILES;
/** Profiles of the removed Peer kinds, `overmind-peer-<kind>`: their seats stay Peers and publishing disables them. */
export const PEER_KIND_PREFIX = `${OVERMIND_PROFILES.peer.id}-`;
export function roleForProvider(provider: string): ProfileRole | null {
  if (provider.startsWith(PEER_KIND_PREFIX)) return "peer";
  for (const role of ["supervisor", "lead", "peer"] as const)
    if (OVERMIND_PROFILES[role].id === provider) return role;
  return null;
}
