# Python SDK installation (development preview)

Use your local Python 3.10 or newer. The SDK uses only the standard library and requires no
third-party runtime dependencies.

From the repository root, add the SDK source directory to `PYTHONPATH` before launching a
development plugin with that Python interpreter:

```sh
export PYTHONPATH="$PWD/sdks/python${PYTHONPATH:+:$PYTHONPATH}"
```
