'use strict';

jest.mock('fs');
jest.mock('@azure/storage-blob', () => ({
  StorageSharedKeyCredential: jest.fn().mockImplementation((account, key) => ({ account, key })),
  generateBlobSASQueryParameters: jest.fn(() => ({ toString: () => 'sig=fake&se=fake' })),
  BlobSASPermissions: { parse: jest.fn((s) => s) },
}));

// Re-requer 'fs' AQUI DENTRO (não uma referência capturada 1x no topo do
// arquivo) porque jest.resetModules() no beforeEach troca de "geração" o
// registro de módulos — inclusive o automock de módulos core como 'fs' — a
// cada reset. Uma referência de 'fs' obtida antes do reset fica órfã; quem
// precisa configurar o mock que o blobSas.js (recém exigido após o reset)
// vai realmente usar tem que pedir 'fs' de novo, na mesma geração.
function mockConfig(cfg) {
  const fs = require('fs');
  fs.readFileSync.mockReturnValue(JSON.stringify(cfg));
}

describe('blobSas.generateFileTransferUrls', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('lança erro claro se blobStorage não está configurado', () => {
    mockConfig({});
    const { generateFileTransferUrls } = require('./blobSas');
    expect(() => generateFileTransferUrls({ fileName: 'a.txt', fileSize: 100 }))
      .toThrow(/blobStorage não configurado/);
  });

  it('recusa arquivo acima de 2GB', () => {
    mockConfig({ blobStorage: { accountName: 'acc', accountKey: 'key', container: 'live-transfer' } });
    const { generateFileTransferUrls } = require('./blobSas');
    const TWO_GB_PLUS_1 = 2 * 1024 * 1024 * 1024 + 1;
    expect(() => generateFileTransferUrls({ fileName: 'a.txt', fileSize: TWO_GB_PLUS_1 }))
      .toThrow(/2GB/);
  });

  it('retorna uploadUrl e downloadUrl pro mesmo blob, dentro do limite', () => {
    mockConfig({ blobStorage: { accountName: 'acc', accountKey: 'key', container: 'live-transfer' } });
    const { generateFileTransferUrls } = require('./blobSas');
    const result = generateFileTransferUrls({ fileName: 'instalador.exe', fileSize: 1024 });
    expect(result.uploadUrl).toContain('acc.blob.core.windows.net');
    expect(result.uploadUrl).toContain('live-transfer');
    expect(result.downloadUrl).toContain('acc.blob.core.windows.net');
    expect(result.blobName).toMatch(/instalador\.exe$/);
    // uploadUrl e downloadUrl apontam pro MESMO blob
    const uploadPath = new URL(result.uploadUrl).pathname;
    const downloadPath = new URL(result.downloadUrl).pathname;
    expect(uploadPath).toBe(downloadPath);
  });
});
