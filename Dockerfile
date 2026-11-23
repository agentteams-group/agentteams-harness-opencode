# syntax=docker/dockerfile:1
ARG AGENTTEAMS_CONTROLLER_IMAGE
ARG MC_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/higress/mc:20260216
FROM ${AGENTTEAMS_CONTROLLER_IMAGE} AS controller
FROM ${MC_IMAGE} AS mc
FROM oven/bun:1.3.3-debian
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq python3 python3-venv tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=controller /usr/local/bin/agt /usr/local/bin/agt
COPY --from=controller /opt/agentteams/agent/ /opt/agentteams/agent/
COPY --from=mc /usr/bin/mc /usr/local/bin/mc.bin
# The named Core context must be the same frozen candidate as the agt image.
COPY --from=at /shared/lib/ /opt/agentteams/scripts/lib/
COPY --from=at /plugins/teamharness/ /opt/agentteams/plugins/teamharness/
# Match existing Codex transport packaging; consume these pinned helpers
# unchanged rather than keeping another copy of Matrix policy/retry logic.
COPY --from=at /deepseek-harness/scripts/*.py /opt/agentteams/transport/
WORKDIR /opt/agentteams/opencode
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --registry https://registry.npmjs.org
COPY src/ src/
COPY pyproject.toml ./
COPY python/ python/
RUN python3 -m venv /opt/venv/opencode \
    && /opt/venv/opencode/bin/pip install --no-cache-dir . -r /opt/agentteams/scripts/lib/telemetry/requirements.txt \
    && chmod +x /opt/agentteams/scripts/lib/mc-wrapper.sh \
    && ln -s /opt/agentteams/scripts/lib/mc-wrapper.sh /usr/local/bin/mc
COPY scripts/entrypoint.sh /opt/agentteams/entrypoint.sh
ENV PATH="/opt/venv/opencode/bin:${PATH}" \
    TEAMHARNESS_PYTHON=/opt/venv/opencode/bin/python3 \
    PYTHONPATH=/opt/agentteams/scripts/lib:/opt/agentteams/transport \
    OPENCODE_HARNESS_DIR=/opt/agentteams/opencode \
    AGENTTEAMS_OTEL_RUNTIME=opencode
EXPOSE 8088
ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/opt/agentteams/entrypoint.sh"]
