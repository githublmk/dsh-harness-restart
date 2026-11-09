/**
 * Pure helpers of the relaunch assistant.
 *
 * They live outside the script so argument parsing and the process-table
 * decision can be tested without spawning an application.
 *
 * @module dsh-harness-restart/lib/relaunch-core
 */

/**
 * Parse the assistant argv.
 *
 * Arguments: `<shell pid> <host pid> <application exe> <log file> <ready marker>
 * [<plan dir> <plan id>]`. The last two may be empty strings, which means the
 * assistant writes no receipts.
 * @param {readonly string[]} argv - process arguments after the script.
 * @returns {{shell:number|null, host:number|null, appExe:string, logFile:string,
 *   marker:string, planDir:string, planId:string}} - parsed values; a pid is
 *   null when it is not a usable positive integer.
 */
export function parseAssistantArgs(argv) {
  const [shellArg, hostArg, appExe, logFile, marker, planDirArg, planIdArg] = Array.isArray(argv) ? argv : []
  const shell = Number(shellArg)
  const host = Number(hostArg)
  return {
    shell: Number.isInteger(shell) && shell > 0 ? shell : null,
    host: Number.isInteger(host) && host > 0 ? host : null,
    appExe: typeof appExe === 'string' ? appExe : '',
    logFile: typeof logFile === 'string' ? logFile : '',
    marker: typeof marker === 'string' ? marker : '',
    planDir: typeof planDirArg === 'string' ? planDirArg : '',
    planId: typeof planIdArg === 'string' ? planIdArg : '',
  }
}

/**
 * Count the processes of one application image in `tasklist` CSV output.
 *
 * The image name comes from the executable path, and only the first CSV column
 * is compared, so a PID or a memory figure that happens to contain the name
 * never counts.
 * @param {string} text - `tasklist /FO CSV /NH` output.
 * @param {string} image - executable file name, for example `App.exe`.
 * @returns {number} - the count, or -1 when the text is unreadable.
 */
export function countApplicationProcesses(text, image) {
  if (typeof text !== 'string') return -1
  const wanted = String(image).toLowerCase()
  let count = 0
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const first = line.split(',')[0]?.replace(/^"|"$/gu, '').trim().toLowerCase()
    if (first === wanted) count += 1
  }
  return count
}

/**
 * Interpret the process table before and after a shell launch.
 * @param {{before:number, after:number}} counts - process counts; -1 unknown.
 * @returns {'launched'|'not-observed'|'unknown'} - `unknown` means the table was
 *   unreadable, and a direct launch would risk a second instance.
 */
export function launchDecision({ before, after }) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'unknown'
  if (before < 0 || after < 0) return 'unknown'
  return after > before ? 'launched' : 'not-observed'
}
