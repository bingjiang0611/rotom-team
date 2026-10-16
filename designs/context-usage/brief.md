# /context terminal alignment

## D-context-usage · project requirement confirmed; visual acceptance pending

User request: “优化下/context的体验 和终端ui对齐”, with the current Web sheet and terminal Context Usage screenshots.
Scope: local repair of `web/sheets/native-command.js`, `web/context-usage.js` and `web/style.css`.

- Preserve the Team palette, monospace typography, native measurement, private text boundary and read-only command admission. Do not add inference, raw prompt previews or a TUI transport.
- Terminal map → replace the accent-only strip with a colored 16×16 map. Match largest-category overlap and mixed/buffer/free cell allocation against pinned `pi-context-view/src/ui/usage-map.ts`.
- Terminal legend → show category swatches, aligned token counts and window percentages; retain one-decimal k/M precision. Open Tool Output's per-tool breakdown by default; other source breakdowns remain expandable with native HTML details.
- Terminal buffer/free rows → cap the buffer at remaining context space and place its map cells at the window end, not immediately after used cells. Unknown window/percentages remain unknown, not zero.
- Keep desktop map/legend side by side; stack them on phones. Reduce the oversized three-metric header to model plus occupancy. Keep one compact estimate/not-billing footer.

Reference: the user's original terminal screenshot and pinned rotom 0.1.25 `usage-map.ts`, `usage-view.ts`, `config.ts`.
Project/personal library searches found no reusable context component; old-machine stale entries were not imported.
Craft applied: [tabular numbers](https://craft.gustavofior.com/tabular-numbers) keep token and percentage columns aligned; existing theme tokens and immediate focus/hover feedback remain in use. No new global visual preference is inferred.

Verification: `test/native-context.test.ts` compares 138 distributions × 3 geometries against actual native source, plus number formatting, buffer/free and unknown cases. A mutated threshold is a negative control. `test/native-commands-ui-proof.ts` exercises the production sheet with actual pre-request data and synthetic high occupancy, mouse/Enter/Space, desktop/390px/320px, light theme, empty/unknown windows and no additional inference. Generated screenshots stay in the proof's printed temporary directory, not Git. See `docs/VERIFICATION.md` for the current scope.

Boundary: colors follow the active Web palette, not arbitrary terminal custom colors. Native Fit zoom, configurable map geometry and raw-content previews are not ported. Chromium emulation is not physical-device acceptance. User visual acceptance remains pending.

Next use: when updating the runtime pin or context sheet, rerun native-source parity and inspect desktop plus phone rendering; do not replace the map with an undifferentiated progress bar.
