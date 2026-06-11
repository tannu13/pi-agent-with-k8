import {
  ApiException,
  CoordinationV1Api,
  CoreV1Api,
  KubeConfig,
  V1Pod,
} from "@kubernetes/client-node";

import env from "../env";
import type { TPodInfo } from "../types";

export const createK8Service = () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();

  const coordApi = kc.makeApiClient(CoordinationV1Api);
  const k8sApi = kc.makeApiClient(CoreV1Api);

  const isPodReady = (pod: V1Pod): boolean => {
    if (pod.status?.phase !== "Running") return false;
    const conditions = pod.status.conditions || [];
    return conditions.some((c) => c.type === "Ready" && c.status === "True");
  };

  const init = async () => {
    const expectedPods = Array.from(
      { length: 8 },
      (_, i) => `${env.K8_LABEL}-${i}`,
    );

    for (const name of expectedPods) {
      try {
        await coordApi.createNamespacedLease({
          namespace: env.K8_NAMESPACE,
          body: {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: {
              name,
              labels: {
                app: env.K8_LABEL,
              },
            },
            spec: {
              holderIdentity: "",
              leaseDurationSeconds: env.LEASE_DURATION_SECONDS,
            },
          },
        });
      } catch (err) {
        if (!(err instanceof ApiException && err.code === 409)) throw err;
      }
    }
  };

  const getLeases = async () => {
    const res = await coordApi.listNamespacedLease({
      namespace: env.K8_NAMESPACE,
      labelSelector: `app=${env.K8_LABEL}`,
    });
    return res.items;
  };

  const getPods = async () => {
    const res = await k8sApi.listNamespacedPod({
      namespace: env.K8_NAMESPACE,
      labelSelector: `app=${env.K8_LABEL}`,
    });

    const podsMap = new Map<string, TPodInfo>();
    let totalHealthyCount = 0;

    for (const pod of res.items) {
      const name = pod.metadata?.name;
      if (!name) continue;

      const ready = isPodReady(pod);
      if (ready) totalHealthyCount++;

      podsMap.set(name, { name, ready });
    }

    return { totalHealthyCount, podsMap };
  };

  return { init, getLeases, getPods };
};
