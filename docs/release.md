# Release process

arbor versions use a calendar version in the form `YYYY.MDD.REVISION`, using
the date in `Asia/Hong_Kong`. The month is not padded, the day is two digits,
and the first release of a day uses revision zero. For example, `2026.1106.0`
is the first release on 2026-11-06.

Every package is published at the same version, so one version is set across
all of them and one tag releases all of them.

## Prepare a release

On `main`, set the version and run the full verification path:

```bash
node scripts/set-version.mjs 2026.1106.0
pnpm check      # typecheck and test every package, on the sources
pnpm build      # emit dist for every package
node scripts/publish.mjs   # what each tarball would contain
```

`scripts/set-version.mjs` writes the version into every `package.json`,
including the repository's own root. The workspace links in
`pnpm-lock.yaml` carry no version, so nothing else changes and
`pnpm install --frozen-lockfile` stays valid.

Then push the tag. The release workflow is what checks the version against the
date, so a version set for a later day is refused rather than published:

```bash
git tag v2026.1106.0
git push origin v2026.1106.0
```

## What the workflow does

`release.yml` runs on a `v<version>` tag, and on `workflow_dispatch` from
`main` to resume the release its tag names:

1. **validate.** The version comes from the tag. It must match
   `YYYY.MDD.REVISION`, it must match today's date in `Asia/Hong_Kong`, and
   every package must carry exactly it. A re-run from `main` is only accepted
   when the tag `v<version>` points at the commit being built.
2. **verify.** A clean checkout installs with `--frozen-lockfile` and runs
   `pnpm typecheck` and `pnpm test`.
3. **publish.** The same checkout builds, packs every package as a dry run, and
   then publishes each one with `npm publish --provenance`. The workflow holds
   `id-token: write` for the provenance attestation and reads the registry
   token from the `NPM_TOKEN` repository secret, which it writes into npm's own
   configuration without ever printing it.

`ci.yml` runs the same install, typecheck, test, build and pack steps on every
push to `main` and every pull request, so a broken release is caught before a
tag exists.

## How a package is published

The repository's `package.json` files point their `exports` at the TypeScript
sources, because that is what development runs. A published package cannot do
that - Node refuses to strip types inside `node_modules` - so
`scripts/publish.mjs` writes a manifest of its own into each package's `dist`
and packs or publishes from there:

- `exports`, `types` and `main` are rewritten to `dist`-relative paths;
- a `workspace:*` dependency or peer becomes the release version, so a
  release's packages always name each other exactly;
- `private`, `scripts` and `devDependencies` are dropped, because they mean
  nothing outside the repository;
- `license`, `repository`, `engines`, `description` and
  `publishConfig.access` are carried over from the package's own manifest
  unchanged.

The root package stays private and is never published. Every published package
is public under the `@4fu` scope, which is why each carries
`publishConfig.access`.

## Notes

- **Provenance needs a public repository.** npm builds the attestation against
  the public repository, so the first release has to land after the repository
  is public.
- **The optional peer.** `@4fu/arbor-journal-sqlite` takes
  `@4fu/arbor-segmenter-jieba` as an optional peer: installed, the journal's
  word index uses jieba's segmentation; absent, it falls back to a
  per-character approximation and nothing else changes
  ([journal.md](journal.md#search)).
- **Nothing is published from a working tree that has not been built.** The
  publish step packs whatever `dist` holds, so `pnpm build` runs first and the
  entry points are checked before anything is packed.
