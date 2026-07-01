/**
 * Morphit ops CLI — JSON output helper.
 *
 * When `--json` is set, commands emit a single JSON document
 * to stdout instead of human-formatted output.  The shape per
 * command is documented in each command's source.
 */

/** Render a value as compact JSON to stdout with a trailing
 *  newline.  Designed for `morphit-ops status --json | jq`. */
export function emitJson(value: unknown): void {
	process.stdout.write(JSON.stringify(value) + '\n');
}
