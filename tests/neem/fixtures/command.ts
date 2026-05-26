import { writeFile } from 'node:fs/promises'

export default {
  args: { value: { type: 'string', required: true } },
  async run(ctx: { rawArgs: string[]; args: { value: string; _: string[] } }) {
    const output = process.env.NEEM_TEST_COMMAND_OUTPUT
    if (!output) throw new Error('Missing NEEM_TEST_COMMAND_OUTPUT')
    await writeFile(
      output,
      JSON.stringify({
        rawArgs: ctx.rawArgs,
        value: ctx.args.value,
        rest: ctx.args._,
      }),
    )
  },
}
