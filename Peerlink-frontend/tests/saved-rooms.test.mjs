import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const source = await readFile(new URL('../src/utils/savedRooms.ts', import.meta.url), 'utf8');
const runtime = {};
vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replaceAll('export type', 'type').replaceAll('export function', 'function')) + '\nglobalThis.collect = collectSavedRooms;', runtime);
const saved = { fileId: 'copy', roomId: 'studio', roomType: 'persistent', name: 'image.webp', size: 100, mimeType: 'image/webp', status: 'complete', totalChunks: 1, receivedChunks: 1, createdAt: 10 };

test('history comes only from completed local persistent receives', () => {
    const excluded = [{ status: 'paused' }, { status: 'receiving' }, { receivedChunks: 0 }, { roomType: 'temporary' }, { mimeType: 'send_state' }, { remoteFileId: 'q-remote' }, { roomId: '' }];
    const result = runtime.collect([saved, ...excluded.map((change, i) => ({ ...saved, fileId: `excluded-${i}`, roomId: `hidden-${i}`, ...change }))]);
    assert.equal(result.length, 1);
    assert.equal(result[0].roomId, 'studio');
    assert.equal(result[0].files.length, 1);
});

test('groups received files and orders rooms and files by transfer completion, never visits', () => {
    const result = runtime.collect([saved, { ...saved, fileId: 'new', completedAt: 30, size: 200 }, { ...saved, roomId: 'other', createdAt: 20 }]);
    assert.equal(result[0].roomId, 'studio');
    assert.equal(result[0].totalSize, 300);
    assert.equal(result[0].files[0].fileId, 'new');
    assert.equal(result[0].lastReceivedAt, 30);
    assert.equal(result[1].roomId, 'other');
});

test('older saved copies without room type or completion time remain discoverable', () => {
    const result = runtime.collect([{ ...saved, roomType: undefined }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].lastReceivedAt, 10);
});

test('a room disappears after its final received copy is removed', () => {
    assert.equal(runtime.collect([saved]).length, 1);
    assert.equal(runtime.collect([]).length, 0);
});
