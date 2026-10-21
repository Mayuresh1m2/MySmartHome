import json

import jsonschema
import pytest
from hearth_devices_sdk.contract import DeviceMeta, Result, SetCommand, contracts_dir, state_payload, validate

FIX = contracts_dir() / "fixtures"


@pytest.mark.parametrize("path", sorted((FIX / "valid").glob("*.json")), ids=lambda p: p.name)
def test_valid_fixtures_pass_schema_and_models(path):
    doc = json.loads(path.read_text())
    kind = path.name.split("-")[0]
    validate(kind, doc)
    model = {"meta": DeviceMeta, "set": SetCommand, "result": Result}.get(kind)
    if model:
        assert model.model_validate(doc).model_dump() == doc


@pytest.mark.parametrize("path", sorted((FIX / "invalid").glob("*.json")), ids=lambda p: p.name)
def test_invalid_fixtures_fail_schema(path):
    with pytest.raises(jsonschema.ValidationError):
        validate(path.name.split("-")[0], json.loads(path.read_text()))


def test_state_payload_shape_and_reserved_keys():
    doc = state_payload(True, {"on": True})
    validate("state", doc)
    assert doc["v"] == 1 and doc["online"] is True and isinstance(doc["updatedAt"], int)
    with pytest.raises(ValueError, match="reserved"):
        state_payload(True, {"online": False})


def test_device_id_must_be_lowercase():
    with pytest.raises(ValueError):
        DeviceMeta(id="Bad ID", name="x", kind="light", adapter="a", capabilities=[])
