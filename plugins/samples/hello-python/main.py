from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-samples.hello-python.greet")
async def greet(ctx):
    await ctx.ui.show_message("來自 Python 插件的問候" if ctx.locale == "zh-TW" else "Hello from a Python plugin")


if __name__ == "__main__":
    plugin.run()
