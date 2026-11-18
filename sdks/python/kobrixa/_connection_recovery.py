"""Unpublished 1.8 USB connection-recovery observation semantics; no cancellation authority."""
import json
import re


def supported(version):
    return isinstance(version, str) and re.fullmatch(r"1\.(?:[89]|[1-9][0-9]+)\.[0-9]+", version) is not None


def request(method, params):
    return method == "devices/connectionRecovery/read" or (method == "devices/subscribe" and isinstance(params, dict) and params.get("topic") == "connectionRecovery")


def validate_snapshot(value):
    # Structure is checked by the shared generated schema before these semantics.
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > 4096:
        raise ValueError("Recovery snapshot exceeds 4096 bytes")
    r = value["recovery"]
    if r is None:
        return
    def text(s, maximum):
        if len(s) > maximum or len(s.encode("utf-8")) > maximum * 4:
            raise ValueError("Invalid recovery text")
    text(r["name"], 200)
    phase, attempts, limit = r["phase"], r["attemptsStarted"], r["retryLimit"]
    if phase == "cancel-failed": text(r["error"]["message"], 256)
    if phase == "restored" and r["sessionId"] == r["previousSessionId"]:
        raise ValueError("Restored session must be new")
    if phase == "retry-exhausted" and (limit == "unlimited" or attempts < limit):
        raise ValueError("Invalid exhausted recovery")
    if phase == "waiting" and limit != "unlimited" and attempts >= limit:
        raise ValueError("Exhausted recovery cannot wait")
    if phase in ("connecting", "restored") and attempts == 0:
        raise ValueError("Recovery attempt has not started")


def validate_result(method, result, params):
    if not isinstance(result, dict) or not result.get("ok"):
        return
    if method == "devices/connectionRecovery/read":
        validate_snapshot(result["value"])
    if method == "devices/subscribe":
        s, topic = result["value"]["snapshot"], params["topic"]
        if topic == "connectionRecovery":
            from ._schema import Validator
            Validator.bundled().validate("connection-recovery-snapshot", s)
        else:
            from ._schema import Validator
            # Reuse strict legacy subscribe alternatives, then correlate the topic.
            Validator.bundled().validate("devices/subscribe.v170.result", result)
            keys = {"catalog": "providers", "session": "session", "telemetry": "status", "motion": "operationId", "reservation": "reservationId", "authority": "contextRef"}
            if keys[topic] not in s: raise ValueError("Wrong device snapshot topic")
            if topic == "session" and s["session"]["sessionId"] != params["sessionId"]: raise ValueError("Wrong session")
            if topic == "telemetry" and s["sessionId"] != params["sessionId"]: raise ValueError("Wrong telemetry session")
            for key in ("operationId", "reservationId", "contextRef"):
                if key in params and s.get(key) != params[key]: raise ValueError("Wrong device snapshot reference")
