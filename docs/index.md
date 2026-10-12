# rotom team documentation

## Current product

Start with [PRODUCT.md](PRODUCT.md) for the execution, account and safety contract, [CONFIGURATION.md](CONFIGURATION.md) for shared project configuration and member MCP sign-ins, and [VERIFICATION.md](VERIFICATION.md) for verification boundaries. The [README](../README.md) describes startup; [DEPLOYMENT.md](DEPLOYMENT.md) and [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) describe operations. [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) and [DELIVERY-CHECKLIST.md](DELIVERY-CHECKLIST.md) define acceptance, not permission to use real accounts or a completed deployment.

Old migration plans and experimental reports are available through Git history, not as current requirements.

## Inherited Pi Pocket / Durable development guides

The remaining sections document the inherited backend and its implementation. Their Pi Pocket paths, global Pi resources and extension workflows do **not** describe the default rotom session configuration. Use the current guides above for rotom sessions. These documents remain because the agent prompt and old backend still reference them; links are relative to this folder.

### Where things are

- **The code:** the folder above this one (`web/`, `src/`, `docs/`, `test/`). It runs straight from these files: there is no build.
- **The data:** `~/.pi-pocket/`, or `PI_POCKET_DIR` (the launcher shows it as **Data**). `config.json` holds people, roles, tokens, invites, and settings; `pocket.sqlite` holds every session; `extensions/` holds the owner's drop-in extensions. Change data through the app, never by editing these files: the server keeps them in memory and writes over them. The one exception is `extensions/`, where drop-ins go ([extensions.md](extensions.md)).
- **Pi's own files:** `~/.pi/agent/` (sign-ins, models, settings, `AGENTS.md`, skills, prompt templates). Pi Pocket uses them as Pi does.

### Pick the lightest change

Each step reaches further than the one before it, and asks more care. Use the first that does the job.

| To change                                                          | Use                                                                         | Read                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------- |
| How Pi works in one session                                        | The session's instructions (Menu → Instructions for Pi)                     | [customizing.md](customizing.md)   |
| How Pi works in a project, or everywhere                           | An `AGENTS.md` in the project, or Pi's own in `~/.pi/agent/`                | [customizing.md](customizing.md)   |
| A procedure Pi should follow on request                            | A skill, or a prompt template: both become slash commands                   | [customizing.md](customizing.md)   |
| What Pi can do: a new tool, a rule in its prompt, a check on calls | A drop-in extension in `~/.pi-pocket/extensions/`, which the owner turns on | [extensions.md](extensions.md)     |
| Pi Pocket itself: its screens, its server, a built-in extension    | Its code, while it runs                                                     | [self-editing.md](self-editing.md) |

A drop-in extension survives updates to Pi Pocket and can be turned off from the app; a change to Pi Pocket's code is shared by everyone who uses this copy and can break it for all of them.

### The inherited documents

- [customizing.md](customizing.md): changing how Pi works without code.
- [extensions.md](extensions.md): writing extensions (tools, prompt sections, hooks), with working examples in [examples/](examples/).
- [self-editing.md](self-editing.md): changing Pi Pocket's code while it runs, checking the change, and getting a broken one back.
- [map.md](map.md): where each part of the code is, and how to add the common things.
- [architecture.md](architecture.md): how the parts depend on each other, and the orderings they rely on.
- [features.md](features.md): what each feature does, as people use it.
- [../SECURITY.md](../SECURITY.md): what Pi Pocket protects, and what it does not.

### Before you change anything

- **Ask first.** A change to Pi Pocket reaches everyone who uses it, at once. Say what you will change and why, and wait for a yes, unless you were asked for exactly that.
- **Do not test on the live data.** Check a change on a copy of Pi Pocket with its own data folder ([self-editing.md](self-editing.md#check-it-on-a-copy)), not with the server people are using.
- **Do not restart while your own tool call runs**, and do not restart without asking. Tell the person to use Settings → Restart server.
- **Do not commit, push, or publish** unless asked.
