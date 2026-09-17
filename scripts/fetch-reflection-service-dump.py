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
    parser.add_argument("--version", required=True, help="LIVE Studio deployment hash")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    output = pathlib.Path(args.output)
    if output.exists():
        print(f"{output} already exists")
        return 0

    api_key = os.environ["RBLX_OC_API_KEY"]
    universe_id = os.environ["RBLX_UNIVERSE_ID"]
    place_id = os.environ["RBLX_PLACE_ID"]
    expected_version = os.environ["RBLX_EXPECTED_VERSION"]
    script_path = pathlib.Path(__file__).with_name("reflection-service-dump.luau")
    script = script_path.read_text(encoding="utf-8")
    guard = f'''local expectedVersion = {json.dumps(expected_version)}
local actualVersion = version()
if actualVersion ~= expectedVersion then
    return "VERSION_MISMATCH:" .. actualVersion
end

'''

    create_url = (
        f"{API_ROOT}/universes/{universe_id}/places/{place_id}/"
        "luau-execution-session-tasks"
    )
    task = request_json(create_url, api_key, body={"script": guard + script})
    task_url = f"{API_ROOT}/{task['path']}"
    print(f"Created {task['path']}")

    while task["state"] == "PROCESSING":
        time.sleep(2)
        task = request_json(task_url, api_key)

    if task["state"] != "COMPLETE":
        raise RuntimeError(f"Luau task failed: {json.dumps(task.get('error'))}")

    results = task.get("output", {}).get("results", [])
    if len(results) != 1 or not isinstance(results[0], str):
        raise RuntimeError("Luau task returned an unexpected result")
    result = results[0]
    if result.startswith("VERSION_MISMATCH:"):
        actual_version = result.removeprefix("VERSION_MISMATCH:")
        print(f"Open Cloud is on {actual_version}; expected LIVE {expected_version}")
        return NOT_READY_EXIT

    dump = json.loads(result)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dump, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output} for version-{args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
