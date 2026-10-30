import { GenericCliAdapter, type GenericCliAdapterOptions } from "./generic.js";

/** Role home for the Antigravity (agy) CLI. */
export class AgyCliAdapter extends GenericCliAdapter {
  constructor(options: GenericCliAdapterOptions = {}) {
    super({ ...options, driverName: "agy" });
  }
}

export { AgyCliAdapter as AgiAdapter };
export { AgyCliAdapter as AgyAdapter };
export { AgyCliAdapter as AGYCliAdapter };
export { AgyCliAdapter as AGYAdapter };
export { AgyCliAdapter as AgyDriverAdapter };
export default AgyCliAdapter;
