from kobrixa import Plugin
import asyncio
import os

plugin = Plugin()


@plugin.command("acme.behaviors.greet")
async def greet(ctx):
    print("debug output must not corrupt the protocol")
    await ctx.ui.show_message(f"{ctx.plugin_id}:{ctx.locale}")


@plugin.command("acme.behaviors.hang")
async def hang(ctx):
    await asyncio.sleep(3600)


@plugin.command("acme.behaviors.crash")
async def crash(ctx):
    os._exit(3)


if __name__ == "__main__":
    plugin.run()
