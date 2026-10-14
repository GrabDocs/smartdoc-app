import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { buildPrintableNoteHtml, noteExportFileName } from './draftNoteFormat';

type ExpoPrintModule = typeof import('expo-print');

/**
 * expo-print is a native module. OTA updates share runtimeVersion "1.0.0" with binaries built
 * before it was added, so it must be loaded lazily and treated as optional.
 */
let printModule: ExpoPrintModule | null | undefined;
function getPrintModule(): ExpoPrintModule | null {
  if (printModule !== undefined) return printModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    printModule = require('expo-print') as ExpoPrintModule;
  } catch {
    printModule = null;
  }
  return printModule;
}

export function isNativePrintAvailable(): boolean {
  return getPrintModule() !== null;
}

async function shareHtmlFallback(title: string, html: string): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir || !(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  const uri = `${dir}${noteExportFileName(title, 'html')}`;
  await FileSystem.writeAsStringAsync(uri, html, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(uri, { mimeType: 'text/html', UTI: 'public.html', dialogTitle: title });
}

export type NoteExportResult = 'native' | 'html-fallback';

/** System print dialog (includes "Save as PDF"); falls back to sharing printable HTML. */
export async function printDraftNote(title: string, bodyHtml: string): Promise<NoteExportResult> {
  const html = buildPrintableNoteHtml(title, bodyHtml);
  const Print = getPrintModule();
  if (!Print) {
    await shareHtmlFallback(title, html);
    return 'html-fallback';
  }
  await Print.printAsync({ html });
  return 'native';
}

/** Render a PDF file and open the share sheet; falls back to sharing printable HTML. */
export async function exportDraftNotePdf(title: string, bodyHtml: string): Promise<NoteExportResult> {
  const html = buildPrintableNoteHtml(title, bodyHtml);
  const Print = getPrintModule();
  if (!Print) {
    await shareHtmlFallback(title, html);
    return 'html-fallback';
  }
  const { uri } = await Print.printToFileAsync({ html });
  let shareUri = uri;
  const dir = FileSystem.cacheDirectory;
  if (dir) {
    const named = `${dir}${noteExportFileName(title, 'pdf')}`;
    try {
      await FileSystem.deleteAsync(named, { idempotent: true });
      await FileSystem.moveAsync({ from: uri, to: named });
      shareUri = named;
    } catch {
      shareUri = uri;
    }
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(shareUri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: title });
  return 'native';
}
