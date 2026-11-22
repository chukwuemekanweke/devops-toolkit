# Application-owned image configuration

## Purpose and ownership

Each consuming application repository declares its deployable images in a version-controlled file, normally `.github/docker-images.json`. The application owns component names, image repositories, Dockerfiles, build contexts, and non-secret build configuration. The toolkit owns validation, Buildx orchestration, registry login, tagging, digest collection, and release-manifest generation.

This static configuration answers what can be built. It is not a release manifest and contains no published digest, environment selection, runtime configuration, or secret value.

Callers pass only the file location and release identity:

```yaml
with:
  deployment-id: ${{ github.sha }}
  image-config-path: .github/docker-images.json
```

The publishing workflow checks out the calling repository. `actions/checkout` in the called workflow therefore reads application-owned configuration and Dockerfiles from the caller commit, not from the toolkit repository.

## Schema version 1

The machine-readable schema is [docker-images.schema.json](schemas/docker-images.schema.json). The initial shape is intentionally small:

```json
{
  "schemaVersion": 1,
  "images": [
    {
      "component": "webapi",
      "image": "docker.io/example/backend-webapi",
      "dockerfile": "src/Example.WebAPI/Dockerfile",
      "context": ".",
      "buildArgs": {
        "PUBLIC_BUILD_MODE": "release"
      }
    }
  ]
}
```

| Field | Required | Contract |
| --- | --- | --- |
| `schemaVersion` | yes | Integer `1` for this contract |
| `images` | yes | Nonempty array, currently limited to 100 definitions |
| `component` | yes | Unique stable logical ID matching `^[a-z0-9][a-z0-9._-]*$` |
| `image` | yes | Fully qualified Docker Hub repository, such as `docker.io/namespace/name`; no tag or digest |
| `dockerfile` | yes | Repository-relative path to an existing regular file inside the checkout |
| `context` | no | Repository-relative existing directory; defaults to `.` |
| `buildArgs` | no | String-to-string map for non-secret public build settings only |

`buildArgs` exists for legitimate compile-time settings such as a public build mode or `NEXT_PUBLIC_*` value. It must never carry credentials, tokens, private URLs containing credentials, or server-only secrets. `target`, per-image secret lists, arbitrary build commands, tags, and registry credentials are deliberately excluded until an actual consumer requirement justifies them. Target platforms, caching, scanning, SBOM, and provenance are publishing workflow policy rather than repeated image-definition fields.

## Validation

Before registry authentication or a build starts, the publishing workflow must:

1. Resolve `image-config-path` from the repository root and reject an absolute path, NUL, `..` traversal, or symlink escape.
2. Reject a missing file, a file larger than 256 KiB, malformed JSON, duplicate JSON properties, unknown top-level/image fields, unsupported `schemaVersion`, or an empty/oversized `images` array.
3. Require unique valid component identifiers.
4. Require a normalized Docker Hub repository without a tag, digest, whitespace, shell metacharacters, or a registry host inconsistent with the selected registry.
5. Canonicalize every Dockerfile and context path, reject traversal/symlink escape, and verify the Dockerfile is a regular file inside its existing context/check-out boundary.
6. Reject secret-looking build-argument keys and values. Values are passed as discrete Buildx inputs, never evaluated as shell.
7. Produce a validated normalized representation for the build matrix. Defaults are applied there rather than rewriting the caller's file.

Validation errors fail the workflow before login and identify the component and field without printing secret contexts.

After validation, the workflow emits a deterministic internal matrix with one entry per configured image. `context` defaults to `.`, build-argument keys are sorted, and package-auth selection is attached as internal metadata. The normalized file is uploaded only as run-internal aggregation evidence; it does not change the caller's committed file.

## Build credential boundary

Secret values never appear in this file. Docker Hub credentials authenticate publishing globally. The initial private-package contract uses optional reusable-workflow secrets `github-packages-username` and `github-packages-token`, plus the non-secret `package-auth-components` input listing only components whose Dockerfiles require them.

For the current backend, all four Dockerfiles use BuildKit secret IDs `GITHUB_USERNAME` and `GITHUB_PAT`. The implementation maps the two explicitly named workflow secrets to those IDs only for the selected component builds. The frontend Dockerfiles currently require no BuildKit secret. This fixed contract is clearer and safer than a generic secret bag or repetitive `build_secret_ids` arrays.

Credentials must use BuildKit secret mounts and must not be converted to build arguments, copied into layers, included in cache metadata, echoed, or written to manifests/artifacts. An unknown component in `package-auth-components` fails configuration validation in the secret-free `prepare` job. A missing half of the credential pair, or missing credentials for a selected component, fails that component's credential check before registry login or publication. That check runs inside the matrix job, so the job that reads public configuration never handles credentials ([why](security.md#secret-free-output-jobs)).

BuildKit cache uses the GitHub Actions cache backend with a component-specific scope when `enable-cache` is true. Cache data is an optimization and is never release evidence. The registry-resolved digest remains authoritative.

## Reference application examples

The proposed backend file is [examples/dotnet/docker-images.json](../examples/dotnet/docker-images.json). It contains the verified WebAPI, Consumer, Jobs, and DatabaseMigrator Dockerfile locations. The proposed frontend file is [examples/nextjs/docker-images.json](../examples/nextjs/docker-images.json), using the verified User, Admin, and Public portal Dockerfiles.

The `docker.io/example/...` namespace is illustrative and is not a real publishing destination. DEVOPS-012 and DEVOPS-013 will create the files in the consuming repositories with approved namespaces.

## Schema compatibility

Adding an optional field with a safe default is a compatible image-schema minor evolution and toolkit minor release. Changing field meaning/defaults, accepting a new major `schemaVersion`, removing a field, or making an optional field required needs explicit migration guidance and normally a toolkit major release. Readers reject unsupported schema versions; existing files are never silently reinterpreted.
