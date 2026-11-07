# Releasing

A release is a git tag `vMAJOR.MINOR.PATCH` pushed to GitHub. The `release` workflow (`.github/workflows/release.yml`) does the rest. Nothing is published to a package registry.

## Cut a release

1. On `main` with a green CI, set the new version and commit it:

   ```sh
   scripts/node.sh "npm version 0.2.0 --no-git-tag-version"   # updates package.json and package-lock.json
   git commit -am "Release 0.2.0"
   ```

2. Add the section of the release to `CHANGELOG.md` in the same commit, then tag and push:

   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main v0.2.0
   ```

The workflow stops before building anything unless the tag is exactly `v` plus the version in `package.json` (`scripts/check-release-tag.sh`) and the tagged commit is in the history of the default branch. The `verify` job then repeats CI (release script tests, typecheck, every test including the PostgreSQL ones against the digest-pinned service, build). The `release` job builds, runs `npm pack` (the `files` list: `dist` and `migrations`), writes `SHA256SUMS`, creates a build-provenance attestation and creates the GitHub release with `GITHUB_TOKEN`. The notes are the subjects of the commits since the previous tag (`scripts/release-notes.sh`). A tag with a `-` in it is a pre-release. Running the workflow by hand builds the files and keeps them for seven days as a workflow artifact; it never creates a release.

## Verify a download

```sh
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify FILE --repo kienpt91/stripe-connect-marketplace-core
```

The checksum shows the file is the one listed; the attestation shows which workflow and commit built it. Do both. (Attestations need a public repository.)

## Publishing to a registry later

Not wired, on purpose: it needs a long-lived secret and a decision about the name. To publish to npm, create a token limited to this package, store it as a repository secret, and add a job that `needs: release`, runs in an environment that requires approval, has only `contents: read` and `id-token: write`, and runs `npm publish --provenance --access public`. Pin any action you add to a full commit SHA.

## Before the first real use

The release workflow has not been run on GitHub yet (it is modelled on workflows that have). Run it once with `workflow_dispatch` and read the log before tagging anything.
