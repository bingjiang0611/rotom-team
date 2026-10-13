#!/bin/sh
# A subagent's Pi process in a team kernel: pi-subagents runs this in place of Pi (PI_SUBAGENT_PI_BINARY). It is the
# verified Pi CLI of the parent kernel plus the team policy, so the child reaches the model only through the parent
# run's gate, as the same payer and model, and only while that run is active. Like its parent, it trusts the project.
ROTOM_TEAM_SUBAGENT=1 exec "${ROTOM_NODE:?}" "${ROTOM_VERIFIED_PI_EXECUTABLE:?}" --approve --no-skills --extension "${ROTOM_TEAM_SKILLS:?}" --extension "${ROTOM_TEAM_POLICY:?}" "$@"
