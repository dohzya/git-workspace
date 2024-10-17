import $ from "jsr:@david/dax@0.42.0";

export function die(
  code: number,
  header: unknown,
  ...details: unknown[]
): never {
  if (details.length === 0 || typeof header !== "string") {
    $.logError("ERROR", header);
  } else {
    $.logError(header, ...details);
  }
  Deno.exit(code);
}

let _displayInfo = true;
export function displayInfo(display: boolean) {
  _displayInfo = display;
}

export function emptyLog() {
  if (!_displayInfo) return;
  $.log();
}
export function warn(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logWarn(header, ...(details.length ? details : [""]));
}
export function info(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logStep(header, ...(details.length ? details : [""]));
}
export function note(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logLight(header, ...(details.length ? details : [""]));
}
export async function progress<T>(fn: () => Promise<T>) {
  if (!_displayInfo) return await fn();
  return await $.progress({}).with(fn);
}
export async function progressIfConf<T>(cond: boolean, fn: () => Promise<T>) {
  if (_displayInfo && cond) {
    return await progress(fn);
  } else {
    return await fn();
  }
}
