import { Command } from 'commander'

export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const WEB_STARTUP_SERVICE = 'webStartup'

function configureOutput(program: any) {
  program.exitOverride().configureOutput({
    writeOut: (text: string) => process.stdout.write(text),
    writeErr: (text: string) => process.stderr.write(text)
  })
  for (const child of program.commands) configureOutput(child)
}

function isCommanderError(error: any): boolean {
  if (typeof error !== 'object' || error === null) return false
  return typeof error.code === 'string' && error.code.startsWith('commander.') && typeof error.exitCode === 'number'
}

function webCommand() {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (0.0.0.0 exposes the UI to the network — pair with dsh-public-access auth)')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           bind all interfaces (public access via dsh-public-access)
`)
}

export function apply(ctx: any) {
  const program = webCommand()
  configureOutput(program)
  program.action(() => {
    const options = program.opts()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    // The stock dsh web-startup rejects --host 0.0.0.0 for safety. This bundle
    // lifts that restriction on purpose: public/LAN access is the plugin's
    // reason to exist, and access is gated by dsh-public-access auth.
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
      trustedHosts: options.trustedHost ?? []
    })
  })
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) throw new Error('dsh-public-access: missing cmdlineArgs/appExit services')
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
}
