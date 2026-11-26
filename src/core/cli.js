// Run Flop's official command-line tool, version pinned, and parse its JSON.
//
// Signing happens inside the CLI. When a command needs the agent's key, this
// module passes the keystore path with --keystore and the password through an
// environment variable (--password-env), exactly as the CLI's own help shows.
// The password is read from the password file into the child process's
// environment and nowhere else: it is never logged, printed or written.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cfg, signerProblems } from './config.js';

const PASSWORD_ENV = 'FLOP_KIT_PW';

/**
 * Run `flop --network <net> [signer options] <args> --json`.
 * @param {string[]} args  subcommand and its options, e.g. ['faucet', 'request', address]
 * @param {{signer?: boolean, json?: boolean, timeoutMs?: number, network?: string}} opts
 * @returns {Promise<{ok: boolean, code: number|null, json: any, stdout: string, stderr: string, command: string}>}
 */
export function runFlop(args, opts = {}) {
  const { signer = false, json = true, timeoutMs = 180_000, network = cfg.network } = opts;
  const argv = ['--yes', '--package', cfg.cliPackage, 'flop', '--network', network];
  const env = { ...process.env };
  let secret = null;

  if (signer) {
    const problems = signerProblems();
    if (problems.length) {
      return Promise.resolve({
        ok: false, code: null, json: null, stdout: '', stderr: problems.join('\n'),
        command: describe(argv, args, json),
      });
    }
    argv.push('--keystore', cfg.keystore, '--password-env', PASSWORD_ENV);
    secret = readFileSync(cfg.passwordFile, 'utf8').split(/\r?\n/)[0];
    env[PASSWORD_ENV] = secret;
  }

  argv.push(...args);
  if (json && !args.includes('--json')) argv.push('--json');
  const command = describe(argv, [], json);

  return new Promise((resolvePromise) => {
    execFile('npx', argv, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = String(stdout || '');
      let errText = String(stderr || '');
      if (secret) {
        // Defence in depth: the CLI should never echo the password, but if it ever did, redact it.
        out = out.split(secret).join('[redacted]');
        errText = errText.split(secret).join('[redacted]');
      }
      // On a refusal the CLI prints its JSON report on stderr; read both.
      resolvePromise({
        ok: !err,
        code: err ? (err.code ?? null) : 0,
        json: json ? (extractJson(out) ?? extractJson(errText)) : null,
        stdout: out,
        stderr: errText,
        command,
      });
    });
  });
}

/** Return the command as a human-readable string, without the password (which is never on the command line anyway). */
function describe(argv, extra, json) {
  const parts = ['npx', ...argv, ...extra];
  if (json && !parts.includes('--json')) parts.push('--json');
  return parts.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(' ');
}

/** Find the last JSON object or array printed on stdout; the CLI may print notices before it. */
export function extractJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  for (const open of ['{', '[']) {
    let idx = trimmed.indexOf(open);
    while (idx !== -1) {
      try {
        return JSON.parse(trimmed.slice(idx));
      } catch {
        idx = trimmed.indexOf(open, idx + 1);
      }
    }
  }
  return null;
}

/** The one-line explanation printed before a CLI call, for readers who are not specialists. */
export function explain(line) {
  process.stderr.write(`\n> ${line}\n`);
}
