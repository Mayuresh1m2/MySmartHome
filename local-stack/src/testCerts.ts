import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const caScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'local-ca.sh');

export interface TestPki {
  dir: string;
  caFile: string;
  serverCert: string;
  serverKey: string;
  /** Issues a throwaway client key+cert for the given CN. Test-only; never the real hub key. */
  client(cn: string): { keyFile: string; certFile: string };
  cleanup(): void;
}

/** Builds a throwaway PKI in a temp dir using the same local-ca.sh the stack uses. */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-pki-'));
  const env = { ...process.env, LOCAL_STACK_STATE: dir };
  execFileSync('bash', [caScript, 'init'], { env, stdio: 'pipe' });
  return {
    dir,
    caFile: join(dir, 'ca', 'ca.crt'),
    serverCert: join(dir, 'ca', 'server.crt'),
    serverKey: join(dir, 'ca', 'server.key'),
    client(cn) {
      const keyFile = join(dir, `${cn}.key`);
      const csr = join(dir, `${cn}.csr`);
      const certFile = join(dir, `${cn}.crt`);
      execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile], { stdio: 'pipe' });
      execFileSync('openssl', ['req', '-new', '-key', keyFile, '-subj', `/CN=${cn}`, '-out', csr], { stdio: 'pipe' });
      execFileSync('bash', [caScript, 'sign', csr, certFile], { env, stdio: 'pipe' });
      return { keyFile, certFile };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
