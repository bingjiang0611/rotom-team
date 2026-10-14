#!/bin/sh
# Validate in a separate process. The shell must retain fd 3 (native owner lifeline) through the final exec.
shared_context=$("${ROTOM_NODE:?}" "$(dirname "$0")/rotom-child.ts" "$@") || exit $?
if [ -n "$ROTOM_TEAM_FROZEN_CONTEXT" ]; then
    set -- --no-context-files --append-system-prompt "$ROTOM_TEAM_FROZEN_CONTEXT" "$@"
    if [ -n "$shared_context" ]; then
        set -- --append-system-prompt "$shared_context" "$@"
    fi
fi
npm_config_prefix="${ROTOM_TEAM_AGENT_DIR:?}/global-npm" PI_SUBAGENT_EXTRA_AGENT_DIRS="$ROTOM_TEAM_AGENT_DIR/agents" ROTOM_TEAM_SUBAGENT=1 exec "${ROTOM_NODE:?}" "${ROTOM_VERIFIED_PI_EXECUTABLE:?}" --no-approve --no-skills --extension "${ROTOM_TEAM_SKILLS:?}" --extension "${ROTOM_TEAM_POLICY:?}" "$@"
