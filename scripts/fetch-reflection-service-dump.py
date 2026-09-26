import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request


API_ROOT = "https://apis.roblox.com/cloud/v2"
VERSION_HISTORY_URL = (
    "https://raw.githubusercontent.com/setup-rbxcdn/setup-rbxcdn.github.io/"
    "refs/heads/main/version-history/Windows/Studio64.json"
)
HASH_DIR = pathlib.Path("reflectionservice-dumps/hashes")
ENGINE_DIR = pathlib.Path("reflectionservice-dumps/engine")
DUMP_NAME = "ReflectionService-Dump.json"
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def request_json(url, api_key=None, *, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if body is not None else "GET",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"HTTP {error.code} from {url}: {error.read().decode()}"
        ) from error


def lookup_hash(engine_version):
    """The hash for this engine version; None if history does not know it yet."""
    try:
        history = request_json(VERSION_HISTORY_URL)
    except (RuntimeError, OSError) as error:
        print(f"Could not read version history: {error}")
        return None
    raw = history.get(engine_version)
    if not isinstance(raw, str) or not raw.strip():
        print(f"Version history has no Studio64 hash for {engine_version}")
        return None
    return raw.strip().removeprefix("version-")


def update_dump(path, dump_obj, outputs):
    """Write path unless it already holds this exact JSON."""
    if path.exists():
        try:
            if json.loads(path.read_text(encoding="utf-8")) == dump_obj:
                print(f"{path} unchanged")
                return
        except (json.JSONDecodeError, OSError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump_obj, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path}")
    outputs.append(path.as_posix())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--result", required=True, help="Path for the run summary JSON"
    )
    args = parser.parse_args()

    # Always run the full Luau task: FFlags can flip the dump contents even when
    # version() has not moved, so every run re-dumps and content-dedupes writes.
    api_key = os.environ["RBLX_OC_API_KEY"]
    universe_id = os.environ["RBLX_UNIVERSE_ID"]
    place_id = os.environ["RBLX_PLACE_ID"]
    script = pathlib.Path(__file__).with_name("reflection-service-dump.luau").read_text(
        encoding="utf-8"
    )

    create_url = (
        f"{API_ROOT}/universes/{universe_id}/places/{place_id}/"
        "luau-execution-session-tasks"
    )
    task = request_json(create_url, api_key, body={"script": script})
    task_url = f"{API_ROOT}/{task['path']}"
    print(f"Created {task['path']}")

    while task["state"] == "PROCESSING":
        time.sleep(2)
        task = request_json(task_url, api_key)

    if task["state"] != "COMPLETE":
        raise RuntimeError(f"Luau task failed: {json.dumps(task.get('error'))}")

    results = task.get("output", {}).get("results", [])
    if len(results) != 2 or not isinstance(results[0], (str, int, float)) \
            or isinstance(results[0], bool) or not isinstance(results[1], str):
        raise RuntimeError(
            f"Luau task returned an unexpected result: expected version() plus "
            f"the dump, got {json.dumps(results)[:200]}"
        )

    engine_version = str(results[0])
    if not SAFE_NAME.match(engine_version):
        raise RuntimeError(f"Unusable engine version string: {engine_version!r}")
    print(f"Open Cloud version(): {engine_version}")

    dump_obj = json.loads(results[1])
    outputs = []

    update_dump(ENGINE_DIR / f"{engine_version}-{DUMP_NAME}", dump_obj, outputs)

    # The hash copy is best-effort: history may not know this version yet.
    hash_version = lookup_hash(engine_version)
    if hash_version:
        update_dump(HASH_DIR / f"version-{hash_version}-{DUMP_NAME}", dump_obj, outputs)

    result = {
        "status": "written" if outputs else "unchanged",
        "engine_version": engine_version,
        "outputs": outputs,
    }
    pathlib.Path(args.result).write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
