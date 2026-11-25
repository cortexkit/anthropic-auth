import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function newerPrimaryControl(directory: string) {
  const command = join(directory, 'newer-primary-command.json')
  const result = join(directory, 'newer-primary-result.json')
  return {
    // The tests signal this from the mock response's exact pause point. The
    // child invokes the same provider callback captured from the real host.
    source: `
import { existsSync, readFileSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
const raceCommand = ${JSON.stringify(command)};
const raceResult = ${JSON.stringify(result)};
let sendNewer;
const editHistory = (history, edit) => edit
  ? JSON.parse(JSON.stringify(history), (_key, value) => typeof value === 'string' ? value.replace(edit.from, edit.to) : value)
  : history;
setInterval(async () => {
  if (!sendNewer || !existsSync(raceCommand)) return;
  const { text, edit } = JSON.parse(readFileSync(raceCommand, 'utf8'));
  unlinkSync(raceCommand);
  let result;
  try { result = { value: await sendNewer(text, edit) }; }
  catch (error) { result = { error: String(error) }; }
  writeFileSync(raceResult + '.new', JSON.stringify(result));
  renameSync(raceResult + '.new', raceResult);
}, 20).unref();
`,
    async send(text: string, edit?: { from: string; to: string }) {
      await writeFile(command, JSON.stringify({ text, edit }))
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const data = await readFile(result, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
          },
        )
        if (data != null) {
          const { value, error } = JSON.parse(data)
          if (error) throw new Error(`Newer primary failed: ${error}`)
          return value as unknown
        }
        await Bun.sleep(25)
      }
      throw new Error('Newer primary callback did not complete')
    },
  }
}
