# Releasing

Releases are published by `.github/workflows/publish.yml` when a tag `v<version>` is pushed.
The workflow runs CI, checks the tag against the version in `pyproject.toml`, publishes the CI-built distributions to PyPI and creates a GitHub release with them.
Publishing uses PyPI Trusted Publishing, so no API token is stored anywhere.

## One-time setup

1. Create the GitHub repository `epicodic/agentprof` and push `main`.
2. Optionally, in the repository settings, create the environment `pypi` and add yourself as required reviewer if releases should wait for approval; otherwise GitHub creates it on the first release.
3. On PyPI (pypi.org → Your account → Publishing), add a pending publisher: project `agentprof`, owner `epicodic`, repository `agentprof`, workflow `publish.yml`, environment `pypi`.

## Each release

1. Make sure CI on `main` is green.
2. Bump the version: `uv version --bump patch` (or `minor`, `major`).
3. Commit: `git commit -am "release: v$(uv version --short)"`.
4. Tag and push: `git tag "v$(uv version --short)" && git push origin main --tags`.
5. Watch the publish workflow; approve the `pypi` environment if required.
6. Check the release with `uvx agentprof@<version>`.

The workflow refuses to publish if the tag does not match the version in `pyproject.toml`.
A version uploaded to PyPI can never be uploaded again, even after deleting it.
