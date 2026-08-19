#!/usr/bin/env bash
#
# Build, push, migrate, deploy - in that order.
#
# The order matters. The migration job must finish before the new revision takes
# traffic, or a replica running new code against an old schema will serve errors
# on every route that touches a changed table.
#
#   ./deploy.sh                 # deploy the current git SHA to the current workspace
#   IMAGE_TAG=v1.2.3 ./deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
WORKSPACE="$(terraform workspace show)"

echo "==> Deploying tag ${IMAGE_TAG} to workspace ${WORKSPACE}"

REGISTRY="$(terraform output -raw container_registry)"
REPOSITORY="$(terraform output -raw image_repository)"
RESOURCE_GROUP="$(terraform output -raw resource_group)"
MIGRATE_JOB="$(terraform output -raw migrate_job)"

# --- build ------------------------------------------------------------------
# --platform is explicit because Container Apps runs amd64 and a build from an
# Apple Silicon machine would otherwise produce an arm64 image that fails to
# start with an exec-format error - and does so only in Azure.
echo "==> Building ${REPOSITORY}:${IMAGE_TAG}"
docker build --platform linux/amd64 -t "${REPOSITORY}:${IMAGE_TAG}" ..

echo "==> Pushing to ${REGISTRY}"
az acr login --name "${REGISTRY%%.*}"
docker push "${REPOSITORY}:${IMAGE_TAG}"

# --- migrate ----------------------------------------------------------------
# The job still points at the previous image until the apply below, so pass the
# new one as an override. scripts/migrate.ts is idempotent and takes an advisory
# lock, so a concurrent deploy queues rather than races.
echo "==> Running migrations"
az containerapp job start \
  --name "${MIGRATE_JOB}" \
  --resource-group "${RESOURCE_GROUP}" \
  --image "${REPOSITORY}:${IMAGE_TAG}" \
  --output none

echo "==> Waiting for the migration job to finish"
for _ in $(seq 1 60); do
  STATUS="$(az containerapp job execution list \
    --name "${MIGRATE_JOB}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "sort_by([], &properties.startTime)[-1].properties.status" -o tsv)"
  case "${STATUS}" in
    Succeeded) echo "    migrations applied"; break ;;
    Failed|Degraded)
      echo "    migration job ${STATUS} - not deploying. Logs:" >&2
      az containerapp job logs show \
        --name "${MIGRATE_JOB}" --resource-group "${RESOURCE_GROUP}" --tail 100 >&2 || true
      exit 1
      ;;
    *) sleep 5 ;;
  esac
done

if [ "${STATUS}" != "Succeeded" ]; then
  echo "    migration job did not finish within 5 minutes - not deploying" >&2
  exit 1
fi

# --- deploy -----------------------------------------------------------------
echo "==> Rolling out the new revision"
terraform apply -var="image_tag=${IMAGE_TAG}" -auto-approve

echo "==> Deployed: $(terraform output -raw app_url)"
