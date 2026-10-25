// The converter Worker (worker/). Deploy with `cf deploy`.
import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "instapaper-epub",
		compatibilityDate: "2026-10-01",
		entrypoint: "worker/index.js",
		workersDev: true,
	},
});
