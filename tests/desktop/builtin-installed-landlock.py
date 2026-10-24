"""Linux-only installed-product test launcher; the product never imports this file.

Landlock restrictions survive exec and are inherited by all descendants. Unlike
an outer Chromium sandbox, this does not prevent Chromium creating its own
user namespace. Require ABI 4 for TCP connect denial; unsupported hosts fail.
"""

import ctypes
import os
import pathlib
import sys


def launch(arguments):
    separator = arguments.index("--")
    denied = [pathlib.Path(item).resolve(strict=True) for item in arguments[:separator]]
    command = arguments[separator + 1 :]
    if not denied or not command or not os.path.isabs(command[0]):
        raise ValueError("Absolute denied roots and executable are required")
    if any(not item.is_dir() or item == pathlib.Path("/") for item in denied):
        raise ValueError("Denied roots must be existing non-root directories")
    executable = pathlib.Path(command[0]).resolve(strict=True)
    if any(executable.is_relative_to(item) for item in denied):
        raise ValueError("Installed executable is inside a denied source root")

    libc = ctypes.CDLL(None, use_errno=True)

    def checked(result):
        if result == -1:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return result

    # Generic syscall numbers on supported Linux arm64/x86_64.
    create_ruleset, add_rule, restrict_self = 444, 445, 446
    abi = checked(libc.syscall(create_ruleset, 0, 0, 1))
    if abi < 4:
        raise RuntimeError("Landlock ABI >= 4 is required, got " + str(abi))

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    # ABI 3 filesystem rights, including REFER and TRUNCATE. Network handles
    # CONNECT_TCP only: inspector listeners remain reachable from the controller,
    # while product outbound TCP is denied even to a live loopback endpoint.
    rights = (1 << 15) - 1
    ruleset = Ruleset(rights, 1 << 1)
    fd = checked(libc.syscall(create_ruleset, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0))
    try:
        def allow_subtree(candidate):
            resolved = candidate.resolve()
            if any(resolved.is_relative_to(item) for item in denied):
                return
            if any(item.is_relative_to(resolved) for item in denied):
                for child in candidate.iterdir():
                    allow_subtree(child)
                return
            handle = os.open(candidate, os.O_PATH | os.O_CLOEXEC)
            try:
                allowed = rights if candidate.is_dir() else (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14)
                rule = PathRule(allowed, handle)
                checked(libc.syscall(add_rule, fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(handle)

        # Never allow the root: its rule would also allow every denied subtree.
        for child in pathlib.Path("/").iterdir():
            allow_subtree(child)
        checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(libc.syscall(restrict_self, fd, 0))
    finally:
        os.close(fd)
    os.execve(command[0], command, os.environ)


if __name__ == "__main__":
    launch(sys.argv[1:])
