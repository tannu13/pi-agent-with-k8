# Pi Agent With Kubernetes-Leased Sandboxes

TypeScript backend service exposing `POST /chat`, `GET /pods`, and `GET /health`.
Pi tool calls run inside one of eight warm Kubernetes sandbox pods. Pods are leased
just in time through Kubernetes `Lease` objects and released after each tool call.

## Local Setup

Install dependencies:

```bash
bun install
```

Create or use a local Kubernetes cluster with kind, minikube, or Docker Desktop.
Apply the sandbox manifests:

```bash
kubectl apply -f infra/namespace.yaml
kubectl apply -f infra/service.yaml
kubectl apply -f infra/statefulset.yaml
kubectl rollout status statefulset/sandbox-runner
```

For in-cluster API deployment, also apply the RBAC and API manifests after building
and loading an image named `pi-agent-with-k8:local` and creating a secret named
`pi-agent-api-env` from `.env.example` values.

```bash
kubectl apply -f infra/api-rbac.yaml
kubectl apply -f infra/api-deployment.yaml
```

For local development, copy `.env.example` to `.env`, set `GEMINI_API_KEY`, then run:

```bash
bun run dev
```

The service reads the active kubeconfig with `@kubernetes/client-node`, so local
development uses your current Kubernetes context.

## Pi Configuration

The default Pi model path is:

```dotenv
PI_PROVIDER=google
PI_MODEL=gemma-4-26b-a4b-it
GEMINI_API_KEY=...
```

Startup fails outside `NODE_ENV=test` when the selected provider has a known
credential variable and that variable is missing. Other providers can be selected
with `PI_PROVIDER` and `PI_MODEL`; update the credential env var accordingly.

## API

Chat:

```bash
curl -s http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-123","message":"Use env.inspect and tell me the pod name."}'
```

Response:

```json
{
  "sessionId": "session-123",
  "message": "The sandbox pod is sandbox-runner-3.",
  "toolCalls": [
    {
      "toolCallId": "tool-abc",
      "tool": "env.inspect",
      "pod": "sandbox-runner-3",
      "status": "completed"
    }
  ]
}
```

Pod state:

```bash
curl -s http://localhost:3000/pods
```

Health:

```bash
curl -s http://localhost:3000/health
```

## Sandbox Runtime

The service creates one Kubernetes `Lease` per expected pod:
`sandbox-runner-0` through `sandbox-runner-7`. A Lease is free when it has no
holder or its `renewTime`/`acquireTime` plus `leaseDurationSeconds` is in the past.

Before each tool call, the API updates one free Lease with optimistic concurrency.
The holder identity is:

```text
${SERVICE_INSTANCE_ID}:${requestId}:${sessionId}:${toolCallId}
```

Tool execution uses Kubernetes `pods/exec`. This avoids a separate HTTP runner
process and custom sandbox image, but it means the API service needs the scoped
`pods/exec` RBAC permission.

The required tools are:

- `shell.run`: allowlisted commands only: `pwd`, `ls`, `cat`, `node --version`, `whoami`
- `fs.read`: reads only paths under `SANDBOX_WORKDIR`, default `/workspace`
- `env.inspect`: returns pod, namespace, working directory, user, and Node version

Leases are released in `finally` after success, failure, timeout, or unexpected
errors. If the API process crashes while holding a Lease, future calls recover the
pod after the Lease TTL expires.

## FIFO Queue

Every tool call enters a process-local FIFO queue. The head of the queue attempts
to acquire a free Lease. If all eight pods are busy, it waits until a Lease is
released or `QUEUE_MAX_WAIT_MS` expires. The default is 15 seconds.

Capacity timeout response:

```json
{
  "error": {
    "code": "sandbox_capacity_timeout",
    "message": "No sandbox pod became available within 15 seconds."
  }
}
```

Example 9 concurrent chat calls:

```bash
for i in $(seq 1 9); do
  curl -s http://localhost:3000/chat \
    -H 'content-type: application/json' \
    -d "{\"sessionId\":\"queue-$i\",\"message\":\"Use env.inspect once.\"}" &
done
wait
```

The first eight calls can lease pods immediately. The ninth waits for a release or
fails with `sandbox_capacity_timeout`.

The queue is process-local because this assignment allows one API process. In a
multi-replica production service, queue state would move to a distributed queue or
scheduler such as Redis Streams, Postgres advisory-lock backed jobs, or a dedicated
work queue. Kubernetes Leases would remain the pod lock source of truth.

## Tests

Offline unit tests:

```bash
bun run test
```

Local Kubernetes integration tests:

```bash
bun run test:integration
```

The integration suite exercises health, real `pods/exec`, Lease release, and nine
concurrent sandbox calls. The Pi-backed smoke test is included but opt-in because
LLM behavior can be slow or non-deterministic:

```bash
RUN_PI_SMOKE=1 GEMINI_API_KEY=... bun run test:integration
```

## Production Notes

- Use a distributed FIFO queue for multiple API replicas.
- Renew Leases for tools that can exceed the Lease TTL.
- Keep crash recovery based on Lease expiration and add periodic stale-Lease metrics.
- Persist execution history for auditing: request, session, tool, pod, command, result.
- Build a hardened sandbox image with minimal packages and pinned versions.
- Add network policies for sandbox egress and API-to-Kubernetes access.
- Add per-user or per-tenant rate limits before queue admission.
- Track metrics for queue depth, wait time, Lease conflicts, timeouts, failures, and pod readiness.
- Alert on sustained capacity timeouts, low ready pod count, and high Lease conflict rates.
