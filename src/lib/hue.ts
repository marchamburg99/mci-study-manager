/** Stabile Akzentfarbe pro Fach (Reminders-Stil). */
export function fachHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
