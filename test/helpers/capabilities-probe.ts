import { listProductionCapabilities, productionBuildProvenance } from "../../src/production-capabilities.js";

const capabilities = listProductionCapabilities({ scanningEnabled: true });
process.stdout.write(JSON.stringify({
  provenance: productionBuildProvenance(),
  firstCapability: capabilities[0],
}));
