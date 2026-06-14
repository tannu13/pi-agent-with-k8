import env from "./env";
import { createK8Service } from "./services/k8Service";
import { assertPiCredentials, RealPiClient } from "./services/piClient";
import { createApp } from "./server";

assertPiCredentials();

const k8Service = createK8Service();
await k8Service.init();

const app = createApp({
  k8Service,
  piClient: new RealPiClient(k8Service),
});

app.listen(env.APP_PORT, () => {
  console.log(`Server started on port: ${env.APP_PORT}`);
});
