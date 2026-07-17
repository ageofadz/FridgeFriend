def route_contract_exact_match(run, example):
    if not isinstance(run, dict):
        raise ValueError("run must be a dictionary")
    if not isinstance(example, dict):
        raise ValueError("example must be a dictionary")
    if not isinstance(run.get("outputs"), dict):
        raise ValueError("run.outputs must be a dictionary")
    if not isinstance(example.get("outputs"), dict):
        raise ValueError("example.outputs must be a dictionary")
    if "trajectory" not in run["outputs"]:
        raise ValueError("run.outputs is missing trajectory")
    if "expectedRoute" not in example["outputs"]:
        raise ValueError("example.outputs is missing expectedRoute")
    actual = run["outputs"]["trajectory"]
    expected = example["outputs"]["expectedRoute"]
    if not isinstance(actual, list) or any(not isinstance(entry, str) for entry in actual):
        raise ValueError("run.outputs.trajectory must be an array of node names")
    if not isinstance(expected, list) or any(not isinstance(entry, str) for entry in expected):
        raise ValueError("example.outputs.expectedRoute must be an array of node names")
    return {
        "score": int(actual == expected),
        "comment": f"Expected {' -> '.join(expected)}, received {' -> '.join(actual)}",
    }
