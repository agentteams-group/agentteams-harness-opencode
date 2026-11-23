#!/usr/bin/env bash
set -euo pipefail
if [[ "${AGENTTEAMS_LOG_CAPTURED:-}" != 1 ]]; then
    exec python3 /opt/agentteams/scripts/lib/runtime_supervisor.py --runtime opencode -- bash "$0" "$@"
fi
python3 /opt/agentteams/scripts/lib/runtime_observability.py bootstrap
if [[ "${AGENTTEAMS_MATRIX_E2EE:-}" == 1 || "${AGENTTEAMS_MATRIX_E2EE:-}" == true ]]; then
    echo 'ERROR: your OpenCode Harness requires unencrypted Matrix rooms' >&2
    exit 1
fi
source /opt/agentteams/scripts/lib/agentteams-env.sh
export AGENTTEAMS_WORKER_HOME="${AGENTTEAMS_WORKER_HOME:-/root/agentteams-fs/agents/${AGENTTEAMS_WORKER_NAME:?}}"
mkdir -p "${AGENTTEAMS_WORKER_HOME}/runtime" "${AGENTTEAMS_WORKER_HOME}/workspace" "${AGENTTEAMS_WORKER_HOME}/shared"
if ! ensure_mc_credentials || ! agentteams_mc_host_configured; then
    if [[ "${AGENTTEAMS_STORAGE_PROVIDER:-minio}" == oss ]]; then
        echo 'ERROR: your storage credentials are unavailable' >&2
        exit 1
    fi
    mc alias set "${AGENTTEAMS_STORAGE_ALIAS}" "${AGENTTEAMS_FS_ENDPOINT:?}" \
        "${AGENTTEAMS_FS_ACCESS_KEY:?}" "${AGENTTEAMS_FS_SECRET_KEY:?}" >/dev/null
fi
export TEAMHARNESS_RUNTIME_CONFIG="${AGENTTEAMS_WORKER_HOME}/runtime/runtime.yaml"
export TEAMHARNESS_WORKSPACE="${AGENTTEAMS_WORKER_HOME}/workspace"
export TEAMHARNESS_SHARED_DIR="${TEAMHARNESS_SHARED_DIR:-${AGENTTEAMS_SHARED_DIR:-${AGENTTEAMS_WORKER_HOME}/shared}}"
export AGENTTEAMS_PLUGIN_DIR=/opt/agentteams/plugins/teamharness
export OPENCODE_HARNESS_DIR=/opt/agentteams/opencode
for attempt in $(seq 1 12); do
    if python3 -m agentteams_opencode.bootstrap; then break; fi
    if [[ "$attempt" == 12 ]]; then
        echo 'ERROR: your Worker startup assets could not be restored' >&2
        exit 1
    fi
    sleep 5
done
exec python3 -m agentteams_opencode.bridge
