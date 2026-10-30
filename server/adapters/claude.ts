import { GenericCliAdapter, type GenericCliAdapterOptions } from "./generic.js";

/** Role home for Claude Code (CLAUDE_CONFIG_DIR). */
export class ClaudeCliAdapter extends GenericCliAdapter {
  constructor(options: GenericCliAdapterOptions = {}) {
    super({ ...options, driverName: "claude" });
  }
}

export { ClaudeCliAdapter as ClaudeAdapter };
export { ClaudeCliAdapter as ClaudeDriverAdapter };
export default ClaudeCliAdapter;
