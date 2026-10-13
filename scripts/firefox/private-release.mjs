#!/usr/bin/env node
/** Personal Firefox build overlay and resumable unlisted AMO signing. No runtime changes. */
import {readFile, writeFile, mkdir, cp, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {parseEnv, isDeepStrictEqual} from 'node:util';
import {homedir} from 'node:os';
import JSZip from 'jszip';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RUNNER = path.join(ROOT, 'scripts/testing/run-resource-safe.mjs');
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const API = 'https://addons.mozilla.org/api/v5/';
const REQUIRED = ['manifest.json', 'background.js', 'popup.html', 'options.html',
    'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js',
    'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm',
    'fluent-read-ocr/worker/worker.min.js', 'fluent-read-ai/wllama.wasm',
    'fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs',
    'fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
const git = (...args) => execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();

export function overlayManifest(original, config) {
    if (!/^\d+\.\d+\.\d+$/u.test(config.version)
        || config.version.split('.').some(part => Number(part) > 65535)) throw new Error('Invalid private version');
    if (original.manifest_version !== 2 || !original.browser_specific_settings?.gecko?.id) {
        throw new Error('Expected the upstream Firefox MV2 manifest');
    }
    const result = structuredClone(original);
    result.name = config.name;
    result.version = config.version;
    delete result.version_name;
    result.browser_specific_settings.gecko.id = config.id;
    return result;
}

export async function validateArchive(bytes, config, signed = false) {
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    for (const name of REQUIRED) if (!zip.file(name)) throw new Error(`Missing extension resource: ${name}`);
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    if (manifest.browser_specific_settings?.gecko?.id !== config.id
        || manifest.version !== config.version || manifest.name !== config.name
        || manifest.manifest_version !== 2) throw new Error('Private extension identity mismatch');
    if (manifest.permissions?.includes('offscreen') || manifest.key || manifest.oauth2) {
        throw new Error('Chrome-only manifest fields in Firefox package');
    }
    for (const name of REQUIRED.filter(name => name.endsWith('.wasm'))) {
        const binary = await zip.file(name).async('nodebuffer');
        if (!binary.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
            throw new Error(`Invalid WASM header: ${name}`);
        }
    }
    if (signed && !Object.keys(zip.files).some(name => /^META-INF\/(?:mozilla\.rsa|cose\.sig)$/iu.test(name))) {
        throw new Error('Mozilla signature files missing');
    }
    return zip;
}

export async function sanitizeSources(bytes, buildInfo) {
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    for (const name of Object.keys(zip.files)) {
        if (name.split('/').some(part => /^\.env(?:\.|$)/iu.test(part)
            || ['.git', '.output', '.wxt', 'node_modules', 'logs'].includes(part))
            || /\.(?:pem|xpi|crx|zip)$/iu.test(name)) zip.remove(name);
    }
    for (const name of ['package.json', 'pnpm-lock.yaml', 'wxt.config.ts',
        'scripts/firefox/private-release.mjs', 'scripts/firefox/release.config.json']) {
        if (!zip.file(name)) throw new Error(`Source ZIP is not reproducible: missing ${name}`);
    }
    zip.file('FIREFOX-PERSONAL-BUILD.json', JSON.stringify(buildInfo, null, 2) + '\n');
    zip.file('FIREFOX-PERSONAL-BUILD.md', [
        '# FluentRead Personal Firefox reproduction', '',
        'Node 24.14.0, pnpm 9.12.1, locked WXT 0.20.18.',
        'Private identity is applied to a staging copy; the upstream manifest stays intact.',
        'Windows extension-only setup (documentation image tools are not needed):',
        '```', 'npx --yes pnpm@9.12.1 install --frozen-lockfile --ignore-scripts',
        'node node_modules/esbuild/install.js',
        'npx --yes pnpm@9.12.1 exec wxt prepare',
        'npx --yes pnpm@9.12.1 firefox:package -- --reproduce', '```',
        'No AMO credentials are needed to reproduce the unsigned ZIP.',
        'FIREFOX-PERSONAL-BUILD.json records the exact source/upstream commits and private version.', '',
    ].join('\n'));
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}});
}

function run(command, args, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {cwd: ROOT, env, stdio: 'inherit', shell: false});
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve()
            : reject(new Error(`Command failed (${code ?? signal}): ${path.basename(command)}`)));
    });
}
const node = args => run(process.execPath, args);
const webExt = (config, args, env) => run(process.execPath,
    [NPM_CLI, 'exec', '--yes', `--package=web-ext@${config.webExtVersion}`, '--', 'web-ext', ...args], env);

async function check() {
    await node([RUNNER, '--', 'vitest', 'run', 'tests/resourceSafeRunner.test.ts',
        'tests/extensionManifestContract.test.ts', 'tests/wasmDiagnostics.test.ts', 'tests/firefoxPrivateRelease.test.ts']);
    await node([RUNNER, '--', 'vue-tsc', '--noEmit']);
}

async function packageRelease(config, reproduce = false) {
    let reproduction;
    if (reproduce) {
        reproduction = await json(path.join(ROOT, 'FIREFOX-PERSONAL-BUILD.json'));
        if (reproduction.id !== config.id || reproduction.version !== config.version) throw new Error('Reproduction identity mismatch');
    } else if (git('status', '--porcelain')) throw new Error('Commit source changes before packaging an identifiable release');
    const directory = path.join(ROOT, '.output/firefox-private', config.version);
    let existing;
    try {existing = await json(path.join(directory, 'release.json'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (existing && existing.state !== 'prepared') throw new Error('This version has a submission record; increment release.config.json');
    await node([RUNNER, '--', 'wxt', 'zip', '-b', 'firefox']);
    const upstreamPackage = await json(path.join(ROOT, 'package.json'));
    const sourceCommit = reproduction?.sourceCommit || git('rev-parse', 'HEAD');
    const upstreamCommit = reproduction?.upstreamCommit || git('merge-base', 'HEAD', 'upstream/main');
    const info = {id: config.id, name: config.name, version: config.version, upstreamVersion: upstreamPackage.version,
        sourceCommit, upstreamCommit, createdAt: new Date().toISOString()};
    const upstreamZip = await JSZip.loadAsync(await readFile(path.join(ROOT, '.output', `fluent-read-${upstreamPackage.version}-firefox.zip`)));
    const original = JSON.parse(await upstreamZip.file('manifest.json').async('string'));
    const privateManifest = overlayManifest(original, config);
    upstreamZip.file('manifest.json', JSON.stringify(privateManifest, null, 2) + '\n');
    const bytes = await upstreamZip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}});
    await validateArchive(bytes, config);
    await mkdir(directory, {recursive: true});
    // A fresh staging directory prevents old chunks surviving a rebuilt prepared version.
    const stagingName = `extension-${randomUUID()}`;
    const staging = path.join(directory, stagingName);
    await cp(path.join(ROOT, '.output/firefox-mv2'), staging, {recursive: true});
    await save(path.join(staging, 'manifest.json'), privateManifest);
    const extension = path.join(directory, `fluent-read-personal-${config.version}.zip`);
    const sources = path.join(directory, `fluent-read-personal-${config.version}-sources.zip`);
    await writeFile(extension, bytes);
    const sourceBytes = await sanitizeSources(await readFile(path.join(ROOT, '.output', `fluent-read-${upstreamPackage.version}-sources.zip`)), info);
    await writeFile(sources, sourceBytes);
    await save(path.join(directory, 'amo-metadata.json'), {
        summary: {'en-US': 'Personal Firefox build of FluentRead bilingual page translation.'}, categories: ['other'],
        version: {license: 'GPL-3.0-only', approval_notes: 'Build instructions and source commit are in FIREFOX-PERSONAL-BUILD.md/json in the source archive.'},
    });
    await webExt(config, ['lint', '--self-hosted', '--source-dir', staging, '--no-config-discovery', '--no-input']);
    await save(path.join(directory, 'release.json'), {...info, state: 'prepared',
        stagingName, extensionSha256: digest(bytes), sourceSha256: digest(sourceBytes)});
    console.log(`[firefox-private] Package ready: ${extension}`);
    console.log(`[firefox-private] Sources ready: ${sources}`);
}

export function createJwt(key, secret, now = Math.floor(Date.now() / 1000)) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg: 'HS256', typ: 'JWT'})}.${encode({iss: key, jti: randomUUID(), iat: now, exp: now + 60})}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

async function credentials() {
    let local = {};
    try {local = parseEnv(await readFile(path.join(ROOT, '.env.signing.local'), 'utf8'));}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    let shared = {};
    if (!(process.env.WEB_EXT_API_KEY || local.WEB_EXT_API_KEY)) {
        const sharedPath = process.env.FLUENTREAD_AMO_CREDENTIAL_FILE
            || path.join(homedir(), 'OneDrive/archive/settings/firefox/mozilla-api.json');
        try {shared = await json(sharedPath);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    const key = process.env.WEB_EXT_API_KEY || local.WEB_EXT_API_KEY || shared.issuer;
    const secret = process.env.WEB_EXT_API_SECRET || local.WEB_EXT_API_SECRET || shared.secret;
    if (!key || !secret) throw new Error('Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .env.signing.local');
    return {key, secret};
}

async function amoRequest(relative, auth) {
    const response = await fetch(new URL(relative, API), {headers: {Authorization: `JWT ${createJwt(auth.key, auth.secret)}`},
        signal: AbortSignal.timeout(30_000)});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`AMO request failed (${response.status}); check credentials/account`);
    return response.json();
}

export async function verifySignedPayload(bytes, originalBytes, config) {
    const signed = await validateArchive(bytes, config, true);
    const original = await JSZip.loadAsync(originalBytes, {checkCRC32: true});
    for (const [name, entry] of Object.entries(original.files)) {
        if (entry.dir) continue;
        // AMO rewrites manifest JSON formatting when signing; all field values must stay identical.
        if (name === 'manifest.json' && signed.file(name)
            && isDeepStrictEqual(JSON.parse(await entry.async('string')), JSON.parse(await signed.file(name).async('string')))) continue;
        if (!signed.file(name) || digest(await entry.async('nodebuffer')) !== digest(await signed.file(name).async('nodebuffer'))) {
            throw new Error(`Signed payload differs from submitted package: ${name}`);
        }
    }
    for (const entry of Object.values(signed.files)) {
        if (!entry.dir && !original.file(entry.name) && !entry.name.startsWith('META-INF/')) {
            throw new Error(`Unexpected file in signed package: ${entry.name}`);
        }
    }
}

export async function downloadSigned(version, directory, record, config, auth) {
    if (version?.file?.status !== 'public' || !version.file.url) return false;
    const url = new URL(version.file.url);
    if (url.protocol !== 'https:' || !/(?:^|\.)mozilla\.(?:org|net)$/u.test(url.hostname)) {
        throw new Error('Unexpected AMO download origin');
    }
    // Unlisted downloads require the owner's JWT, like web-ext's submit-addon client.
    // Restrict credentials to the exact AMO origin; fetch strips them on cross-origin redirects.
    const headers = url.origin === 'https://addons.mozilla.org'
        ? {Authorization: `JWT ${createJwt(auth.key, auth.secret)}`} : {};
    const response = await fetch(url, {headers, signal: AbortSignal.timeout(60_000)});
    if (!response.ok) throw new Error(`XPI download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (version.file.hash?.startsWith('sha256:') && digest(bytes) !== version.file.hash.slice(7)) throw new Error('AMO file hash mismatch');
    await verifySignedPayload(bytes, await readFile(path.join(directory, `fluent-read-personal-${config.version}.zip`)), config);
    const xpi = path.join(directory, `fluent-read-personal-${config.version}.xpi`);
    await writeFile(xpi, bytes);
    await save(path.join(directory, 'release.json'), {...record, state: 'signed', amoVersionId: version.id,
        signedAt: new Date().toISOString(), xpiSha256: digest(bytes)});
    console.log(`[firefox-private] Signed XPI: ${xpi}`);
    return true;
}

export async function signRelease(config, resumeOnly, ports = {}) {
    const getCredentials = ports.credentials || credentials;
    const request = ports.amoRequest || amoRequest;
    const submit = ports.webExt || webExt;
    const download = ports.downloadSigned || downloadSigned;
    const auth = await getCredentials();
    const directory = path.join(ports.root || ROOT, '.output/firefox-private', config.version);
    const recordPath = path.join(directory, 'release.json');
    let record = await json(recordPath);
    if (record.id !== config.id || record.version !== config.version) throw new Error('Release identity mismatch');
    const extensionPath = path.join(directory, `fluent-read-personal-${config.version}.zip`);
    const sourcePath = path.join(directory, `fluent-read-personal-${config.version}-sources.zip`);
    if (digest(await readFile(extensionPath)) !== record.extensionSha256
        || digest(await readFile(sourcePath)) !== record.sourceSha256) throw new Error('Release files changed after packaging');
    const stage = path.join(directory, record.stagingName);
    const packageZip = await validateArchive(await readFile(extensionPath), config);
    const stageFiles = await readdir(stage, {recursive: true, withFileTypes: true});
    const stageNames = stageFiles.filter(entry => entry.isFile()).map(entry =>
        path.relative(stage, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        // web-ext writes this cache after upload; it is not an extension payload file.
        .filter(name => name !== '.amo-upload-uuid');
    const zipNames = Object.values(packageZip.files).filter(entry => !entry.dir).map(entry => entry.name);
    if (stageNames.sort().join('\n') !== zipNames.sort().join('\n')) throw new Error('Staging files differ from package');
    for (const name of zipNames) {
        if (digest(await readFile(path.join(stage, name))) !== digest(await packageZip.file(name).async('nodebuffer'))) {
            throw new Error(`Staging content changed: ${name}`);
        }
    }
    const route = `addons/addon/${encodeURIComponent(config.id)}/versions/${config.version}/`;
    const existing = await request(route, auth);
    if (existing) {
        if (existing.channel !== 'unlisted') throw new Error('Existing AMO version is not unlisted');
        if (await download(existing, directory, record, config, auth)) return;
        await save(recordPath, {...record, state: 'pending', amoVersionId: existing.id});
        console.log(`[firefox-private] AMO status: ${existing.file?.status}; run firefox:sign -- --resume later.`);
        return;
    }
    if (resumeOnly || record.state !== 'prepared') {
        throw new Error('Submission not visible yet. No duplicate upload was made. Inspect AMO and resume this version.');
    }
    const history = await request(`addons/addon/${encodeURIComponent(config.id)}/versions/?filter=all_with_unlisted`, auth);
    if (history?.results?.some(version => compareVersions(version.version, config.version) >= 0)) {
        throw new Error('Private version must be higher than existing AMO versions');
    }
    record = {...record, state: 'submitting', submittedAt: new Date().toISOString()};
    await save(recordPath, record);
    // Submit only once. A timeout/failure leaves a durable reservation for status-only resume.
    let failure;
    try {
        await submit(config, ['sign', '--channel', 'unlisted', '--amo-base-url', API, '--source-dir', stage,
            '--artifacts-dir', path.join(directory, 'amo-download'), '--upload-source-code', sourcePath,
            '--amo-metadata', path.join(directory, 'amo-metadata.json'), '--approval-timeout', '60000',
            '--no-config-discovery', '--no-input'], {...process.env, WEB_EXT_API_KEY: auth.key, WEB_EXT_API_SECRET: auth.secret});
    } catch (error) {failure = error;}
    record = {...record, state: 'pending'};
    await save(recordPath, record);
    const submitted = await request(route, auth);
    if (submitted && await download(submitted, directory, record, config, auth)) return;
    if (submitted) await save(recordPath, {...record, amoVersionId: submitted.id, amoStatus: submitted.file?.status});
    console.log('[firefox-private] Submission reserved. Resume with firefox:sign -- --resume; do not repackage this version.');
    if (failure) throw failure;
}

export function compareVersions(left, right) {
    const a = left.split('.').map(Number), b = right.split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] || 0) - (b[index] || 0);
        if (difference) return difference;
    }
    return 0;
}

async function main() {
    const config = await json(path.join(ROOT, 'scripts/firefox/release.config.json'));
    const [command, ...flags] = process.argv.slice(2);
    if (command === 'check') return check();
    if (command === 'package') return packageRelease(config, flags.includes('--reproduce'));
    if (command === 'sign') return signRelease(config, flags.includes('--resume'));
    throw new Error('Usage: private-release.mjs check|package|sign [--resume]');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {console.error(`[firefox-private] ${error.message}`); process.exitCode = 1;});
}
