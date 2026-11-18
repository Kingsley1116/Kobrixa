// Inspect executable chunks, including split vendor chunks. Source maps contain
// original sources and Monaco's TypeScript worker spells "jsxDEV" as compiler
// data. The JSX runtime property and React DOM's dev banner survive minification.
export async function assertProductionRenderer(files, read) {
  let productionReact = false;
  for (const file of files.filter((name) => name.endsWith(".js"))) {
    const code = (await read(file)).toString();
    const development =
      /\.jsxDEV\b|Download the React DevTools for a better development experience|react-dom-client\.development\.js/.exec(
        code,
      );
    if (development) throw new Error(`Development React marker in ${file}: ${development[0]}`);
    if (code.includes("Minified React error #")) productionReact = true;
  }
  if (!productionReact) throw new Error("Missing production React DOM error formatter in renderer");
}
