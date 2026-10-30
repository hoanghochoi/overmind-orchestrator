import { GenericCliAdapter, type GenericCliAdapterOptions } from "./generic.js";

/** Role home for the Codex CLI (CODEX_HOME). */
export class CodexCliAdapter extends GenericCliAdapter {
  constructor(options: GenericCliAdapterOptions = {}) {
    super({ ...options, driverName: "codex" });
  }
}

export { CodexCliAdapter as CodexAdapter };
export { CodexCliAdapter as CodexDriverAdapter };
export default CodexCliAdapter;
