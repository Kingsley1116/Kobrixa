import os
from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-smoke.pid-python.record")
async def record(ctx):
    with open("pid.txt", "w", encoding="utf-8") as file:
        file.write(str(os.getpid()))


if __name__ == "__main__":
    plugin.run()
