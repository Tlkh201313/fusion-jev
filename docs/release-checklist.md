# Release status

Identity: Fusion Jev, independent community integration. Public source repository: [Tlkh201313/fusion-jev](https://github.com/Tlkh201313/fusion-jev). The GitHub API confirmed the owner and public repository on 2026-09-30. Source publication does not publish the npm package.

The primary npm registry returned 404 for `fusion-jev-mcp` on 2026-09-30. The name remains provisional and unpublished; availability is not a reservation. Version 0.3.0 and bin `fusion-jev` identify this prepared source/package.

## Publisher and launch gates

- Source and package require a secret/private-path scan and validation before each public upload.
- Repository/homepage/bugs metadata point to the actual public source repository; npm publication is a separate future action.
- Recorded demo is pending. The deterministic demo recipe and tests are not a video recording.
- Windows local validation and clean consumer checks must be recorded from this exact tree. CI configuration alone does not establish Linux/macOS results.
- MIT source notice is included. Jev service terms, pricing and model availability belong to TypeSafe.
- GitHub private vulnerability reporting is enabled; see [security reporting](../SECURITY.md). No response-time promise is made.

## Local archive use

From an extracted source archive containing package.json:

```sh
npm ci
npm run setup
```

For a prepared npm tarball, users can explicitly choose a local installation:

```sh
npm install -g /absolute/path/to/fusion-jev-mcp-0.3.1.tgz
fusion-jev setup
```

These commands refer to the supplied local archive, not a package already available on a public registry. Preparation never installs a global binary or changes an existing host configuration automatically.
