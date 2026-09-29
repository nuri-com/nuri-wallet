import { Platform, Share } from "react-native";
import * as FileSystem from "expo-file-system";

// Writing/sharing the file. Building the CSV text is lib/csv.ts (platform-free).
//
// Where a file can be attached it is; where it cannot, the CSV itself is shared
// as text. Every path throws when nothing was handed over, so a caller never
// reports an export that did not happen.
//
//   web      a download of the .csv
//   iOS      the share sheet with the .csv file attached (`url`)
//   Android  the share sheet with the CSV as text. React Native's Android Share
//            module forwards only `message` — a `url` is dropped, which opened a
//            chooser with no CSV in it. Attaching the file would need a native
//            share module, which changes the app fingerprint and cuts this build
//            off from OTA; the text is the whole export, so it is shared as that.

export async function shareCsvFile(csv: string, fileName: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      downloadOnWeb(csv, fileName);
      return;
    } catch {}
    await Share.share({ message: csv });
    return;
  }

  if (Platform.OS === "android") {
    await Share.share({ message: csv, title: fileName });
    return;
  }

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    await Share.share({ message: csv });
    return;
  }
  const fileUri = baseDir.endsWith("/") ? `${baseDir}${fileName}` : `${baseDir}/${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  try {
    await Share.share({ url: fileUri, title: fileName });
  } catch {
    // The file could not be shared; the text still can. If that fails too, the
    // error reaches the caller.
    await Share.share({ message: csv });
  }
}

function downloadOnWeb(csv: string, fileName: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
