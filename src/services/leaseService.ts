import {
  ApiException,
  CoordinationV1Api,
  KubeConfig,
} from "@kubernetes/client-node";
import type { TPodService } from "./podService";

export const createLeaseService = (podService: TPodService) => {
  const init = async () => {
    const { podsInfo } = await podService.getPods();

    const kc = new KubeConfig();
    kc.loadFromDefault();

    const coordApi = kc.makeApiClient(CoordinationV1Api);
    for (const pod of podsInfo) {
      try {
        await coordApi.createNamespacedLease({
          namespace: "default",
          body: {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: {
              name: pod.name,
              labels: {
                app: "sandbox-runner",
              },
            },
            spec: {},
          },
        });
      } catch (err) {
        if (err instanceof ApiException && err.code === 409) {
          // already exist, so ignore
        } else {
          throw err;
        }
      }
    }
  };

  return { init };
};
