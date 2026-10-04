/**
 * The PDF document a chat export is written into.
 *
 * An ordinary, unencrypted PDF. jsPDF's only "encryption" is the legacy
 * 40-bit RC4 scheme with an empty user password: any reader opens it, any
 * tool strips the permission flags, and calling the result "locked" or
 * "read-only" would be a claim the file cannot keep. What a chat export can
 * prove lives in its content: each message's Blurt transaction id, which a
 * reader checks on a block explorer (the chain holds the encrypted form, so
 * that confirms who sent a message and when, not its wording).
 */
import type { jsPDF as JsPdf } from 'jspdf';

export function newChatExportPdf(JsPDF: typeof JsPdf): JsPdf {
	return new JsPDF({ unit: 'pt', format: 'a4' });
}
