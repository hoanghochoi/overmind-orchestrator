import { GenericCliAdapter, type GenericCliAdapterOptions } from "./generic.js";

/** Role home for OpenCode. */
export class OpenCodeCliAdapter extends GenericCliAdapter {
  constructor(options: GenericCliAdapterOptions = {}) {
    super({ ...options, driverName: "opencode" });
  }
}

export { OpenCodeCliAdapter as OpencodeAdapter };
export { OpenCodeCliAdapter as OpenCodeAdapter };
export { OpenCodeCliAdapter as OpenCodeDriverAdapter };
export default OpenCodeCliAdapter;
