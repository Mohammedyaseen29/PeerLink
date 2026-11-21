import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const source = await readFile(new URL('../src/utils/receivedFiles.ts', import.meta.url), 'utf8');
const runtime = {};
vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function')) + '\nglobalThis.filter = filesOnlyOnPeer;', runtime);
const local = { fileId: 'local', sourcePeerId: 'sender', sourceFileId: 'transfer', name: 'same.webp', size: 100, status: 'complete', totalChunks: 1, receivedChunks: 1 };
const remote = { ...local, fileId: 'alias', remoteFileId: 'q-transfer' };
test('an exact received transfer is listed once, using its local copy', () => assert.equal(runtime.filter([local], [remote]).length, 0));
test('same names and sizes do not collapse different transfers or sources', () => {
    for (const changed of [{ remoteFileId: 'q-other' }, { sourcePeerId: 'other' }, { path: 'another-folder/same.webp' }]) assert.equal(runtime.filter([local], [{ ...remote, ...changed }]).length, 1);
});
test('incomplete and older uncorrelated copies never hide a peer file', () => {
    for (const changed of [{ status: 'receiving' }, { receivedChunks: 0 }, { sourceFileId: undefined }]) assert.equal(runtime.filter([{ ...local, ...changed }], [remote]).length, 1);
});
