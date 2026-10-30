import { GenericCliAdapter, type GenericCliAdapterOptions } from "./generic.js";

/** Role home for Pi. */
export class PiCliAdapter extends GenericCliAdapter {
  constructor(options: GenericCliAdapterOptions = {}) {
    super({ ...options, driverName: "pi" });
  }
}

export { PiCliAdapter as PiAdapter };
export { PiCliAdapter as PiDriverAdapter };
export default PiCliAdapter;
