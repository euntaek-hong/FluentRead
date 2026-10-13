import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, createHmac} from 'node:crypto';
import JSZip from 'jszip';

const moduleUrl = pathToFileURL(resolve('scripts/firefox/private-release.mjs')).href;
const {overlayManifest, validateArchive, sanitizeSources, verifySignedPayload, createJwt, signRelease} =
    await import(/* @vite-ignore */ moduleUrl);
const config = {id: 'fluent-read@euntaek-hong', name: 'FluentRead Personal', version: '1.0.1', webExtVersion: '10.7.0'};
const original = {manifest_version: 2, name: '__MSG_extensionName__', version: '0.0.37', permissions: ['storage'],
    browser_specific_settings: {gecko: {id: 'upstream', strict_min_version: '140.0',
        data_collection_permissions: {required: ['websiteContent']}}}};
const temporary: string[] = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(overlayManifest(original, config)));
    for (const name of ['background.js', 'popup.html', 'options.html',
        'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js', 'fluent-read-ocr/worker/worker.min.js',
        'fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs']) zip.file(name, 'original executable content');
    for (const name of ['fluent-read-ocr/core/tesseract-core-simd-lstm.wasm', 'fluent-read-ai/wllama.wasm',
        'fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm']) zip.file(name, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    return zip;
}

afterEach(async () => {await Promise.all(temporary.splice(0).map(root => rm(root, {recursive: true, force: true})));});

describe('personal Firefox release', () => {
    it('私有 ID/version 只应用到副本，保留权限和 Firefox 数据声明', () => {
        const before = structuredClone(original);
        const result = overlayManifest(original, config);
        expect(original).toEqual(before);
        expect(result.browser_specific_settings.gecko.id).toBe(config.id);
        expect(result.browser_specific_settings.gecko.data_collection_permissions).toEqual(before.browser_specific_settings.gecko.data_collection_permissions);
        expect(result.permissions).toEqual(before.permissions);
        expect(result.version).toBe('1.0.1');
        expect(() => overlayManifest(original, {...config, version: '1.0.65536'})).toThrow('version');
    });

    it('缺少 OCR/WASM、错误 ID 或没有签名都拒绝交付', async () => {
        const zip = await fixture();
        const bytes = await zip.generateAsync({type: 'nodebuffer'});
        await expect(validateArchive(bytes, config)).resolves.toBeDefined();
        await expect(validateArchive(bytes, {...config, id: 'other'})).rejects.toThrow('identity');
        await expect(validateArchive(bytes, config, true)).rejects.toThrow('signature');
        zip.remove('fluent-read-ocr/worker/worker.min.js');
        await expect(validateArchive(await zip.generateAsync({type: 'nodebuffer'}), config)).rejects.toThrow('resource');
    });

    it('签名返回包必须保留提交包中的每个文件和字节', async () => {
        const zip = await fixture();
        const submitted = await zip.generateAsync({type: 'nodebuffer'});
        zip.file('META-INF/cose.sig', 'fixture signature, not cryptographic verification');
        await expect(verifySignedPayload(await zip.generateAsync({type: 'nodebuffer'}), submitted, config)).resolves.toBeUndefined();
        zip.file('background.js', 'unexpected changed code');
        await expect(verifySignedPayload(await zip.generateAsync({type: 'nodebuffer'}), submitted, config)).rejects.toThrow('background.js');
    });

    it('源码归档移除凭据和产物，并保留复现所需的锁文件及构建脚本', async () => {
        const zip = new JSZip();
        for (const name of ['package.json', 'pnpm-lock.yaml', 'wxt.config.ts',
            'scripts/firefox/private-release.mjs', 'scripts/firefox/release.config.json']) zip.file(name, '{}');
        for (const name of ['.env.signing.local', 'nested/.env', 'key.pem', '.git/config', '.output/signed.xpi']) zip.file(name, 'private fixture');
        const cleaned = await JSZip.loadAsync(await sanitizeSources(await zip.generateAsync({type: 'nodebuffer'}), {sourceCommit: 'fixture'}));
        expect(Object.keys(cleaned.files).some(name => /\.env|\.pem|\.xpi|\.git\//u.test(name))).toBe(false);
        expect(await cleaned.file('FIREFOX-PERSONAL-BUILD.json')!.async('string')).toContain('fixture');
        expect(await cleaned.file('FIREFOX-PERSONAL-BUILD.md')!.async('string')).toContain('firefox:package');
    });

    it('AMO JWT 使用 60 秒寿命、唯一 nonce 和 HS256', () => {
        const token = createJwt('fixture-issuer', 'fixture-secret', 12345);
        const [header, payload, signature] = token.split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('HS256');
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({iss: 'fixture-issuer', iat: 12345, exp: 12405});
        expect(signature).toBe(createHmac('sha256', 'fixture-secret').update(`${header}.${payload}`).digest('base64url'));
        expect(createJwt('fixture-issuer', 'fixture-secret', 12345)).not.toBe(token);
    });

    it('提交超时后重复调用只查询既有版本，不会再次上传', async () => {
        const root = await mkdtemp(join(tmpdir(), 'fluentread-private-sign-'));
        temporary.push(root);
        const directory = join(root, '.output/firefox-private/1.0.1');
        const stage = join(directory, 'extension-fixture');
        await mkdir(stage, {recursive: true});
        const zip = await fixture();
        for (const entry of Object.values(zip.files)) {
            if (entry.dir) continue;
            const target = join(stage, entry.name);
            await mkdir(dirname(target), {recursive: true});
            await writeFile(target, await entry.async('nodebuffer'));
        }
        const bytes = await zip.generateAsync({type: 'nodebuffer'});
        const sources = Buffer.from('source archive fixture');
        await writeFile(join(directory, 'fluent-read-personal-1.0.1.zip'), bytes);
        await writeFile(join(directory, 'fluent-read-personal-1.0.1-sources.zip'), sources);
        const recordFile = join(directory, 'release.json');
        await writeFile(recordFile, JSON.stringify({...config, stagingName: 'extension-fixture', state: 'prepared',
            extensionSha256: sha256(bytes), sourceSha256: sha256(sources)}));
        const submit = vi.fn().mockRejectedValue(new Error('approval timeout fixture'));
        const ports = {root, credentials: async () => ({key: 'fixture', secret: 'fixture'}), amoRequest: async () => null, webExt: submit};
        await expect(signRelease(config, false, ports)).rejects.toThrow('approval timeout');
        expect(submit).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await readFile(recordFile, 'utf8')).state).toBe('pending');
        await expect(signRelease(config, false, ports)).rejects.toThrow('No duplicate upload');
        expect(submit).toHaveBeenCalledTimes(1);
        const pendingPorts = {...ports, amoRequest: async () => ({id: 7, channel: 'unlisted', file: {status: 'unreviewed'}}), downloadSigned: async () => false};
        await expect(signRelease(config, true, pendingPorts)).resolves.toBeUndefined();
        expect(submit).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await readFile(recordFile, 'utf8')).amoVersionId).toBe(7);
    });
});
