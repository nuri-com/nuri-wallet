import { Platform, Share } from "react-native";
import * as FileSystem from "expo-file-system";

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function shareCsvFile(csv: string, fileName: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    } catch {}
    try {
      await Share.share({ message: csv });
    } catch {}
    return;
  }

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    try {
      await Share.share({ message: csv });
    } catch {}
    return;
  }
  const fileUri = baseDir.endsWith("/") ? `${baseDir}${fileName}` : `${baseDir}/${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  try {
    await Share.share({
      url: fileUri,
      title: fileName,
    });
  } catch {
    try {
      await Share.share({ message: csv });
    } catch {}
  }
}
