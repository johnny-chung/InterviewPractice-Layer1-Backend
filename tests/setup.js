process.env.AUTH_DISABLED = 'true';
process.env.AZURE_SQL_SERVER = 'localhost';
process.env.AZURE_SQL_DATABASE = 'layer1';
process.env.AZURE_SQL_USER = 'sa';
process.env.AZURE_SQL_PASSWORD = 'Passw0rd!';
process.env.AZURE_SQL_ENCRYPT = 'false';
process.env.AZURE_SQL_TRUST_SERVER_CERT = 'true';

jest.mock('../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  bootstrapDatabase: jest.fn(),
  poolPromise: Promise.resolve({ request: () => ({ query: async () => ({ recordset: [] }) }) }),
  sql: {},
}));

jest.mock('../src/queues', () => {
  const queues = {
    parseResume: { add: jest.fn() },
    parseJob: { add: jest.fn() },
    computeMatch: { add: jest.fn() },
  };
  return { queues, startWorkers: jest.fn() };
});

jest.mock('../src/utils/storage', () => ({
  ensureStorageStructure: jest.fn(),
  getResumePath: jest.fn((id, ext) => `/tmp/${id}${ext}`),
  getJobPath: jest.fn((id, ext) => `/tmp/${id}${ext}`),
  getTempDir: jest.fn(() => '/tmp'),
}));

afterEach(() => {
  jest.clearAllMocks();
});
