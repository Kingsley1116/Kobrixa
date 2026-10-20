"""Frozen event attachment contracts; implementations arrive in A-T1/B1-T1."""


def bind_event_channel(peer, owner) -> None:
    raise NotImplementedError("Event channel binding is unavailable before A-T1")


def ui_event_client_port(peer):
    raise NotImplementedError("UI event client is unavailable before B1-T1")
