import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load_script(filename: str):
    path = ROOT / ".github" / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def statsgen():
    return load_script("statsgen.py")


@pytest.fixture
def sitegen():
    return load_script("sitegen.py")
