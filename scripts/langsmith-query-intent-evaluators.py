def intent_exact_match(run, example):
    if not isinstance(run, dict):
        raise ValueError("run must be a dictionary")
    if not isinstance(example, dict):
        raise ValueError("example must be a dictionary")
    if not isinstance(run.get("outputs"), dict):
        raise ValueError("run.outputs must be a dictionary")
    if not isinstance(example.get("outputs"), dict):
        raise ValueError("example.outputs must be a dictionary")
    if "intent" not in run["outputs"]:
        raise ValueError("run.outputs is missing intent")
    if "intent" not in example["outputs"]:
        raise ValueError("example.outputs is missing intent")
    actual = run["outputs"]["intent"]
    expected = example["outputs"]["intent"]
    return {
        "score": int(actual == expected),
        "comment": f"Expected {expected!r}, received {actual!r}",
    }


def recipe_continuation_exact_match(run, example):
    if not isinstance(run, dict):
        raise ValueError("run must be a dictionary")
    if not isinstance(example, dict):
        raise ValueError("example must be a dictionary")
    if not isinstance(run.get("outputs"), dict):
        raise ValueError("run.outputs must be a dictionary")
    if not isinstance(example.get("outputs"), dict):
        raise ValueError("example.outputs must be a dictionary")
    if "recipeContinuation" not in run["outputs"]:
        raise ValueError("run.outputs is missing recipeContinuation")
    if "recipeContinuation" not in example["outputs"]:
        raise ValueError("example.outputs is missing recipeContinuation")
    actual = run["outputs"]["recipeContinuation"]
    expected = example["outputs"]["recipeContinuation"]
    return {
        "score": int(actual == expected),
        "comment": f"Expected {expected!r}, received {actual!r}",
    }


def shopping_mode_exact_match(run, example):
    if not isinstance(run, dict):
        raise ValueError("run must be a dictionary")
    if not isinstance(example, dict):
        raise ValueError("example must be a dictionary")
    if not isinstance(run.get("outputs"), dict):
        raise ValueError("run.outputs must be a dictionary")
    if not isinstance(example.get("outputs"), dict):
        raise ValueError("example.outputs must be a dictionary")
    if "shoppingMode" not in run["outputs"]:
        raise ValueError("run.outputs is missing shoppingMode")
    if "shoppingMode" not in example["outputs"]:
        raise ValueError("example.outputs is missing shoppingMode")
    actual = run["outputs"]["shoppingMode"]
    expected = example["outputs"]["shoppingMode"]
    return {
        "score": int(actual == expected),
        "comment": f"Expected {expected!r}, received {actual!r}",
    }
