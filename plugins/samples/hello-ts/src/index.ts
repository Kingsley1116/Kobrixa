import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-samples.hello-ts.greet", () =>
        context.ui.showMessage(
          context.locale === "zh-TW"
            ? "來自 TypeScript 插件的問候"
            : "Hello from a TypeScript plugin",
        ),
      );
    },
  }),
);
