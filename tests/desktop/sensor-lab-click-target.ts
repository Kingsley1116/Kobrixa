// Read-only DOM probe; actual activation still uses Electron's trusted native input.
export function labClickTargetScript(selector: string, text: string | undefined, measure: boolean) {
  const find = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${text === undefined ? "true" : `e.textContent.trim() === ${JSON.stringify(text)}`})`;
  return `(() => {
    const e = ${find};
    if (!e || e.disabled) return null;
    ${measure ? "" : "e.scrollIntoView({block:'center'}); return true;"}
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),targetId:window.labNativeTargetId(e),ariaLabel:e.getAttribute("aria-label")};
  })()`;
}
