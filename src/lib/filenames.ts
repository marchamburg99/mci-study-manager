export function displayFileStem(name: string): string {
  const clean = name.normalize("NFC")
    .replace(/[\\/:*?"<>|#[\]^%]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "");
  let stem = "";
  for (const char of clean) {
    if (new TextEncoder().encode(stem + char).length > 160) break;
    stem += char;
  }
  stem = stem.replace(/[. ]+$/g, "") || "Fach";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
}

export function subjectFileName(name: string): string {
  return `${displayFileStem(name)}.md`;
}

export function appointmentFileName(name: string, date: string, time: string): string {
  return `${date} ${time} ${displayFileStem(name)}.md`;
}
