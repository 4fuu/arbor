# Release process

A release is run by hand, usually by an agent asked to "release arbor". No
workflow publishes; `ci.yml` only checks every push to `main` and every pull
request.

## Versions

arbor versions use a calendar version in the form `YYYY.MDD.REVISION`, using
the date in `Asia/Hong_Kong`. The month is not padded, the day is two digits,
and the first release of a day uses revision zero. For example, `2026.1106.0`
is the first release on 2026-11-06, and `2026.1106.1` is the second that day.

Every package is published at the same version, so one version is set across
all of them and one tag marks all of them.

## Before you start

- Work on a clean checkout of `main`, up to date with `origin/main`, and
  confirm the latest CI run on it passed (`gh run list --branch main -L 1`).
- To stage rather than publish (below), npm CLI 11.15.0 or newer, which has
  `npm stage`. Where the installed one is older, run a newer one without
  touching the system:
  `npm install --prefix /tmp/npm-cli npm@latest` and put
  `/tmp/npm-cli/node_modules/.bin` first on `PATH`.
- A token that can publish under the `4fu` organization, or a stage-only one
  ("Read and write (stage only)") to stage. In an environment that holds it as `NPM_TOKEN`, point npm
  at a private config that names the variable, never its value:

  ```bash
  printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > /tmp/arbor-npmrc
  export NPM_CONFIG_USERCONFIG=/tmp/arbor-npmrc
  npm whoami          # must answer an account that can publish under @4fu
  ```

  The single quotes keep `${NPM_TOKEN}` literal; npm expands it when it reads
  the file. Delete `/tmp/arbor-npmrc` when the release is done.
- Pick the version: today's date in `Asia/Hong_Kong`
  (`TZ=Asia/Hong_Kong date +%Y.%-m%d`), then the next revision not already on
  the registry (`npm view @4fu/arbor-core versions`).

## Release

```bash
node scripts/set-version.mjs 2026.1106.0
pnpm install --frozen-lockfile
pnpm check                        # typecheck and test every package, on the sources
pnpm build                        # emit dist for every package
node scripts/publish.mjs          # dry run: what each tarball would contain
node scripts/publish.mjs --publish
```

`scripts/set-version.mjs` writes the version into every `package.json`,
including the repository's own root, and checks its form. The workspace links
in `pnpm-lock.yaml` carry no version, so nothing else changes.
`scripts/publish.mjs --publish` refuses a version that does not carry today's
date in `Asia/Hong_Kong`, then publishes each package in turn.

With a stage-only token, run `node scripts/publish.mjs --stage` instead: it
stages each package with `npm stage publish`, and nothing is installable yet.
List the stages with `npm stage list @4fu/arbor-<name>` and hand them to the
owner, who approves each one with 2FA, on npmjs.com (Staged Packages) or with
`npm stage approve <stage-id>`. Approve all of them: the packages name each
other at the exact release version, so a partial approval does not install.

Once every package is live, record the release in Git:

```bash
git commit -am "Release 2026.1106.0"
git tag v2026.1106.0
git push origin main v2026.1106.0
```

If a publish or a stage stops partway, the packages before it are already on
the registry, and a version, published or staged, can never be reused. Fix
the cause, then publish (or stage) each remaining package from its `dist`
with `npm publish --access public` (or `npm stage publish`); running the
script again stops at the first package already there. Check the result with
`npm view @4fu/arbor-<name> version` for every package.

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
  unchanged;
- the repository's `README.md` (or the package's own) and `LICENSE` are copied
  in.

The root package stays private and is never published. Every published package
is public under the `@4fu` scope, which is why each carries
`publishConfig.access`.

## Notes

- **No provenance.** A provenance attestation needs a supported CI runner, so
  a release run by hand publishes without one.
- **The optional peer.** `@4fu/arbor-journal-sqlite` takes
  `@4fu/arbor-segmenter-jieba` as an optional peer: installed, the journal's
  word index uses jieba's segmentation; absent, it falls back to a
  per-character approximation and nothing else changes
  ([journal.md](journal.md#search)).
- **Nothing is published from a working tree that has not been built.** The
  publish step packs whatever `dist` holds, so `pnpm build` runs first and the
  entry points are checked before anything is packed.
