# Native question card / 2026-10-13

Scope: local repair of the question above the composer (`web/native.js`, `web/style.css`).
User request: optimize the screenshot's question UI. Acceptance remains pending.

## Preserve and change

- Keep the current theme, typography, square controls, click-to-answer behavior and payer-only permission.
- Keep select, confirm, input/editor and cancel payloads unchanged. Do not render RPC text as HTML.
- Fix long options overflowing the card: full-width stacked buttons, wrapping labels and descriptions.
- Separate the existing RPC number, label and description for scanning. Unformatted dialogs remain readable.
- Keep keyboard focus visible and touch targets at least 44 CSS px. Test 390px and desktop widths.
- This does not introduce native multi-select/preview capabilities; the pinned RPC fallback still uses text input
  for multi-select and folds previews into the question text.

## Research and reuse

- Project source: `Question` and `.native-question`; the generic `.button` has `white-space: nowrap`, while the option
  container wraps whole buttons. This creates the reported overflow. Repair only the question's local styles.
- External: https://www.radix-ui.com/themes/docs/components/radio-cards (original page inspected in Chrome).
  Adopt label/description hierarchy and a full-row target. Reject radio-selection state and an extra confirmation:
  this product answers immediately. No Radix dependency or source imported.
- Personal library searches: rotom / 选择 / question, no reusable match; existing library has stale old-machine paths.
- Craft: hover restraint and optical alignment. Keep local hover/focus immediate, number/content/arrow aligned;
  preserve theme tokens and square nested surfaces. Other changes are ordinary layout/readability judgement.

## Verification

Use the actual production component and stylesheet in an isolated specimen, not duplicated mock markup.
Check long Chinese/English, unbroken paths, generic options, payer/viewer, input/editor, confirm and cancellation.
Browser tests must assert containment, stacked rows, target heights and exact posted option text.
Run the existing native end-to-end UI proof with the synthetic model; no real provider requests.

## Sidebar attention and Fork / 2026-10-13

- A native dialog now marks the paying member's session as `Needs answer` in the open sidebar and `?` in the folded
  rail. It replaces the working animation while the answer is pending, then restores normal running state after the
  answer. Other members keep the ordinary working state because they cannot answer that account's dialog.
- The marker uses color, a `?` shape, visible text and an accessible name. This follows W3C WCAG 2.2 SC 1.4.1's
  guidance to convey meaning with shape or text in addition to color:
  https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html (original page inspected in Chrome).
- Fork appeared clickable while a run was active, but the HTML button was disabled and the server correctly rejects
  a fork from an active or unknown source. Keep that safety boundary. Remove hover/press affordance from disabled menu
  rows and replace the generic subtitle with the concrete reason: wait/stop, reconcile unknown, or initialize first.
- Preserve existing theme tokens and session layout. Do not add a new notification system or persist dialog state.

## Next use

For a long native selection dialog, override generic button nowrap locally, separate RPC label/description only
when its known numbered format matches, and verify exact payload round-trip plus narrow viewport containment.
When the dialog needs the paying member, publish that live state to their session-list projection and show a text/shape
cue instead of a working animation. The repair is project-scoped, not a global font or card-style preference.
