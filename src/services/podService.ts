import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";
import { PossiblePhases, type TPossiblePhases } from "../types";

type TPodInfo = {
  name: string;
  status: TPossiblePhases;
};

export const createPodService = () => {
  const getPods = async () => {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const k8sApi = kc.makeApiClient(CoreV1Api);

    let kubernetesConnected = false;
    let podsCount = 0;
    let healthyPodsCount = 0;
    let podsInfo: TPodInfo[] = [];
    try {
      const pods = await k8sApi.listNamespacedPod({
        namespace: "default",
        labelSelector: "app=sandbox-runner",
      });
      kubernetesConnected = true;
      for (const pod of pods.items) {
        if (!pod.metadata?.name) continue;
        podsCount++;

        podsInfo.push({
          name: pod.metadata.name,
          status: pod.status?.phase as TPossiblePhases,
        });

        if (pod.status?.phase === PossiblePhases.enum.Running) {
          healthyPodsCount++;
        }
      }
    } catch (err) {
      console.error("Error fetching pods:", err);
    }

    return {
      totalCount: podsCount,
      totalHealthyCount: healthyPodsCount,
      podsInfo,
    };
  };

  return { getPods };
};
export type TPodService = ReturnType<typeof createPodService>;
