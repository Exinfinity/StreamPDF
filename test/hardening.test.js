import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function read(relativePath) {
  return readFile(path.resolve(relativePath), 'utf8');
}

async function exists(relativePath) {
  try {
    await stat(path.resolve(relativePath));
    return true;
  } catch {
    return false;
  }
}

test('frontend outline links allow only safe schemes and reject credentials (P2-2)', async () => {
  const source = await read('public/js/app.js');
  assert.match(source, /\[\s*'http:',\s*'https:',\s*'mailto:'\s*\]/);
  assert.match(source, /url\.username \|\| url\.password/);
  assert.match(source, /window\.open\(target, '_blank', 'noopener,noreferrer'\)/);
  assert.doesNotMatch(source, /window\.open\(\s*item\.url/);
});

test('.gitignore excludes local secrets and generated files (P3)', async () => {
  const source = await read('.gitignore');
  for (const entry of ['.env', '*.pem', '*.key', '.auth-token', 'node_modules/']) {
    assert.ok(source.includes(entry), `missing ${entry}`);
  }
});

test('SECURITY.md documents the threat model and reporting process (P3)', async () => {
  assert.equal(await exists('SECURITY.md'), true);
  const source = await read('SECURITY.md');
  assert.match(source, /威胁模型/);
  assert.match(source, /漏洞上报/);
  assert.match(source, /ALLOWED_HOSTS/);
  assert.match(source, /AUTH_TOKEN/);
});

test('CI runs tests, production dependency audit and dependency review (P3)', async () => {
  assert.equal(await exists('.github/workflows/security.yml'), true);
  const workflow = await read('.github/workflows/security.yml');
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm audit --omit=dev/);
  assert.match(workflow, /dependency-review-action/);
  assert.match(workflow, /permissions:/);
  assert.match(workflow, /contents: read/);

  assert.equal(await exists('.github/dependabot.yml'), true);
  const dependabot = await read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
});

test('deployment templates apply host, container and proxy hardening (P3)', async () => {
  const systemd = await read('deploy/streampdf.service');
  for (const directive of [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'CapabilityBoundingSet=',
    'RestrictAddressFamilies=AF_INET AF_INET6',
    'MemoryMax=',
    'TasksMax=',
    'LimitNOFILE=',
  ]) {
    assert.ok(systemd.includes(directive), `systemd missing ${directive}`);
  }

  const nginx = await read('deploy/nginx.conf');
  assert.match(nginx, /limit_req/);
  assert.match(nginx, /limit_conn/);
  assert.match(nginx, /client_max_body_size/);
  assert.match(nginx, /proxy_set_header Host \$host/);
  assert.match(nginx, /Strict-Transport-Security/);
  assert.match(nginx, /upstream streampdf_upstream/);
  // A site-level drop-in is installed into a vhost include directory, so it
  // documents the conf.d destination instead of re-including that directory.
  assert.match(nginx, /\/etc\/nginx\/conf\.d\/streampdf\.conf/);

  // deploy/nginx.conf must be a site-level drop-in that can live next to other
  // vhosts, never a replacement for the host's /etc/nginx/nginx.conf.
  const nginxDirectives = nginx.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(nginxDirectives, /^\s*worker_processes\b/m);
  assert.doesNotMatch(nginxDirectives, /^\s*events\s*\{/m);
  assert.doesNotMatch(nginxDirectives, /^\s*http\s*\{/m);

  // The port 80 redirect is optional and shipped separately.
  const redirect = await read('deploy/nginx-http-redirect.conf');
  assert.match(redirect, /listen 80;/);
  assert.match(redirect, /return 301 https:\/\/\$host\$request_uri;/);

  const dockerfile = await read('deploy/Dockerfile');
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /HEALTHCHECK/);

  const compose = await read('deploy/docker-compose.yml');
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /AUTH_TOKEN/);
  assert.match(compose, /ALLOWED_HOSTS/);
});

test('server code no longer writes raw errors or tokens to stdout (P3)', async () => {
  for (const file of [
    'server/app.js',
    'server/index.js',
    'server/host.js',
    'server/sources.js',
    'server/http-client.js',
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /console\.error\(\s*['"][^'"]*['"]\s*,\s*error\s*\)/, file);
    assert.doesNotMatch(source, /console\.log\(\s*authToken\s*\)/, file);
  }

  const packageJson = JSON.parse(await read('package.json'));
  assert.ok(packageJson.engines.node.includes('22.13'));
  assert.ok(packageJson.scripts.test.includes('node --test'));
});

test('dependency lockfile is committed for reproducible installs (P3)', async () => {
  assert.equal(await exists('package-lock.json'), true);
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(lock.lockfileVersion >= 3, true);
});
