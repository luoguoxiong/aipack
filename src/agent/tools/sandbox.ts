import path from 'path';

export interface SandboxBackend {
  name: string;
  wrap(command: string, workspace: string, cwd: string, mediaDir?: string): string;
}

class BwrapBackend implements SandboxBackend {
  name = 'bwrap';

  wrap(command: string, workspace: string, cwd: string, mediaDir?: string): string {
    const ws = path.resolve(workspace);
    const media = mediaDir ? path.resolve(mediaDir) : null;

    let sandboxCwd: string;
    try {
      const resolvedCwd = path.resolve(cwd);
      const rel = path.relative(ws, resolvedCwd);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        sandboxCwd = ws;
      } else {
        sandboxCwd = path.join(ws, rel);
      }
    } catch {
      sandboxCwd = ws;
    }

    const required = ['/usr'];
    const optional = [
      '/bin',
      '/lib',
      '/lib64',
      '/etc/alternatives',
      '/etc/ssl/certs',
      '/etc/pki/tls/certs',
      '/etc/pki/ca-trust',
      '/etc/crypto-policies',
      '/etc/resolv.conf',
      '/etc/ld.so.cache',
    ];

    const args: string[] = [
      'bwrap', '--new-session', '--die-with-parent',
      '--setenv', 'HOME', ws,
    ];

    for (const p of required) {
      args.push('--ro-bind', p, p);
    }
    for (const p of optional) {
      args.push('--ro-bind-try', p, p);
    }

    args.push(
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--tmpfs', path.dirname(ws),
      '--dir', ws,
      '--bind', ws, ws,
    );

    if (media) {
      args.push('--ro-bind-try', media, media);
    }

    args.push(
      '--chdir', sandboxCwd,
      '--', 'sh', '-c', command,
    );

    return args.map(a => shellQuote(a)).join(' ');
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_/-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const _BACKENDS: Record<string, SandboxBackend> = {
  bwrap: new BwrapBackend(),
};

export function wrapCommand(
  sandbox: string,
  command: string,
  workspace: string,
  cwd: string,
  mediaDir?: string,
): string {
  const backend = _BACKENDS[sandbox];
  if (!backend) {
    throw new Error(
      `Unknown sandbox backend '${sandbox}'. Available: ${Object.keys(_BACKENDS).join(', ')}`,
    );
  }
  return backend.wrap(command, workspace, cwd, mediaDir);
}

export function getAvailableSandboxes(): string[] {
  return Object.keys(_BACKENDS);
}

export { SandboxBackend as default };
