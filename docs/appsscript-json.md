# appsscript.json — deployment-shape note

`appsscript.json` has a single `webapp` block. Its `executeAs` and
`access` values describe the **default settings for a new deployment**;
they do **not** pin all existing deployments to the same shape.

The project publishes **two** deployments (see
[`docs/deployments.md`](deployments.md)):

- **Public**  — `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`
- **Secure**  — `executeAs: USER_ACCESSING`, `access: ANYONE`

The manifest is currently set to the **public** shape (matches most
common "Deploy → New deployment" starting point). The **secure**
deployment overrides both settings at the time it was cut via the
`Deploy → Manage deployments` UI. Both deployments share the same
`oauthScopes` list, however — that IS pinned by the manifest, so both
deployments always request the same permissions after `clasp push` +
a version bump.

## Verifying which deployment is which

Open each `.../exec` URL in an incognito window with `?diag=deployment`
appended. See [`README.md`](../README.md#verifying-the-deployments) for
the expected output.

## Changing scopes

If you add or upgrade a scope in `appsscript.json`:

1. `clasp push -f`
2. Open the editor, run **`checkOAuthScopes`** — expect the new scope to
   appear as `missing`.
3. Run any function that uses the new scope (typically
   **`syncRoleAccessNow`**) — Google shows a fresh consent dialog; accept
   it.
4. Re-run `checkOAuthScopes` — expect `ok: true`.
5. **Deploy → Manage deployments → New version** on **both** deployments
   so their `AKfycbz…` URLs pick up the refreshed grant.
