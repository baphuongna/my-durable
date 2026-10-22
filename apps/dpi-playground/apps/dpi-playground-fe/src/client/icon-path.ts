const DEFAULT_ICON = "lab.png";

/** The icon name is device-controlled; only a plain png/svg file name may become part of the path. */
export function iconPath(name?: unknown) {
  const ok = typeof name === "string" && /^[\w.-]+\.(png|svg)$/.test(name) && !name.includes("..");
  return `/icons/${ok ? name : DEFAULT_ICON}`;
}
