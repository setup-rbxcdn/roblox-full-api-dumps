import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request


API_ROOT = "https://apis.roblox.com/cloud/v2"
NOT_READY_EXIT = 3
DUMP_DIR = pathlib.Path("reflectionservice-dumps")


def request_json(url, api_key, *, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if body is not None else "GET",
        headers={"Content-Type": "application/json", "x-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"Roblox API returned HTTP {error.code}: {error.read().decode()}"
        ) from error


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--candidates",
        required=True,
        help=(
            "JSON file holding an array of {version, engine_version} candidates. "
            "The candidate whose engine_version matches the version() reported by "
            "the Open Cloud engine is the one dumped."
        ),
    )
    parser.add_argument(
        "--result",
        required=True,
        help="Path for the {status, version, output} JSON summary of the run",
    )
    return parser.parse_args()


def load_candidates(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)

    candidates, seen = [], set()
    for entry in raw:
        version = str(entry["version"]).strip().removeprefix("version-")
        if version in seen:
            continue
        seen.add(version)
        candidates.append(
            {"version": version, "engine_version": str(entry["engine_version"]).strip()}
        )
    return candidates


def dump_path(version):
    return DUMP_DIR / f"version-{version}-ReflectionService-Dump.json"


def write_result(path, result):
    pathlib.Path(path).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def main():
    args = parse_args()
    candidates = load_candidates(args.candidates)

    # Candidates that already have a dump are not worth an Open Cloud task.
    pending = []
    for candidate in candidates:
        path = dump_path(candidate["version"])
        if path.exists():
            print(f"{path} already exists")
        else:
            pending.append(candidate)

    if not pending:
        write_result(args.result, {"status": "exists"})
        return 0

    api_key = os.environ["RBLX_OC_API_KEY"]
    universe_id = os.environ["RBLX_UNIVERSE_ID"]
    place_id = os.environ["RBLX_PLACE_ID"]
    script_path = pathlib.Path(__file__).with_name("reflection-service-dump.luau")
    script = script_path.read_text(encoding="utf-8")

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
    if len(results) != 2 or not isinstance(results[1], str):
        types = ", ".join(type(value).__name__ for value in results)
        raise RuntimeError(
            f"Luau task returned an unexpected result: expected 2 values, "
            f"got {len(results)} ({types})"
        )

    raw_version = results[0]
    if isinstance(raw_version, bool) or not isinstance(raw_version, (str, int, float)):
        raise RuntimeError(
            f"Luau task returned an unexpected result: {json.dumps(raw_version)}"
        )
    observed_version = str(raw_version)
    print(f"Open Cloud version(): {observed_version}")

    matching = [
        candidate
        for candidate in pending
        if candidate["engine_version"] == observed_version
    ]
    if not matching:
        print(f"No candidate is at {observed_version}; dump not ready")
        write_result(args.result, {"status": "not_ready"})
        return NOT_READY_EXIT

    if len(matching) > 1:
        print(f"{len(matching)} candidates match {observed_version}; using the first")

    candidate = matching[0]
    path = dump_path(candidate["version"])
    path.write_text(
        json.dumps(json.loads(results[1]), indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {path} for version-{candidate['version']}")

    write_result(
        args.result,
        {
            "status": "written",
            "version": candidate["version"],
            "output": path.as_posix(),
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
