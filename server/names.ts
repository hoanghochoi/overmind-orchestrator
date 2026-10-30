import type { Role } from "./policy.js";

/** Great minds Overmind names its Leads and Peers after. */
export const GREAT_NAMES = [
  "Davinci",
  "Einstein",
  "Newton",
  "Curie",
  "Tesla",
  "Turing",
  "Lovelace",
  "Galileo",
  "Darwin",
  "Archimedes",
  "Aristotle",
  "Socrates",
  "Confucius",
  "Mozart",
  "Beethoven",
  "Shakespeare",
  "Edison",
  "Hawking",
  "Pasteur",
  "Copernicus",
] as const;

export const NAME_LABEL = "overmind.name";
const ROLE_TITLES: Record<Role, string> = { supervisor: "Supervisor", lead: "Lead", peer: "Peer" };

/** A random name, preferring one no live agent carries; repeats only once the pool is used up. */
export function pickName(taken: ReadonlySet<string>, random = Math.random): string {
  const free = GREAT_NAMES.filter((name) => !taken.has(name));
  const pool = free.length ? free : GREAT_NAMES;
  return pool[Math.floor(random() * pool.length)]!;
}

export function seatTitle(name: string, role: Role, task: string): string {
  return `${name} - ${ROLE_TITLES[role]} - ${task}`;
}
