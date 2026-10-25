"""Stub for `miio.miioprotocol.MiIOProtocol`.

The vendored Dreamehome `protocol.py` does `from miio.miioprotocol import MiIOProtocol`
and subclasses it in its *local* miio class (`DreameVacuumDeviceProtocol`). Hearth drives
the Dreame L10 Prime over the Dreamehome *cloud*, so that local class is never
instantiated. We provide this stub only so the import resolves, avoiding a real
python-miio dependency (which pulls the `netifaces` C extension needing a compiler).

If a local-miio path is ever added, replace this with the real python-miio.
"""


class MiIOProtocol:  # noqa: D401 - stand-in base class, never instantiated here
    def __init__(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "miio stub: the local miio protocol is not available in this vendored subset; "
            "the Dreame L10 Prime is controlled via the Dreamehome cloud path."
        )
