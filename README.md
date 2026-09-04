# Work Item Group Approval

An Azure DevOps work item form control that lets a representative record approval on behalf of a
named group ("IT", "QA", "Business", ...). The control captures the identity of the person who
clicked it. Once set, only that person or a project administrator can reset it.

## Button states

| State | Button | Status color | Caption |
| --- | --- | --- | --- |
| Nothing recorded | `Approve for <Group name>` (enabled) | error red | none |
| Just approved, not yet saved | `<Group name> : Pending` (enabled) | warning amber | *Save the work item to record your approval* |
| Recorded, viewed by the approver or a project admin | `Reset Approval` (enabled) | info blue | `<user> for <Group name> on <date>` |
| Recorded, viewed by anyone else | `<approver's name>` (disabled) | success light green | `Approved for <Group name> on <date>` |
| Read-only form or still loading | current label (disabled) | platform grey, or success if recorded | caption if recorded |

Label and color both derive from one `ApprovalState` value (`approvalState` in
`ApprovalButton.tsx`), so they cannot disagree.

The approver's name appears in exactly one place per state: on the button where the button is
showing status, and in the caption where the button is showing an action. `on <date>` is omitted
when no **Approved on** field is configured, so the phrase still reads.

Because a display name can be arbitrarily long and the control only gets the width of one form
column, that button grows to fit the name, stops at the column edge, then ellipsizes. There is no
hover tooltip: the iframe is sized to the control's content, so a tooltip would be clipped at its
edge. Screen readers get the full sentence — "Approved by … for … on …" — via `ariaLabel`, since a
button labelled only with a person's name says nothing about what it is for. A sighted user seeing
a truncated name can still read it from the identity field itself or the work item history.

### Colors

Every color comes from the platform's SASS variables in
`azure-devops-ui/Core/_platformCommon.scss` — there are no hard-coded values in
`ApprovalControl.scss`. Those variables resolve to CSS custom properties with no baked-in
fallback, so they rely on `SDK.init({ applyTheme: true })` publishing the host theme into the
iframe, which `ApprovalControl.tsx` does before rendering. Light, dark and high-contrast themes are
therefore all inherited rather than reimplemented.

- **error** and **info** use the `Button` component's own `danger` and `primary` props rather than
  CSS, so they inherit the design system's hover, active, focus, disabled and high-contrast
  handling. ADO's `--status-info-foreground` and `--communication-background` are both
  `rgba(0, 120, 212, 1)`, so `primary` *is* the info blue.
- **warning** and **success** have no equivalent `Button` variant, so they are styled from
  `$status-warning-*` / `$status-success-*` following the platform's MessageBar pattern for status
  surfaces: the status tint is the background, the label stays `$primary-text`, and the status
  color becomes the border. Putting `$status-warning-text` on `$status-warning-background` only
  reaches 4.10:1 — that variable is meant for warning text against the *page* background — so the
  label would have failed AA. With `$primary-text` both tinted states clear 15:1, and the borders
  sit above the 3:1 that non-text contrast requires.
- `--status-info-background`, `--status-success-text` and `--status-warning-foreground` are declared
  in `_platformCommon.scss` but referenced nowhere in the shipped CSS, so they are not reliably
  themed. They are avoided.
- **The platform's SASS variables carry no inline fallback.** `$status-warning-background` expands
  to a bare `var(--status-warning-background)`, so if the host does not publish it the declaration
  is invalid at computed-value time and the property reverts to its initial value — a transparent
  button rather than a tint, with nothing logged. azure-devops-ui guards its own rules by writing
  `var(--palette-error, rgba(232, 17, 35, 1))`, which is why the `danger` and `primary` buttons
  render even outside a themed host. `ApprovalControl.scss` therefore declares light-theme defaults
  in a `:root` block. `SDK.applyTheme()` appends its own `:root` block to `<head>` at runtime, after
  style-loader has injected the stylesheet, so anything the host publishes still wins on equal
  specificity — the defaults only fill gaps, and they double as the palette for `npm run preview`.
  `npm run check:theme` fails the build if a rule reads a variable that neither the `:root` block
  nor an inline fallback covers.
- **`unsaved` is amber, not green.** Until the work item is saved nothing is recorded, so the state
  is closer to "not approved" than to "approved". `unsaved` also outranks `reset` when both apply,
  because the unsaved warning is the more important thing to tell the user. Clicking `Pending`
  clears the unsaved approval, which is the only useful action there.
- **A disabled `pending`/`unsaved`/`reset` button drops to the platform's grey**, since a colored
  button that cannot be clicked reads as a broken action. `approved` keeps its tint while disabled,
  because there the color is a status rather than an invitation.

### Layout: labels and width

**Spacing.** Stacked controls are separate iframes, so the gap between two buttons has to come from
inside one of them. Each control carries a 2px bottom padding (`$stack-gap`), which shows up as 2px
between it and the next one down. Nothing is added above, so a control with no label still starts
flush at the top of its cell. Keep the value small if you change it: it is paid once per control in
the stack.

**Label.** Use the form layout's own **Label** field (not a control input) to add a heading such as
`Approvers` above the first control of a stack. Leave it blank on subsequent controls so they sit
tight beneath the first. The platform's `.bolt-formitem-label` puts `$spacing-8` below itself, which
is the same gap the control previously provided through its own label element — switching to the
built-in label preserves the spacing without duplicating it.

**Width.** There is no way for two of these controls to agree on a width directly: each custom
control is a separate iframe, so there is no shared layout context and no platform API for it.
Instead each button is sized off its column, which resolves to the same value for every control
in that column:

```scss
width: min(75%, 300px);
```

`width` (not `min-width`) is used deliberately: a `min-width` would let buttons with longer labels
grow beyond 75%, causing controls in the same stack to disagree on width. A fixed `width` means
every button is exactly the same computed size regardless of its label text, and the `min()` cap
keeps buttons from growing oversized in very wide columns. Labels that overflow ellipsize — the
wrapper's `align-items: flex-start` ensures the button does not stretch to fill the column, and
`.bolt-button-text` has `overflow: hidden; text-overflow: ellipsis` to handle the clip gracefully.

Run `npm run preview` to see all five states in a browser without installing the extension.

## Prerequisites: process fields

The control stores its value in real work item fields so approvals are queryable in WIQL, boards,
and Analytics, and appear in work item history. Create these per group in your **inherited process**:

| Field | Type | Example |
| --- | --- | --- |
| Approver | Identity | `Custom.ITApprover` |
| Approved on (optional) | Date/Time | `Custom.ITApprovedOn` |

Add the fields to each work item type that needs them. Field definitions are shared across work
item types, so three groups means three (or six, with dates) fields total, not per type.

## Install and configure

1. Set `publisher` in `vss-extension.json` to your Marketplace publisher id.
2. `npm install && npm run package` — produces a `.vsix` in `dist/`.
3. Upload the `.vsix` to the Marketplace as **private** and share it with your organization, then
   install it into the organization.
4. In **Project settings → Process → \<your process\> → \<work item type\> → Layout**, choose
   **Add custom control**, pick **Group Approval**, and set:

| Input | Required | Description |
| --- | --- | --- |
| Group name | Yes | Label shown on the button, e.g. `IT` → "Approve for IT". |
| Approver field | Yes | Identity field that records who approved, e.g. `Custom.ITApprover`. |
| Approved on field | No | Date/Time field that records when approval was given, e.g. `Custom.ITApprovedOn`. |
| Approver team | No | Name of an ADO team (Project Settings → Teams) whose members may approve. Absent = anyone. |
| Admin team | No | Name of an ADO team whose members may reset any approval. Absent = original approver only. |
| Visibility field | No | Reference name of a field that gates visibility of the button, e.g. `Custom.ReleaseType`. Absent = always visible. |
| Visibility value | No | Value the visibility field must equal for the button to appear, e.g. `Emergency`. Case-insensitive. |

   In the layout editor's own **Label** field, set a heading (e.g. `Approvers`) on the *first* control of a stack only; leave it blank on subsequent controls.

5. Repeat step 4 once per group. Each control instance is independent.

### Conditional visibility example

A common pattern is to show an approval button only for a subset of work items. For example, to require emergency-release sign-off only when `Custom.ReleaseType` equals `Emergency`:

- **Visibility field:** `Custom.ReleaseType`
- **Visibility value:** `Emergency`

The button appears and disappears reactively as the field is edited — no save required. When the field does not match, the control renders nothing and the iframe collapses to zero height, so there is no blank space on the form.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Production webpack build into `dist/` |
| `npm run build:dev` | Development build with readable output |
| `npm run package` | Build, then create the `.vsix` |
| `npm run package:dev` | Package with `configs/dev.json` overrides (separate extension id, so it can be installed alongside production) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Builds `preview/index.html`, a standalone page showing every button state for reviewing colors without installing the extension |
| `npm run check:fonts` | Fails if a font was emitted that `vss-extension.json` does not declare |
| `npm run check:theme` | Fails if a rule reads a theme variable with no fallback and no `:root` default |
| `npm run check` | Typecheck plus both guards |

## How enforcement works, and its limits

The "only the approver or an admin-team member may reset" rule is enforced in the control's UI:

- The approver is matched on identity GUID (falling back to unique name) against
  `SDK.getUser()`.
- Admin-team membership is checked via `CoreRestClient.getTeams(mine: true)`, which returns the
  teams the current user belongs to in the project. The check fails closed — if the API call
  errors, the user is treated as a non-admin. Results are cached for the lifetime of the iframe.

> **Note on security groups.** The team membership check covers ADO Teams (visible in Project
> Settings → Teams) but not arbitrary security groups such as "Project Administrators". This is
> because the Graph API that exposes security group membership lives on `vssps.dev.azure.com`,
> which blocks cross-origin requests from extension iframes. To grant reset rights to admins,
> create a dedicated ADO team (e.g. `Release Admins`) and set it as the **Admin team** input.

**This is not a server-side guarantee.** Azure DevOps has no work item rule that expresses "only
the identity currently in this field may clear it," so the underlying field remains writable by
anyone with edit permission via the REST API, Excel, or bulk edit. Every such change is recorded in
the work item's history, which is the audit trail. If tamper-evidence matters, add the approval
fields to a dashboard query or a service hook alert so unexpected clears are visible.

Making the rule truly unbypassable requires a service hook subscription on `workitem.updated`
backed by a hosted function that reverts unauthorized changes. That was deliberately left out of
scope.

## Scopes requested

| Scope | Why |
| --- | --- |
| `vso.work_write` | Read and write the approval fields on the work item form |
| `vso.project` | Read the current user's ADO team memberships to enforce approver and admin team restrictions |

## Notes

- The **Approver field** picker filters on `["String", "Identity"]`. Azure DevOps models identity
  fields as string fields with an identity flag, so restricting to `Identity` alone can hide them;
  the cost is that ordinary string fields also appear in the list. Pick the identity field you
  created.

- The **Visibility field** picker accepts `String`, `PlainText`, `Integer`, `Double`, `Boolean`,
  and `Guid` field types, which covers picklist fields. The **Visibility value** is a free-text
  input; the comparison at runtime is case-insensitive. Picklist values do not need to be typed
  in any particular case.

- The **Approver team** and **Admin team** inputs match against ADO Team names exactly as they
  appear in Project Settings → Teams. The comparison is case-insensitive but the name must
  otherwise be exact (no partial matches).

### Styling and sizing

The control imports `azure-devops-ui/Core/override.css` and `core.css`. `override.css` is what
applies the Segoe UI stack and the 14px body size — without it the control inherits the iframe's
user-agent serif font and looks nothing like the rest of the form.

`override.css` also sets `height: 100%` on `html` and `body`, which would peg the document to the
iframe's height and make the content unmeasurable. `ApprovalControl.scss` resets that to
`height: auto` and hides overflow, and `autoResize.ts` observes the root element and calls
`SDK.resize()` so the host iframe tracks the content. The `height` in the contribution manifest is
only the initial value; the control grows when the approval caption appears and again when the
unsaved-changes hint is added. Without the resize the iframe keeps its original height and the extra
content becomes an inner scrollbar.

### Icon fonts and content types

`azure-devops-ui` pulls in ~1.4 MB of Fluent icon fonts. They are emitted as separate files rather
than inlined as base64, so they are never fetched by this control (it renders no icons) and each
control instance's iframe does not carry the payload.

`tfx` only applies a `contentType` to an individually named file entry — a `contentType` on a
directory entry is ignored, because it is matched against a real file path
(`tfx-cli/_build/exec/extension/_lib/manifest.js`). So each font is named in `vss-extension.json`
with its MIME type, and webpack strips the embedded version from the emitted filename
(`fluent-regular-v1.1.293.woff2` → `fluent-regular.woff2`) so those entries survive an
`azure-devops-ui` upgrade. `npm run check:fonts` runs as part of `package` and fails the build if a
font is emitted that the manifest does not declare.
