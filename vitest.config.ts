import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "react-native",
        replacement: path.resolve("node_modules/react-native-web/dist/index.js"),
      },
    ],
  },
  test: {
    environment: "node",
    env: {
      PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
  },
});
