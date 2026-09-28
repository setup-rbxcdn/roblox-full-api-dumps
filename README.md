# Roblox API dumps

`full.yml` downloads the dispatched Studio build, creates the full API dump,
then runs `scripts/reflection-service-dump.luau` inside that same Studio binary.
ReflectionService output is content-deduplicated into both:

- `reflectionservice-dumps/hashes/version-<hash>-ReflectionService-Dump.json`
- `reflectionservice-dumps/engine/<version()>-ReflectionService-Dump.json`

Both workflows are counterpart extraction paths, dispatched externally, and
both write the same dump layout:

- `full.yml` runs the Luau task inside the downloaded Studio build.
- `reflection-service.yml` runs it through Open Cloud.

They are frequent, not manual-only. The Open Cloud path has its own use case:
it can supply engine versions that do not appear in regular Studio builds.

## Repository secrets

- `ROBLOSECURITY`: the full `.ROBLOSECURITY` value for a dedicated account.
- `SECRET_ROTATION_TOKEN`: a fine-grained PAT able to update this repository's
  Actions secrets.
- `RBLX_OC_API_KEY`, `RBLX_UNIVERSE_ID`, `RBLX_PLACE_ID`: used only by the
  `reflection-service.yml` Open Cloud workflow.

The weekly `rotate-cookie.yml` workflow replaces `ROBLOSECURITY` before it
expires. Rotation invalidates the old cookie, so a failed secret update needs
manual recovery. Both workflows share a concurrency group to prevent rotation
while Studio is authenticating.

Studio authentication credentials are generated with Roblox's first-party
OAuth/PKCE flow, installed only for the process, and removed when execution
finishes. The runner is deliberately Actions-only and does not contain local
state preservation logic. Credentials are not cached or uploaded as artifacts.
