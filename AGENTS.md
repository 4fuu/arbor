# arbor

## Commands

```sh
pnpm check     # typecheck and test every package, on the sources; the gate
pnpm build     # emit dist for every package, for publishing
pnpm pack      # what each published tarball would contain
```

Node runs the TypeScript sources directly and every package's `exports` points
at them, so `pnpm check` needs no build and there is no `dist` in the way of
the work. `dist` exists for publishing alone: Node refuses to strip types
inside `node_modules`, so a published package ships built JavaScript and
declarations instead of the sources. `docs/release.md` is the process.

## Conventions

- TypeScript, strict, `erasableSyntaxOnly`: no `enum`, no `namespace`, no
  parameter properties, no decorators. Node strips the types itself.
- `verbatimModuleSyntax`: `import type` for types, and every relative import
  carries its `.ts` extension.
- Internal packages resolve to their sources through each `package.json`
  `exports`, so a change in one package is seen by the others without a build.
- Tests are `node:test` files next to the code, named `*.test.ts`. Test the
  contract through the public interface, not private helpers.
- All code, comments, commits and documents are in English. No emoji. No
  secrets: a configuration names a secret and never holds its value.

## Layers

`packages/interfaces` holds every replaceable interface and the core's own
shapes; it is types only. `packages/errors` holds the error shape every refusal
uses. Everything else is a default implementation of an interface.

No pi type or SQL row crosses an interface. Errors name the rule
that refused the call and the next action.

## Layout of the design

`docs/` is the specification. When the code and the spec disagree, fix both in
the same change.
