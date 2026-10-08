# Releasing

Releases are published by `.github/workflows/release.yml` when a tag `v<version>` is pushed.
Pre-releases (`a`, `b`, `rc`, e.g. `v0.2.0rc1`) go to TestPyPI; final releases go to PyPI and get a GitHub release.
Publishing uses PyPI Trusted Publishing, so no API token is stored anywhere.

## One-time setup

1. Create the GitHub repository `epicodic/agentprof` and push `main`.
2. In the repository settings, create two environments: `testpypi` and `pypi`; for `pypi`, add yourself as required reviewer if releases should wait for approval.
3. On TestPyPI (test.pypi.org → Your account → Publishing), add a pending publisher: project `agentprof`, owner `epicodic`, repository `agentprof`, workflow `release.yml`, environment `testpypi`.
4. On PyPI (pypi.org → Your account → Publishing), add the same pending publisher with environment `pypi`.

## Each release

1. Make sure CI on `main` is green.
2. Bump the version: `uv version --bump patch` (or `minor`, `major`; for a release candidate e.g. `uv version 0.2.0rc1`).
3. Commit: `git commit -am "release: v$(uv version --short)"`.
4. Tag and push: `git tag "v$(uv version --short)" && git push origin main --tags`.
5. Watch the release workflow; approve the `pypi` environment if required.
6. Try a pre-release with `uvx --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ agentprof==<version>`.

The workflow refuses to publish if the tag does not match the version in `pyproject.toml`.
