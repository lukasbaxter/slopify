"""The shipped English translations are the strings file."""

import json
from pathlib import Path

ROOT = Path(__file__).parents[2] / "custom_components" / "slopify"


def test_translations_match_strings() -> None:
    strings = json.loads((ROOT / "strings.json").read_text())
    assert json.loads((ROOT / "translations" / "en.json").read_text()) == strings
