"""Content-Length framing shared with the Kobrixa host."""

MAX_MESSAGE_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 1024


class FramingError(Exception):
    pass


def _valid_header_line(line: str) -> bool:
    name, separator, value = line.partition(":")
    return bool(separator and name) and all(c.isascii() and (c.isalnum() or c == "-") for c in name) and "\r" not in value


def encode(text: str) -> bytes:
    body = text.encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        raise FramingError("Message exceeds 1 MiB.")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


class Decoder:
    def __init__(self) -> None:
        self._buffer = bytearray()

    def push(self, chunk: bytes) -> list[str]:
        self._buffer += chunk
        messages: list[str] = []
        while True:
            end = self._buffer.find(b"\r\n\r\n")
            if (end < 0 and len(self._buffer) > MAX_HEADER_BYTES) or end > MAX_HEADER_BYTES:
                raise FramingError("Message header is too long.")
            if end < 0:
                # Reject stray output such as a single print() line before a terminator arrives.
                *complete, _partial = bytes(self._buffer).decode("latin-1").split("\n")
                for line in complete:
                    if not line.endswith("\r") or not _valid_header_line(line[:-1]):
                        raise FramingError("Malformed message header.")
                return messages
            length = None
            try:
                lines = bytes(self._buffer[:end]).decode("ascii").split("\r\n")
            except UnicodeDecodeError as error:
                raise FramingError("Malformed message header.") from error
            for line in lines:
                if not _valid_header_line(line):
                    raise FramingError("Malformed message header.")
                name, _separator, value = line.partition(":")
                if name.lower() == "content-length":
                    value = value.strip(" \t")
                    if length is not None or not value.isdigit() or len(value) > 10:
                        raise FramingError("Invalid Content-Length.")
                    length = int(value)
            if length is None:
                raise FramingError("Missing Content-Length.")
            if length > MAX_MESSAGE_BYTES:
                raise FramingError("Message exceeds 1 MiB.")
            start = end + 4
            if len(self._buffer) < start + length:
                return messages
            body = bytes(self._buffer[start:start + length])
            del self._buffer[:start + length]
            try:
                messages.append(body.decode("utf-8"))
            except UnicodeDecodeError as error:
                raise FramingError("Message body is not valid UTF-8.") from error
